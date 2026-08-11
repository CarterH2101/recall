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

// Penalty applied to recall-about-recall matches when the query isn't about
// recall itself. Sessions discussing the tool otherwise match every meta
// question ("is it working?") forever.
const SELF_PENALTY = 0.15;
// Context expansion: how much of the paired turn to include.
const PAIR_CLIP = 700;

export async function recall(query: string, opts: RecallOpts = {}): Promise<Snippet[]> {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0;
  const k = Math.max(limit * 6, 24); // over-fetch: session dedupe + penalties thin the pool
  const db = getDb();
  const qvec = await embedOne(query.slice(0, 1500));

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
  const selfOk = queryMentionsRecall(query);
  const seenSessions = new Set<string>();

  const scored: { row: any; score: number }[] = [];
  for (const m of matches) {
    const row = byRow.get(m.rowid) as any;
    if (!row) continue;
    if (opts.excludeSessionId && row.session_id === opts.excludeSessionId) continue;
    if (opts.project && row.project !== opts.project) continue;
    let score = 1 - m.distance; // cosine distance -> similarity
    if (!selfOk && isSelfReferential(row.content)) score -= SELF_PENALTY;
    if (score < minScore) continue;
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const out: Snippet[] = [];
  for (const { row, score } of scored) {
    if (seenSessions.has(row.session_id)) continue; // one snippet per session
    seenSessions.add(row.session_id);

    let content = row.content;
    if (row.role === "user") {
      const a = nextAssistant.get(row.session_id, row.rowid) as { content: string } | undefined;
      if (a) content = `Q: ${row.content}\nA: ${clip(a.content, PAIR_CLIP)}`;
    } else {
      const q = prevUser.get(row.session_id, row.rowid) as { content: string } | undefined;
      if (q) content = `Q: ${clip(q.content, 200)}\nA: ${row.content}`;
    }

    out.push({
      turnId: row.id,
      sessionId: row.session_id,
      role: row.role,
      content,
      toolSummary: row.tool_summary ?? null,
      ts: row.ts ?? null,
      project: row.project ?? null,
      score,
    });
    if (out.length >= limit) break;
  }
  return out;
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
