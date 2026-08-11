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
  /* v4 — distilled durable facts + promotion bookkeeping */
  (db) =>
    db.exec(`
    CREATE TABLE facts (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL CHECK (kind IN ('decision','gotcha','preference','reference')),
      content         TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      source_turn_ids TEXT NOT NULL DEFAULT '[]',
      project         TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      pinned          INTEGER NOT NULL DEFAULT 0,
      archived        INTEGER NOT NULL DEFAULT 0,
      edited          INTEGER NOT NULL DEFAULT 0,
      origin          TEXT NOT NULL DEFAULT 'distill'
    );
    CREATE UNIQUE INDEX idx_facts_hash ON facts(content_hash);
    CREATE INDEX idx_facts_project ON facts(project);

    CREATE VIRTUAL TABLE vec_facts
      USING vec0(embedding float[${DIM}] distance_metric=cosine);

    CREATE TABLE distill_state (
      turn_rowid   INTEGER PRIMARY KEY,
      outcome      TEXT NOT NULL,
      fact_id      TEXT,
      processed_at TEXT NOT NULL
    );
  `),
  /* v5 — team sync: per-fact share/version state + pull cursor */
  (db) =>
    db.exec(`
    ALTER TABLE facts ADD COLUMN shared INTEGER NOT NULL DEFAULT 0; -- 0 no, 1 yes, 2 yes+secret-override
    ALTER TABLE facts ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE facts ADD COLUMN synced_version INTEGER NOT NULL DEFAULT -1;
    ALTER TABLE facts ADD COLUMN origin_device TEXT;

    CREATE TABLE sync_state (
      team_id   TEXT PRIMARY KEY,
      last_seq  INTEGER NOT NULL DEFAULT 0,
      last_sync TEXT
    );
  `),
  /* v6 — team sync v2: member registry, attribution, record-chain cursor */
  (db) =>
    db.exec(`
    ALTER TABLE facts ADD COLUMN origin_member TEXT;
    ALTER TABLE sync_state ADD COLUMN last_rec_seq INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE team_members (
      member_id TEXT PRIMARY KEY,
      name      TEXT,
      sign_pub  TEXT NOT NULL,
      role      TEXT NOT NULL DEFAULT 'member',
      status    TEXT NOT NULL DEFAULT 'active'
    );
  `),
  /* v7 — team curation: per-member fact labels (LWW per (fact, member)) */
  (db) =>
    db.exec(`
    CREATE TABLE fact_labels (
      fact_id        TEXT NOT NULL,
      member_id      TEXT NOT NULL,
      verdict        TEXT NOT NULL CHECK (verdict IN ('useful','noise')),
      ts             TEXT NOT NULL,
      version        INTEGER NOT NULL DEFAULT 1,
      synced_version INTEGER NOT NULL DEFAULT -1,
      PRIMARY KEY (fact_id, member_id)
    );
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
