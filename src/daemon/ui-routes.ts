import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../lib/db.js";
import { dbPath } from "../lib/paths.js";
import {
  addFact,
  deleteFact,
  editFact,
  listFacts,
  setArchived,
  setPinned,
  type FactKind,
} from "../lib/facts.js";

// Local admin UI. Everything here — including reads — is LOCALHOST ONLY,
// even with a valid bearer token: the token exists for the remote /ask path,
// not remote administration.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const VALID_KINDS = new Set(["decision", "gotcha", "preference", "reference"]);

/** Returns true when the request was handled. */
export async function handleUiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  isLocal: boolean,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (p !== "/ui" && !p.startsWith("/api/")) return false;

  if (!isLocal) {
    json(res, 403, { error: "localhost only" });
    return true;
  }

  const db = getDb();

  if (req.method === "GET" && p === "/ui") {
    const file = path.join(__dirname, "..", "ui", "index.html");
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(file));
    } catch {
      json(res, 500, { error: "ui asset missing — rebuild (npm run build)" });
    }
    return true;
  }

  if (req.method === "GET" && p === "/api/stats") {
    const one = (sql: string) => (db.prepare(sql).get() as any)?.n ?? 0;
    const turnsPerDay = db
      .prepare(
        `SELECT substr(ts, 1, 10) day, COUNT(*) n FROM turns
         WHERE ts >= datetime('now', '-30 days') GROUP BY 1 ORDER BY 1`,
      )
      .all();
    const inj = db
      .prepare(
        `SELECT COUNT(*) total, SUM(CASE WHEN n_injected > 0 THEN 1 ELSE 0 END) hits, AVG(top_score) avg_top
         FROM injections WHERE source = 'hook' AND ts >= datetime('now', '-7 days')`,
      )
      .get() as any;
    let sizeMb = 0;
    try {
      sizeMb = fs.statSync(dbPath()).size / 1024 / 1024;
    } catch {
      /* fine */
    }
    json(res, 200, {
      dbPath: dbPath(),
      dbSizeMb: Number(sizeMb.toFixed(1)),
      sessions: one(`SELECT COUNT(*) n FROM sessions`),
      turns: one(`SELECT COUNT(*) n FROM turns`),
      embedded: one(`SELECT COUNT(*) n FROM vec_turns`),
      facts: one(`SELECT COUNT(*) n FROM facts WHERE archived = 0`),
      redactedTurns: one(`SELECT COUNT(*) n FROM turns WHERE redaction_count > 0`),
      bySource: db.prepare(`SELECT source_agent, COUNT(*) n FROM sessions GROUP BY 1`).all(),
      turnsPerDay,
      hookLast7d: {
        recalls: inj?.total ?? 0,
        injecting: inj?.hits ?? 0,
        avgTopScore: inj?.avg_top ? Number(inj.avg_top.toFixed(3)) : null,
      },
    });
    return true;
  }

  if (req.method === "GET" && p === "/api/sessions") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const project = url.searchParams.get("project");
    json(
      res,
      200,
      db
        .prepare(
          `SELECT s.id, s.source_agent, s.project, s.git_branch, s.last_seen_at,
                  (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) turn_count
           FROM sessions s
           WHERE EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id)
             ${project ? "AND s.project = @project" : ""}
           ORDER BY s.last_seen_at DESC LIMIT @limit`,
        )
        .all({ limit, ...(project ? { project } : {}) }),
    );
    return true;
  }

  const sessionTurns = p.match(/^\/api\/sessions\/([^/]+)\/turns$/);
  if (req.method === "GET" && sessionTurns) {
    json(
      res,
      200,
      db
        .prepare(
          `SELECT rowid, id, role, content, ts, redaction_count FROM turns WHERE session_id = ? ORDER BY rowid`,
        )
        .all(decodeURIComponent(sessionTurns[1])),
    );
    return true;
  }

  if (req.method === "GET" && p === "/api/facts") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    let facts = listFacts({
      archived: url.searchParams.get("archived") === "1",
      project: url.searchParams.get("project") ?? undefined,
    });
    if (q) facts = facts.filter((f) => f.content.toLowerCase().includes(q));
    json(res, 200, facts);
    return true;
  }

  if (req.method === "POST" && p === "/api/facts") {
    const b = await readBody(req);
    if (!VALID_KINDS.has(b.kind) || !b.content) {
      json(res, 400, { error: "kind + content required" });
      return true;
    }
    const r = await addFact({
      kind: b.kind as FactKind,
      content: String(b.content),
      project: b.project ?? null,
      origin: "manual",
      pinned: !!b.pinned,
    });
    json(res, 200, r);
    return true;
  }

  const factId = p.match(/^\/api\/facts\/([^/]+)$/);
  if (factId) {
    const id = decodeURIComponent(factId[1]);
    if (req.method === "PATCH") {
      const b = await readBody(req);
      if (typeof b.content === "string") await editFact(id, b.content);
      if (typeof b.pinned === "boolean") setPinned(id, b.pinned);
      if (typeof b.archived === "boolean") await setArchived(id, b.archived);
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === "DELETE") {
      deleteFact(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  if (req.method === "GET" && p === "/api/injections") {
    const limit = Number(url.searchParams.get("limit") ?? 100);
    json(
      res,
      200,
      db
        .prepare(`SELECT * FROM injections ORDER BY id DESC LIMIT ?`)
        .all(limit)
        .map((r: any) => ({ ...r, results: JSON.parse(r.results) })),
    );
    return true;
  }

  const label = p.match(/^\/api\/injections\/(\d+)\/label$/);
  if (req.method === "POST" && label) {
    const b = await readBody(req);
    const row = db.prepare(`SELECT * FROM injections WHERE id = ?`).get(Number(label[1])) as any;
    if (!row || !b.verdict) {
      json(res, 400, { error: "unknown injection or missing verdict" });
      return true;
    }
    const dir = path.join(os.homedir(), ".recall", "eval");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "labels.jsonl"),
      JSON.stringify({
        injection_id: row.id,
        ts: new Date().toISOString(),
        query: row.query,
        session_id: row.session_id,
        turnId: b.turnId ?? null,
        factId: b.factId ?? null,
        verdict: b.verdict, // 'relevant' | 'irrelevant'
      }) + "\n",
    );
    json(res, 200, { ok: true });
    return true;
  }

  // "Never inject this turn again" — drop its vector (the per-row prune).
  const block = p.match(/^\/api\/turns\/(\d+)\/block$/);
  if (req.method === "POST" && block) {
    db.prepare(`DELETE FROM vec_turns WHERE rowid = ?`).run(BigInt(Number(block[1])));
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}
