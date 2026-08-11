import { getDb, vecBlob } from "./db.js";
import { embedOne } from "./embed.js";
import { isSelfReferential, queryMentionsRecall } from "./signal.js";

export interface RecallOpts {
  excludeSessionId?: string;
  project?: string;
  limit?: number;
  minScore?: number;
}

export interface Snippet {
  turnId: string;
  sessionId: string;
  role: string;
  content: string;
  toolSummary: string | null;
  ts: string | null;
  project: string | null;
  score: number; // cosine similarity, 0..1
}

/** A scored KNN match before thresholding/dedup/pairing — the eval harness
 *  sweeps thresholds over one candidate pass instead of re-running KNN. */
export interface Candidate {
  rowid: number;
  turnId: string;
  sessionId: string;
  role: string;
  content: string;
  toolSummary: string | null;
  ts: string | null;
  project: string | null;
  rawScore: number;
  score: number; // after penalties
  selfPenalized: boolean;
}

// Penalty applied to recall-about-recall matches when the query isn't about
// recall itself. Sessions discussing the tool otherwise match every meta
// question ("is it working?") forever.
const SELF_PENALTY = 0.15;
// Context expansion: how much of the paired turn to include.
const PAIR_CLIP = 700;

/** Test hook: substitute the query embedder (CI uses precomputed vectors). */
export type QueryEmbedder = (q: string) => Promise<Float32Array>;
let _embedQuery: QueryEmbedder = (q) => embedOne(q.slice(0, 1500));
export function setQueryEmbedder(fn: QueryEmbedder | null): void {
  _embedQuery = fn ?? ((q) => embedOne(q.slice(0, 1500)));
}

/**
 * Stage 1: embed → KNN → filters → penalties → sorted candidates.
 * No minScore filter, no session dedup, no Q+A pairing.
 */
export async function recallCandidates(
  query: string,
  opts: Omit<RecallOpts, "minScore"> = {},
): Promise<Candidate[]> {
  const limit = opts.limit ?? 5;
  const k = Math.max(limit * 6, 24); // over-fetch: session dedupe + penalties thin the pool
  const db = getDb();
  const qvec = await _embedQuery(query);

  const matches = db
    .prepare(
      `SELECT rowid, distance FROM vec_turns WHERE embedding MATCH ? AND k = ${k} ORDER BY distance`,
    )
    .all(vecBlob(qvec)) as { rowid: number; distance: number }[];
  if (!matches.length) return [];

  const byRow = db.prepare(`
    SELECT t.rowid, t.id, t.session_id, t.role, t.content, t.tool_summary, t.ts, s.project
    FROM turns t JOIN sessions s ON s.id = t.session_id
    WHERE t.rowid = ?
  `);

  const selfOk = queryMentionsRecall(query);
  const out: Candidate[] = [];
  for (const m of matches) {
    const row = byRow.get(m.rowid) as any;
    if (!row) continue;
    if (opts.excludeSessionId && row.session_id === opts.excludeSessionId) continue;
    if (opts.project && row.project !== opts.project) continue;
    const rawScore = 1 - m.distance; // cosine distance -> similarity
    const selfPenalized = !selfOk && isSelfReferential(row.content);
    out.push({
      rowid: row.rowid,
      turnId: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      toolSummary: row.tool_summary ?? null,
      ts: row.ts ?? null,
      project: row.project ?? null,
      rawScore,
      score: selfPenalized ? rawScore - SELF_PENALTY : rawScore,
      selfPenalized,
    });
  }
  // Stable order: score desc, then rowid for deterministic ties.
  out.sort((a, b) => b.score - a.score || a.rowid - b.rowid);
  return out;
}

/**
 * Stage 2: threshold → one-snippet-per-session dedup → Q+A pairing.
 * Pure and synchronous apart from the pairing lookups.
 */
export function selectSnippets(
  candidates: Candidate[],
  opts: { limit?: number; minScore?: number } = {},
): Snippet[] {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0;
  const db = getDb();

  // Pair a matched turn with its counterpart so the snippet is a Q+A unit,
  // not an orphan fragment: a matched user prompt carries the answer it got;
  // a matched assistant reply carries the question that prompted it.
  const nextAssistant = db.prepare(`
    SELECT content FROM turns
    WHERE session_id = ? AND rowid > ? AND role = 'assistant'
    ORDER BY rowid LIMIT 1
  `);
  const prevUser = db.prepare(`
    SELECT content FROM turns
    WHERE session_id = ? AND rowid < ? AND role = 'user'
    ORDER BY rowid DESC LIMIT 1
  `);

  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  const seenSessions = new Set<string>();
  const out: Snippet[] = [];

  for (const c of candidates) {
    if (c.score < minScore) continue;
    if (seenSessions.has(c.sessionId)) continue; // one snippet per session
    seenSessions.add(c.sessionId);

    let content = c.content;
    if (c.role === "user") {
      const a = nextAssistant.get(c.sessionId, c.rowid) as { content: string } | undefined;
      if (a) content = `Q: ${c.content}\nA: ${clip(a.content, PAIR_CLIP)}`;
    } else {
      const q = prevUser.get(c.sessionId, c.rowid) as { content: string } | undefined;
      if (q) content = `Q: ${clip(q.content, 200)}\nA: ${c.content}`;
    }

    out.push({
      turnId: c.turnId,
      sessionId: c.sessionId,
      role: c.role,
      content,
      toolSummary: c.toolSummary,
      ts: c.ts,
      project: c.project,
      score: c.score,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function recall(query: string, opts: RecallOpts = {}): Promise<Snippet[]> {
  const candidates = await recallCandidates(query, {
    excludeSessionId: opts.excludeSessionId,
    project: opts.project,
    limit: opts.limit,
  });
  return selectSnippets(candidates, { limit: opts.limit, minScore: opts.minScore });
}

export interface RecentSession {
  id: string;
  project: string | null;
  git_branch: string | null;
  last_seen_at: string | null;
  turn_count: number;
}

export function recentSessions(limit = 10): RecentSession[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT s.id, s.project, s.git_branch, s.last_seen_at,
           (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count
    FROM sessions s
    WHERE EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id)
    ORDER BY s.last_seen_at DESC
    LIMIT ?
  `,
    )
    .all(limit) as RecentSession[];
}
