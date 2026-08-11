import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { getDb } from "../lib/db.js";
import { warmup } from "../lib/embed.js";
import { ingest } from "../lib/ingest.js";
import { recall, recentSessions, type Snippet } from "../lib/recall.js";
import { getOrCreateToken } from "../lib/token.js";
import { getAdapter } from "../lib/sources/registry.js";
import { startWatchers } from "./watcher.js";
import { handleUiRoute } from "./ui-routes.js";
import { SERVICE, VERSION } from "../lib/version.js";
import {
  writeDaemonInfo,
  clearDaemonInfo,
  identify,
  requestShutdown,
} from "./lifecycle.js";

const BASE_PORT = Number(process.env.RECALL_PORT || 4319);
const PORT_TRIES = 10;
// Default: localhost only. Set RECALL_BIND=0.0.0.0 to allow LAN/Tailscale
// clients — those requests must present the token.
const HOST = process.env.RECALL_BIND || "127.0.0.1";

const ASK_MIN_SCORE = Number(process.env.RECALL_ASK_MIN_SCORE ?? "0.45");
const ASK_MAX_CHARS = 600;
const STARTED_AT = new Date().toISOString();

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

const DEBUG = process.env.RECALL_DEBUG === "1";

// What recall actually surfaced, per query — feeds the eval-labeling loop and
// the viewer's activity feed. Zero-result calls are logged too (miss rate is
// a metric). Never allowed to fail a recall.
function logInjection(source: string, req: any, snippets: Snippet[]): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO injections (ts, source, query, session_id, project, min_score, results, n_injected, top_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        source,
        String(req.query).slice(0, 2000),
        req.excludeSessionId ?? null,
        req.project ?? null,
        req.minScore ?? null,
        JSON.stringify(
          snippets.map((s) => ({
            id: s.kind === "fact" ? s.factId : s.turnId,
            kind: s.kind ?? "turn",
            score: Number(s.score.toFixed(4)),
          })),
        ),
        snippets.length,
        snippets.length ? Number(snippets[0].score.toFixed(4)) : null,
      );
  } catch {
    /* logging must never break recall */
  }
}

function sweepInjections(): void {
  try {
    getDb().exec(
      `DELETE FROM injections WHERE id < (SELECT COALESCE(MAX(id), 0) FROM injections) - 20000`,
    );
  } catch {
    /* table may not exist mid-migration */
  }
}

function healthPayload(port: number) {
  return {
    ok: true,
    service: SERVICE,
    version: VERSION,
    pid: process.pid,
    port,
    startedAt: STARTED_AT,
  };
}

