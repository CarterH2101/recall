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
  score: number; // cosine similarity, 0..1 (facts carry boosts)
  kind?: "turn" | "fact";
  factId?: string;
  factKind?: string;
  via?: string; // teammate name for team-synced facts
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

// Facts rank above raw snippets: compressed, human-curated memory beats a
// transcript fragment at equal similarity. They get a score boost, pass at a
// slightly relieved threshold, are exempt from session dedup, and are capped
// at limit-1 so at least one raw-snippet slot survives (facts compress; raw
// snippets carry the detail).
const FACT_BOOST = 0.06;
const PIN_BOOST = 0.05;
const FACT_THRESHOLD_RELIEF = 0.05;

export interface FactMatch {
  factId: string;
  factKind: string;
  content: string;
  project: string | null;
  updatedAt: string;
  pinned: boolean;
  sourceTurnIds: string[];
  score: number;
  via: string | null; // teammate display name for synced facts
}

export async function recallFactMatches(
  query: string,
  opts: { project?: string; limit?: number } = {},
): Promise<FactMatch[]> {
  const db = getDb();
  const k = Math.max((opts.limit ?? 5) * 2, 8);
  const qvec = await _embedQuery(query);
  let matches: { rowid: number; distance: number }[];
  try {
    matches = db
      .prepare(
        `SELECT rowid, distance FROM vec_facts WHERE embedding MATCH ? AND k = ${k} ORDER BY distance`,
      )
      .all(vecBlob(qvec)) as any[];
  } catch {
    return []; // pre-v4 database
  }
  // origin_member/team_members arrive in later migrations; tolerate their
  // absence so recall works mid-upgrade.
  let byRow;
  let labelNet: any = null;
  try {
    byRow = db.prepare(
      `SELECT f.*, tm.name AS via FROM facts f
       LEFT JOIN team_members tm ON tm.member_id = f.origin_member
       WHERE f.rowid = ?`,
    );
    labelNet = db.prepare(
      `SELECT SUM(CASE verdict WHEN 'useful' THEN 1 ELSE -1 END) net FROM fact_labels WHERE fact_id = ?`,
    );
  } catch {
    byRow = db.prepare(`SELECT f.*, NULL AS via FROM facts f WHERE f.rowid = ?`);
  }

  const out: FactMatch[] = [];
  for (const m of matches) {
    const f = byRow.get(m.rowid) as any;
    if (!f || f.archived) continue;
    if (opts.project && f.project !== opts.project) continue;
    // Team curation: bounded so popularity never beats relevance.
    let curation = 0;
    if (labelNet) {
      const net = (labelNet.get(f.id) as any)?.net ?? 0;
      curation = 0.01 * Math.max(-2, Math.min(4, net));
    }
    out.push({
      factId: f.id,
      factKind: f.kind,
      content: f.content,
      project: f.project ?? null,
      updatedAt: f.updated_at,
      pinned: !!f.pinned,
      sourceTurnIds: JSON.parse(f.source_turn_ids),
      score: 1 - m.distance + FACT_BOOST + (f.pinned ? PIN_BOOST : 0) + curation,
      via: f.via ?? null,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export async function recall(query: string, opts: RecallOpts = {}): Promise<Snippet[]> {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0;

  const [candidates, factMatches] = [
    await recallCandidates(query, {
      excludeSessionId: opts.excludeSessionId,
      project: opts.project,
      limit,
    }),
    await recallFactMatches(query, { project: opts.project, limit }),
  ];

  const facts = factMatches
    .filter((f) => f.score >= Math.max(0, minScore - FACT_THRESHOLD_RELIEF))
    .slice(0, Math.max(0, limit - 1));

  // A raw turn already distilled into a selected fact is redundant.
  const suppressed = new Set(facts.flatMap((f) => f.sourceTurnIds));
  const turnSnippets = selectSnippets(
    candidates.filter((c) => !suppressed.has(c.turnId)),
    { limit, minScore },
  );

  const factSnippets: Snippet[] = facts.map((f) => ({
    turnId: "",
    sessionId: `fact:${f.factId}`,
    role: "fact",
    content: f.content,
    toolSummary: null,
    ts: f.updatedAt,
    project: f.project,
    score: f.score,
    kind: "fact" as const,
    factId: f.factId,
    factKind: f.factKind,
    via: f.via ?? undefined,
  }));

  return [...factSnippets, ...turnSnippets]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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
