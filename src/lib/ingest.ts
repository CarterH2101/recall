import fs from "node:fs";
import { getDb, vecBlob } from "./db.js";
import { embed } from "./embed.js";
import type { SessionMeta, SourceAdapter, Turn } from "./sources/types.js";
import { claudeCode } from "./sources/claude-code.js";
import { getOffset, setOffset } from "./cursor.js";
import { isLowSignal } from "./signal.js";
import { redact, mergeCounts } from "./redact.js";

const EMBED_CLIP = 1500;

export interface IngestResult {
  newTurns: number;
  scannedLines: number;
  redactions: Record<string, number>;
}

/**
 * Ingest only the bytes appended to a transcript since last run.
 * Idempotent: turn ids are source-stable (line uuids / content hashes) with
 * INSERT OR IGNORE, so a lost cursor at worst re-reads but never duplicates.
 * Secrets are redacted before insert — and therefore before embedding.
 */
export async function ingest(
  transcriptPath: string,
  adapter: SourceAdapter = claudeCode,
): Promise<IngestResult> {
  const empty: IngestResult = { newTurns: 0, scannedLines: 0, redactions: {} };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return empty;
  }

  let offset = getOffset(transcriptPath);
  if (offset > stat.size) offset = 0; // file replaced/truncated
  if (offset === stat.size) return empty;

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
  const redactions: Record<string, number> = {};
  let processedBytes = 0;
  let scannedLines = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const isLast = i === lastIndex;
    if (isLast && !hasTrailingNewline) break; // partial trailing line, defer
    if (isLast && line === "") break; // empty element after final newline
    processedBytes += Buffer.byteLength(line, "utf8") + 1; // + the consumed "\n"
    scannedLines++;
    const parsed = adapter.parseLine(line, { filePath: transcriptPath });
    if (!parsed) continue;
    if (parsed.session) sessions.set(parsed.sessionId, parsed.session);
    if (parsed.turn) {
      const r = redact(parsed.turn.content);
      if (r.count) {
        parsed.turn.content = r.text;
        mergeCounts(redactions, r.byRule);
      }
      turns.push({ ...parsed.turn, ...(r.count ? { redactionCount: r.count } : {}) } as Turn & {
        redactionCount?: number;
      });
    }
  }

  const db = getDb();

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, source_agent, project, git_branch, cwd, started_at, last_seen_at)
    VALUES (@id, @sourceAgent, @project, @gitBranch, @cwd, @ts, @ts)
    ON CONFLICT(id) DO UPDATE SET
      project      = COALESCE(excluded.project, sessions.project),
      git_branch   = COALESCE(excluded.git_branch, sessions.git_branch),
      cwd          = COALESCE(excluded.cwd, sessions.cwd),
      last_seen_at = COALESCE(excluded.last_seen_at, sessions.last_seen_at)
  `);
  // Carry source_agent even when the meta line hasn't been seen (cursor
  // resumed mid-file) — relying on the column default would mislabel
  // non-claude sources.
  const ensureSession = db.prepare(
    `INSERT OR IGNORE INTO sessions (id, source_agent) VALUES (?, ?)`,
  );
  const insertTurn = db.prepare(`
    INSERT OR IGNORE INTO turns (id, session_id, role, content, tool_summary, ts, redaction_count)
    VALUES (@id, @sessionId, @role, @content, @toolSummary, @ts, @redactionCount)
  `);

  const newRows: { rowid: bigint; content: string }[] = [];

  const writeTurns = db.transaction(() => {
    for (const s of sessions.values()) upsertSession.run({ ...s, sourceAgent: adapter.name });
    for (const t of turns as (Turn & { redactionCount?: number })[]) {
      ensureSession.run(t.sessionId, adapter.name);
      const info = insertTurn.run({
        id: t.id,
        sessionId: t.sessionId,
        role: t.role,
        content: t.content,
        toolSummary: t.toolSummary,
        ts: t.ts,
        redactionCount: t.redactionCount ?? 0,
      });
      // Low-signal turns are stored (so neighbors can expand into them at
      // recall time) but never embedded — they can't surface as matches.
      if (info.changes === 1 && !isLowSignal(t.role, t.content)) {
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
  return { newTurns: newRows.length, scannedLines, redactions };
}
