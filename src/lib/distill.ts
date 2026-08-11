import { spawnSync } from "node:child_process";
import { getDb, vecBlob } from "./db.js";
import { isSelfReferential } from "./signal.js";
import { addFact, type FactKind, MAX_FACT_CHARS } from "./facts.js";

// Distill: promote durable knowledge out of raw history into facts.
// Stage 1 is pure-local candidate selection (lexical durability markers +
// cross-session recurrence via vector neighborhood). Stage 2 rewrites the
// candidate into a clean fact via a pluggable local summarizer command
// (default: headless `claude -p` if present) — never a cloud API key —
// with a verbatim extractive fallback when no LLM is available.

const RECURRENCE_SIM = 0.86;
const MIN_LEN = 80;
const MAX_LEN = 4000;

const KIND_MARKERS: [FactKind, RegExp][] = [
  ["decision", /\b(decided|decision|we('ll| will) go with|went with|chose|instead of|rather than|settled on)\b/i],
  ["gotcha", /\b(gotcha|turns out|root cause|the (real )?(fix|problem|issue) (was|is)|beware|caveat|silently|doesn't actually|subtle(ty)?)\b/i],
  ["preference", /\b(always|never|prefer|convention|from now on|by default|rule of thumb)\b/i],
  ["reference", /\b(the (command|url|endpoint|path|port|token|config|file) (is|lives)|located at|listens on|port \d{2,5})\b/i],
];

export function detectKind(content: string): FactKind | null {
  for (const [kind, re] of KIND_MARKERS) if (re.test(content)) return kind;
  return null;
}

export interface DistillCandidate {
  rowid: number;
  turnId: string;
  sessionId: string;
  role: string;
  content: string;
  project: string | null;
  kind: FactKind;
  recurrentSessions: number;
  strongLexical: boolean;
}

/** Stage 1: pure-local candidate selection over embedded, unprocessed turns. */
export function findCandidates(opts: { max: number; project?: string }): DistillCandidate[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.rowid, t.id, t.session_id, t.role, t.content, s.project, v.embedding
       FROM turns t
       JOIN vec_turns v ON v.rowid = t.rowid
       JOIN sessions s ON s.id = t.session_id
       LEFT JOIN distill_state d ON d.turn_rowid = t.rowid
       WHERE d.turn_rowid IS NULL
         AND length(t.content) BETWEEN ? AND ?
         ${opts.project ? "AND s.project = ?" : ""}
       ORDER BY t.rowid`,
    )
    .all(...([MIN_LEN, MAX_LEN, ...(opts.project ? [opts.project] : [])] as any[])) as any[];

  const knn = db.prepare(
    `SELECT rowid, distance FROM vec_turns WHERE embedding MATCH ? AND k = 8 ORDER BY distance`,
  );
  const sessionOf = db.prepare(`SELECT session_id FROM turns WHERE rowid = ?`);
  const cited = new Set<string>(
    (db.prepare(`SELECT source_turn_ids FROM facts`).all() as any[]).flatMap((r) =>
      JSON.parse(r.source_turn_ids),
    ),
  );

  // Claude Code injects skill/command/system content as user turns; none of
  // it is a durable personal fact.
  const INJECTED = /^(Base directory for this skill|<command-|<system-reminder|<local-command)/;

  const out: DistillCandidate[] = [];
  for (const row of rows) {
    if (out.length >= opts.max) break;
    if (isSelfReferential(row.content)) continue;
    if (INJECTED.test(row.content.trim())) continue;
    if (cited.has(row.id)) continue;
    const kind = detectKind(row.content);
    if (!kind) continue;

    // Recurrence: same-topic neighbors from other sessions.
    const neighbors = knn.all(row.embedding) as { rowid: number; distance: number }[];
    const otherSessions = new Set<string>();
    for (const n of neighbors) {
      if (n.rowid === row.rowid) continue;
      if (1 - n.distance < RECURRENCE_SIM) continue;
      const s = sessionOf.get(n.rowid) as any;
      if (s && s.session_id !== row.session_id) otherSessions.add(s.session_id);
    }
    // Strong lexical = decision/gotcha from the assistant (the answer side);
    // weak markers need recurrence to qualify.
    const strongLexical = row.role === "assistant" && (kind === "decision" || kind === "gotcha");
    if (!strongLexical && otherSessions.size < 2) continue;

    out.push({
      rowid: row.rowid,
      turnId: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      project: row.project ?? null,
      kind,
      recurrentSessions: otherSessions.size,
      strongLexical,
    });
  }
  return out;
}

/** The Q+A unit around a candidate (same pairing recall uses). */
export function pairContext(c: DistillCandidate): string {
  const db = getDb();
  if (c.role === "assistant") {
    const q = db
      .prepare(
        `SELECT content FROM turns WHERE session_id = ? AND rowid < ? AND role = 'user' ORDER BY rowid DESC LIMIT 1`,
      )
      .get(c.sessionId, c.rowid) as any;
    return q ? `Q: ${q.content.slice(0, 400)}\nA: ${c.content}` : c.content;
  }
  const a = db
    .prepare(
      `SELECT content FROM turns WHERE session_id = ? AND rowid > ? AND role = 'assistant' ORDER BY rowid LIMIT 1`,
    )
    .get(c.sessionId, c.rowid) as any;
  return a ? `Q: ${c.content}\nA: ${a.content.slice(0, 1200)}` : c.content;
}

export interface Summarized {
  kind: FactKind;
  content: string;
  extractive: boolean;
}

const PROMPT = `Extract ONE durable, standalone fact a coding agent should remember from this exchange. It must be useful months later without session context: a decision (and why), a gotcha/root cause, a standing preference/convention, or a reference (command/endpoint/config).
Reply with ONLY a JSON object, no prose: {"kind":"decision|gotcha|preference|reference","content":"<= 450 chars, declarative, no session-specific pronouns"} or {"skip":true} if nothing durable is here.

Exchange:
`;

function summarizerCommand(): string[] | null {
  if (process.env.RECALL_DISTILL_CMD) {
    return process.env.RECALL_DISTILL_CMD.split(" ").filter(Boolean);
  }
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], {
    encoding: "utf8",
  });
  if (probe.status === 0) return ["claude", "-p"];
  return null;
}

function parseSummarizerOutput(raw: string): { kind?: string; content?: string; skip?: boolean } | null {
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let obj = tryParse(raw.trim());
  if (obj && typeof obj.result === "string") obj = tryParse(obj.result.trim()) ?? obj;
  if (!obj) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  return obj;
}

const VALID_KINDS = new Set(["decision", "gotcha", "preference", "reference"]);

export function summarize(c: DistillCandidate, cmd: string[] | null): Summarized {
  // Extractive fallback: assistant content only (a "Q: continue" pair adds
  // nothing), and only for strong-lexical assistant turns — weak candidates
  // without an LLM rewrite aren't worth a 📌 slot.
  const extractive = (): Summarized => {
    if (!c.strongLexical) return { kind: c.kind, content: "", extractive: true };
    return {
      kind: c.kind,
      content: c.content.slice(0, MAX_FACT_CHARS - 20),
      extractive: true,
    };
  };

  if (!cmd) return extractive();
  const r =
    process.platform === "win32"
      ? spawnSync(cmd.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" "), {
          input: PROMPT + pairContext(c),
          encoding: "utf8",
          timeout: 60_000,
          shell: true,
        })
      : spawnSync(cmd[0], cmd.slice(1), {
          input: PROMPT + pairContext(c),
          encoding: "utf8",
          timeout: 60_000,
        });
  if (r.status !== 0 || !r.stdout) return extractive();
  const obj = parseSummarizerOutput(r.stdout);
  if (!obj) return extractive();
  if (obj.skip) return { kind: c.kind, content: "", extractive: false };
  if (!obj.content || !VALID_KINDS.has(String(obj.kind))) return extractive();
  return { kind: obj.kind as FactKind, content: String(obj.content).slice(0, MAX_FACT_CHARS), extractive: false };
}

export interface DistillRunResult {
  examined: number;
  promoted: number;
  merged: number;
  skipped: number;
  nearDuplicates: number;
  rows: { turnId: string; kind: string; content: string; action: string }[];
}

export async function runDistill(opts: {
  apply: boolean;
  max: number;
  project?: string;
}): Promise<DistillRunResult> {
  const db = getDb();
  const candidates = findCandidates(opts);
  const cmd = summarizerCommand();
  const markState = db.prepare(
    `INSERT OR REPLACE INTO distill_state (turn_rowid, outcome, fact_id, processed_at) VALUES (?, ?, ?, ?)`,
  );

  const result: DistillRunResult = {
    examined: candidates.length,
    promoted: 0,
    merged: 0,
    skipped: 0,
    nearDuplicates: 0,
    rows: [],
  };

  for (const c of candidates) {
    const s = summarize(c, cmd);
    if (!s.content) {
      result.skipped++;
      if (opts.apply) markState.run(c.rowid, "rejected", null, new Date().toISOString());
      result.rows.push({ turnId: c.turnId, kind: c.kind, content: "(skipped by summarizer)", action: "skip" });
      continue;
    }
    if (!opts.apply) {
      result.rows.push({
        turnId: c.turnId,
        kind: s.kind,
        content: s.content,
        action: s.extractive ? "would-promote (extractive)" : "would-promote",
      });
      result.promoted++;
      continue;
    }
    const added = await addFact({
      kind: s.kind,
      content: s.content,
      project: c.project,
      sourceTurnIds: [c.turnId],
      origin: "distill",
    });
    if (added.action === "inserted") result.promoted++;
    else if (added.action === "near-duplicate-inserted") {
      result.promoted++;
      result.nearDuplicates++;
    } else result.merged++;
    markState.run(
      c.rowid,
      added.action.startsWith("merged") ? "merged" : "promoted",
      added.id,
      new Date().toISOString(),
    );
    result.rows.push({ turnId: c.turnId, kind: s.kind, content: s.content, action: added.action });
  }
  return result;
}
