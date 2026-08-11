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

// Versioned migrations via PRAGMA user_version. Each entry runs exactly once,
// in order; v1 is the original CREATE IF NOT EXISTS block so pre-versioning
// databases (user_version 0) pass through it as a no-op.
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  /* v1 — baseline schema */
  (db) =>
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
  `),
  /* v2 — secret redaction bookkeeping */
  (db) => db.exec(`ALTER TABLE turns ADD COLUMN redaction_count INTEGER NOT NULL DEFAULT 0`),
  /* v3 — injections log: what recall actually surfaced, per query */
  (db) =>
    db.exec(`
    CREATE TABLE injections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL,
      source     TEXT NOT NULL,
      query      TEXT NOT NULL,
      session_id TEXT,
      project    TEXT,
      min_score  REAL,
      results    TEXT NOT NULL,
      n_injected INTEGER NOT NULL,
      top_score  REAL
    );
    CREATE INDEX idx_injections_ts ON injections(ts);
  `),
];

/** Current schema version — what a fully migrated db's user_version equals. */
export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: Database.Database): void {
  let v = db.pragma("user_version", { simple: true }) as number;
  for (; v < MIGRATIONS.length; v++) {
    const apply = db.transaction(() => MIGRATIONS[v](db));
    apply();
    db.pragma(`user_version = ${v + 1}`);
  }
}

/** Pack a vector into a BLOB for sqlite-vec binding. */
export function vecBlob(v: Float32Array | number[]): Buffer {
  const f = v instanceof Float32Array ? v : new Float32Array(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
