import { getDb, vecBlob } from "./db.js";
import { embedOne } from "./embed.js";

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

export async function recall(query: string, opts: RecallOpts = {}): Promise<Snippet[]> {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0;
  const k = Math.max(limit * 4, 12); // over-fetch, then filter by session/project
  const db = getDb();
  const qvec = await embedOne(query.slice(0, 1500));

  const matches = db
    .prepare(
      `SELECT rowid, distance FROM vec_turns WHERE embedding MATCH ? AND k = ${k} ORDER BY distance`,
    )
    .all(vecBlob(qvec)) as { rowid: number; distance: number }[];
  if (!matches.length) return [];

  const byRow = db.prepare(`
    SELECT t.id, t.session_id, t.role, t.content, t.tool_summary, t.ts, s.project
    FROM turns t JOIN sessions s ON s.id = t.session_id
    WHERE t.rowid = ?
  `);

  const out: Snippet[] = [];
  for (const m of matches) {
    const row = byRow.get(m.rowid) as any;
    if (!row) continue;
    if (opts.excludeSessionId && row.session_id === opts.excludeSessionId) continue;
    if (opts.project && row.project !== opts.project) continue;
    const score = 1 - m.distance; // cosine distance -> similarity
    if (score < minScore) continue;
    out.push({
      turnId: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      toolSummary: row.tool_summary ?? null,
      ts: row.ts ?? null,
      project: row.project ?? null,
      score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
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
