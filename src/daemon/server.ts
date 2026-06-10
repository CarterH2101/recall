import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { getDb } from "../lib/db.js";
import { warmup } from "../lib/embed.js";
import { ingest } from "../lib/ingest.js";
import { recall, recentSessions, type Snippet } from "../lib/recall.js";
import { getOrCreateToken } from "../lib/token.js";

const PORT = Number(process.env.RECALL_PORT || 4319);
// Default: localhost only. Set RECALL_BIND=0.0.0.0 to allow LAN/Tailscale
// clients (e.g. the Siri shortcut) — those requests must present the token.
const HOST = process.env.RECALL_BIND || "127.0.0.1";

const ASK_MIN_SCORE = Number(process.env.RECALL_ASK_MIN_SCORE ?? "0.45");
const ASK_MAX_CHARS = 600;

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function isLocal(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function authorized(req: IncomingMessage, token: string): boolean {
  if (isLocal(req)) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${token}`;
}

/** Compose a short, voice-friendly answer from recall snippets. No markdown. */
function voiceAnswer(snippets: Snippet[]): string {
  if (!snippets.length) {
    return "I couldn't find anything about that in your past sessions.";
  }
  const parts: string[] = [];
  let used = 0;
  for (const s of snippets) {
    const when = s.ts ? new Date(s.ts).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : "an earlier session";
    const where = s.project ? ` in ${s.project}` : "";
    const text = s.content.replace(/[#*`_>|-]+/g, " ").replace(/\s+/g, " ").trim();
    const piece = `From ${when}${where}: ${text}`;
    const room = ASK_MAX_CHARS - parts.join(" ").length;
    if (room <= 80) break;
    parts.push(piece.slice(0, Math.min(piece.length, room)));
    used++;
    if (used >= 2) break;
  }
  return parts.join(" ... ");
}

function makeHandler(token: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!authorized(req, token)) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/ingest") {
        const b = await readBody(req);
        if (!b.transcriptPath) return json(res, 400, { error: "transcriptPath required" });
        return json(res, 200, await ingest(b.transcriptPath));
      }
      if (req.method === "POST" && req.url === "/recall") {
        const b = await readBody(req);
        if (!b.query) return json(res, 400, { error: "query required" });
        const snippets = await recall(b.query, {
          excludeSessionId: b.excludeSessionId,
          project: b.project,
          limit: b.limit,
          minScore: b.minScore,
        });
        return json(res, 200, { snippets });
      }
      // Voice-friendly Q&A for the Siri shortcut: returns plain spoken text.
      if (req.method === "POST" && req.url === "/ask") {
        const b = await readBody(req);
        const q = b.q ?? b.query;
        if (!q) return json(res, 400, { error: "q required" });
        const snippets = await recall(String(q), { limit: 4, minScore: ASK_MIN_SCORE });
        const answer = voiceAnswer(snippets);
        return json(res, 200, {
          answer,
          sources: snippets.slice(0, 2).map((s) => ({
            project: s.project,
            ts: s.ts,
            score: Number(s.score.toFixed(2)),
          })),
        });
      }
      if (req.method === "GET" && req.url?.startsWith("/recent")) {
        return json(res, 200, { sessions: recentSessions() });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  };
}

async function main(): Promise<void> {
  getDb();
  const token = getOrCreateToken();
  console.error("[recalld] warming embedding model...");
  await warmup();
  console.error("[recalld] model ready");

  // Always serve localhost (local hooks + MCP). If RECALL_BIND names another
  // address (e.g. a Tailscale IP for phone access), serve that too — without
  // exposing on the LAN. De-dupe so RECALL_BIND=127.0.0.1 doesn't double-bind.
  const handler = makeHandler(token);
  const hosts = Array.from(new Set(["127.0.0.1", HOST]));
  for (const host of hosts) {
    const primary = host === "127.0.0.1";
    const server = http.createServer(handler);
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (primary) {
        if (err.code === "EADDRINUSE") process.exit(0); // another daemon owns localhost
        console.error(`[recalld] fatal on ${host}:`, err.message);
        process.exit(1);
      } else {
        // Secondary bind (e.g. a Tailscale IP) is best-effort: if it's
        // unavailable (Tailscale down at boot), keep serving localhost.
        console.error(`[recalld] could not bind ${host} (${err.code}); serving localhost only`);
      }
    });
    server.listen(PORT, host, () => {
      console.error(`[recalld] listening on http://${host}:${PORT}`);
      if (!primary) {
        console.error("[recalld] non-localhost bind: remote requests require the Bearer token");
      }
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
