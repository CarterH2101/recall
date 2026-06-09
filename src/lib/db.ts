import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { dbPath, dataDir, ensureDir } from "./paths.js";

/** Embedding dimension for bge-small-en-v1.5. */
export const DIM = 384;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  ensureDir(dataDir());
  const db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  migrate(db);
  _db = db;
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      source_agent TEXT NOT NULL DEFAULT 'claude-code',
      project      TEXT,
      git_branch   TEXT,
      cwd          TEXT,
      started_at   TEXT,
      last_seen_at TEXT,
      title        TEXT
    );

    CREATE TABLE IF NOT EXISTS turns (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      tool_summary TEXT,
      ts           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_turns
      USING vec0(embedding float[${DIM}] distance_metric=cosine);
  `);
}

/** Pack a vector into a BLOB for sqlite-vec binding. */
export function vecBlob(v: Float32Array | number[]): Buffer {
  const f = v instanceof Float32Array ? v : new Float32Array(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