function makeHandler(token: string, port: number) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (DEBUG) {
        const ct = req.headers["content-type"] || "";
        console.error(
          `[req] ${req.socket.remoteAddress} ${req.method} ${req.url} auth=${req.headers.authorization ? "yes" : "no"} ct=${ct}`,
        );
      }
      if (!authorized(req, token)) {
        return json(res, 401, { error: "unauthorized" });
      }
      // Admin UI + its API: localhost-only regardless of token.
      if (await handleUiRoute(req, res, isLocal(req))) return;
      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, healthPayload(port));
      }
      if (req.method === "POST" && req.url === "/shutdown") {
        // Localhost only, even with a valid token: shutdown is an admin
        // action for same-machine upgrades, not a remote capability.
        if (!isLocal(req)) return json(res, 403, { error: "localhost only" });
        json(res, 200, { ok: true, stopping: true });
        console.error("[recalld] shutdown requested");
        setTimeout(() => process.exit(0), 150).unref();
        return;
      }
      if (req.method === "POST" && req.url === "/ingest") {
        const b = await readBody(req);
        if (!b.transcriptPath) return json(res, 400, { error: "transcriptPath required" });
        const adapter = getAdapter(b.source ?? "claude-code");
        if (!adapter) return json(res, 400, { error: `unknown source: ${b.source}` });
        return json(res, 200, await ingest(b.transcriptPath, adapter));
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
        logInjection(b.source ?? "mcp", b, snippets);
        return json(res, 200, { snippets });
      }
      // Short plain-text Q&A endpoint. Accepts POST {q} OR GET /ask?q=... —
      // GET exists because some HTTP clients drop POST bodies over HTTP/2.
      if (req.url === "/ask" || req.url?.startsWith("/ask?")) {
        let q: string | undefined;
        if (req.method === "POST") {
          const b = await readBody(req);
          q = b.q ?? b.query;
        } else if (req.method === "GET") {
          const u = new URL(req.url, "http://localhost");
          q = u.searchParams.get("q") ?? u.searchParams.get("query") ?? undefined;
        }
        if (!q) return json(res, 400, { error: "q required" });
        const snippets = await recall(String(q), { limit: 4, minScore: ASK_MIN_SCORE });
        logInjection("ask", { query: String(q), minScore: ASK_MIN_SCORE }, snippets);
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

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bind localhost, negotiating with whatever already holds the port:
 * - a same-version recalld → we're redundant, exit quietly
 * - an older recalld → ask it to shut down and take the port
 * - a foreign process → advance to the next port (advertised via daemon.json)
 */
async function acquirePort(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  for (let port = BASE_PORT; port < BASE_PORT + PORT_TRIES; port++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const server = http.createServer(handler);
      try {
        await listen(server, port, "127.0.0.1");
        return { server, port };
      } catch (err) {
        server.close();
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        const info = await identify(port);
        if (!info) {
          // Foreign process. Loudly note it and try the next port.
          console.error(`[recalld] port ${port} is held by another program; trying ${port + 1}`);
          break;
        }
        if (info.version === VERSION) {
          console.error(`[recalld] v${VERSION} already running on port ${port} (pid ${info.pid})`);
          process.exit(0);
        }
        console.error(
          `[recalld] replacing v${info.version} daemon on port ${port} with v${VERSION}`,
        );
        await requestShutdown(port);
        await sleep(500);
        // second attempt on the same port
      }
    }
  }
  throw new Error(`no free port in ${BASE_PORT}-${BASE_PORT + PORT_TRIES - 1}`);
}

export async function startDaemon(): Promise<void> {
  getDb();
  sweepInjections();
  const token = getOrCreateToken();

  // Bind before the model warms so identity/handshake are answerable
  // immediately; /recall /ingest just take a beat longer on first use.
  let boundPort = BASE_PORT;
  const handler: http.RequestListener = (req, res) =>
    (makeHandler(token, boundPort) as any)(req, res);
  const { port } = await acquirePort(handler);
  boundPort = port;
  console.error(`[recalld] listening on http://127.0.0.1:${port}`);

  writeDaemonInfo({ service: SERVICE, version: VERSION, pid: process.pid, port, startedAt: STARTED_AT });
  const cleanup = () => clearDaemonInfo();
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  // Optional extra bind (e.g. a Tailscale IP for phone access) — best-effort:
  // if it's unavailable (Tailscale down at boot), keep serving localhost.
  if (HOST !== "127.0.0.1") {
    const extra = http.createServer(handler);
    extra.on("error", (err: NodeJS.ErrnoException) => {
      console.error(`[recalld] could not bind ${HOST} (${err.code}); serving localhost only`);
    });
    extra.listen(port, HOST, () => {
      console.error(`[recalld] also listening on http://${HOST}:${port} (token required)`);
    });
  }

  console.error("[recalld] warming embedding model...");
  await warmup();
  console.error("[recalld] model ready");

  // Watch push-less sources (Codex rollouts). After warmup so the catch-up
  // sweep doesn't race the model download.
  startWatchers();

  // Team sync heartbeat, only when configured. Best-effort: a down hub never
  // affects local operation.
  const { loadSyncConfig, push, pull } = await import("../lib/sync.js");
  if (loadSyncConfig()) {
    const beat = async () => {
      try {
        const cfg = loadSyncConfig();
        if (!cfg) return;
        await push(cfg);
        await pull(cfg);
      } catch (e) {
        console.error(`[sync] heartbeat failed: ${(e as Error).message}`);
      }
    };
    setInterval(beat, 5 * 60_000).unref();
    void beat();
  }
}

startDaemon().catch((e) => {
  console.error(e);
  process.exit(1);
});
