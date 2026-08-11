export interface Turn {
  id: string; // stable idempotent key; scheme is per-source (see adapters)
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  toolSummary: string | null;
  ts: string | null;
}

export interface SessionMeta {
  id: string;
  project: string | null;
  gitBranch: string | null;
  cwd: string | null;
  ts: string | null;
}

export interface ParsedLine {
  sessionId: string;
  session: SessionMeta | null;
  turn: Turn | null;
}

export interface ParseContext {
  /** Absolute path of the file the line came from. Codex derives the session
   *  id from the rollout filename — payloads never repeat it mid-file, and
   *  the byte cursor resumes mid-file. */
  filePath?: string;
}

/**
 * A capture source. Line-oriented on purpose: append-only JSONL is what the
 * byte-cursor ingest path understands. Sources with non-line storage (e.g.
 * Cursor's SQLite) bypass ingest() and follow the granola pattern instead.
 */
export interface SourceAdapter {
  /** Registry key and sessions.source_agent value ('claude-code', 'codex'). */
  name: string;
  /** Every transcript file this source has on disk (backfill + catch-up). */
  discover(): string[];
  /** Directories the daemon watcher should monitor; [] = push-driven only. */
  watchRoots(): string[];
  /** Version-tolerant single-line parser; null = irrelevant/unparseable. */
  parseLine(line: string, ctx?: ParseContext): ParsedLine | null;
}
