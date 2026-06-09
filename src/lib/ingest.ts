import fs from "node:fs";
import { getDb, vecBlob } from "./db.js";
import { embed } from "./embed.js";
import { parseLine, type Turn, type SessionMeta } from "./transcript.js";
import { getOffset, setOffset } from "./cursor.js";

const EMBED_CLIP = 1500;

export interface IngestResult {
  newTurns: number;
  scannedLines: number;
}

/**
 * Ingest only the bytes appended to a transcript since last run.
 * Idempotent: turn ids are line uuids with INSERT OR IGNORE, so a lost
 * cursor at worst re-reads but never duplicates.
 */
export async function ingest(transcriptPath: string): Promise<IngestResult> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { newTurns: 0, scannedLines: 0 };
  }

  let offset = getOffset(transcriptPath);
  if (offset > stat.size) offset = 0; // file replaced/truncated
  if (offset === stat.size) return { newTurns: 0, scannedLines: 0 };

  const len = stat.size - offset;
  const fd = fs.openSync(transcriptPath, "r");
  const buf = Buffer.allocUnsafe(len);
  fs.readSync(fd, buf, 0, len, offset);
  fs.closeSync(fd);
  const text = buf.toString("utf8");

  const hasTrailingNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  const lastIndex = rawLines.length - 1;

  const turns: Turn[] = [];
  const sessions = new Map<string, SessionMeta>();
  let processedBytes = 0;
  let scannedLines = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const isLast = i === lastIndex;
    if (isLast && !hasTrailingNewline) break; // partial trailing line, defer
    if (isLast && line === "") break; // empty element after final newline
    processedBytes += Buffer.byteLength(line, "utf8") + 1; // + the consumed "\n"
    scannedLines++;
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (parsed.session) sessions.set(parsed.sessionId, parsed.session);
    if (parsed.turn) turns.push(parsed.turn);
  }

  const db = getDb();

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, source_agent, project, git_branch, cwd, started_at, last_seen_at)
    VALUES (@id, 'claude-code', @project, @gitBranch, @cwd, @ts, @ts)
    ON CONFLICT(id) DO UPDATE SET
      project      = COALESCE(excluded.project, sessions.project),
      git_branch   = COALESCE(excluded.git_branch, sessions.git_branch),
      cwd          = COALESCE(excluded.cwd, sessions.cwd),
      last_seen_at = COALESCE(excluded.last_seen_at, sessions.last_seen_at)
  `);
  const ensureSession = db.prepare(`INSERT OR IGNORE INTO sessions (id) VALUES (?)`);
  const insertTurn = db.prepare(`
    INSERT OR IGNORE INTO turns (id, session_id, role, content, tool_summary, ts)
    VALUES (@id, @sessionId, @role, @content, @toolSummary, @ts)
  `);

  const newRows: { rowid: bigint; content: string }[] = [];

  const writeTurns = db.transaction(() => {
    for (const s of sessions.values()) upsertSession.run(s);
    for (const t of turns) {
      ensureSession.run(t.sessionId);
      const info = insertTurn.run(t);
      if (info.changes === 1) {
        newRows.push({ rowid: BigInt(info.lastInsertRowid), content: t.content });
      }
    }
  });
  writeTurns();

  // Embed new turns outside the sync transaction.
  if (newRows.length) {
    const vectors = await embed(newRows.map((r) => r.content.slice(0, EMBED_CLIP)));
    const insertVec = db.prepare(
      `INSERT OR REPLACE INTO vec_turns (rowid, embedding) VALUES (?, ?)`,
    );
    const writeVecs = db.transaction(() => {
      for (let i = 0; i < newRows.length; i++) {
        insertVec.run(newRows[i].rowid, vecBlob(vectors[i]));
      }
    });
    writeVecs();
  }

  setOffset(transcriptPath, offset + processedBytes);
  return { newTurns: newRows.length, scannedLines };
}
