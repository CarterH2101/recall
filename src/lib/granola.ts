import { getDb, vecBlob } from "./db.js";
import { embed } from "./embed.js";
import { redact } from "./redact.js";

const MAX_CONTENT = 8000;
const EMBED_CLIP = 1500;

/** One Granola meeting, flattened to a single memory record. */
export interface GranolaMeeting {
  id: string; // Granola meeting UUID (stable idempotent key)
  title?: string | null;
  ts?: string | null; // ISO timestamp of the meeting
  content: string; // summary + notes + transcript excerpt, pre-joined
}

export interface GranolaIngestResult {
  newTurns: number;
  total: number;
}

/**
 * Ingest Granola meeting notes as a first-class memory source
 * (source_agent = 'granola', project = 'granola'). One meeting = one session +
 * one turn. Idempotent: turn id = `granola:<meetingId>` with INSERT OR IGNORE,
 * so re-running only embeds genuinely new meetings.
 */
export async function ingestGranolaMeetings(
  meetings: GranolaMeeting[],
): Promise<GranolaIngestResult> {
  const db = getDb();

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, source_agent, project, started_at, last_seen_at, title)
    VALUES (@sid, 'granola', 'granola', @ts, @ts, @title)
    ON CONFLICT(id) DO UPDATE SET
      title        = COALESCE(excluded.title, sessions.title),
      last_seen_at = COALESCE(excluded.last_seen_at, sessions.last_seen_at)
  `);
  const insertTurn = db.prepare(`
    INSERT OR IGNORE INTO turns (id, session_id, role, content, tool_summary, ts)
    VALUES (@id, @sid, 'note', @content, NULL, @ts)
  `);

  const newRows: { rowid: bigint; content: string }[] = [];

  const write = db.transaction(() => {
    for (const m of meetings) {
      // Meetings can contain read-aloud credentials too — same gate as code.
      const content = redact((m.content || "").slice(0, MAX_CONTENT).trim()).text;
      if (!content) continue;
      const sid = `granola:${m.id}`;
      upsertSession.run({ sid, ts: m.ts ?? null, title: m.title ?? null });
      const info = insertTurn.run({ id: sid, sid, content, ts: m.ts ?? null });
      if (info.changes === 1) {
        newRows.push({ rowid: BigInt(info.lastInsertRowid), content });
      }
    }
  });
  write();

  if (newRows.length) {
    const vectors = await embed(newRows.map((r) => r.content.slice(0, EMBED_CLIP)));
    const insertVec = db.prepare(`INSERT OR REPLACE INTO vec_turns (rowid, embedding) VALUES (?, ?)`);
    const writeVecs = db.transaction(() => {
      for (let i = 0; i < newRows.length; i++) insertVec.run(newRows[i].rowid, vecBlob(vectors[i]));
    });
    writeVecs();
  }

  return { newTurns: newRows.length, total: meetings.length };
}
