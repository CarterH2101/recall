import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// Simulates a database created before versioned migrations existed:
// full v1 schema on disk but user_version = 0. Running migrate() must be a
// no-op for the schema (CREATE IF NOT EXISTS), keep rows intact, and stamp
// the version.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-legacy-test-"));
const dbFile = path.join(tmp, "memory.db");
process.env.RECALL_DB_PATH = dbFile;

function buildLegacyDb(): void {
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE sessions (
      id           TEXT PRIMARY KEY,
      source_agent TEXT NOT NULL DEFAULT 'claude-code',
      project      TEXT,
      git_branch   TEXT,
      cwd          TEXT,
      started_at   TEXT,
      last_seen_at TEXT,
      title        TEXT
    );
    CREATE TABLE turns (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      tool_summary TEXT,
      ts           TEXT
    );
    CREATE INDEX idx_turns_session ON turns(session_id);
    CREATE VIRTUAL TABLE vec_turns
      USING vec0(embedding float[384] distance_metric=cosine);
  `);
  db.prepare(`INSERT INTO sessions (id, project) VALUES ('s1', 'proj')`).run();
  db.prepare(
    `INSERT INTO turns (id, session_id, role, content) VALUES ('t1', 's1', 'user', 'hello')`,
  ).run();
  db.close();
}

test("legacy pre-versioning db migrates without data loss", async () => {
  buildLegacyDb();
  const { getDb, SCHEMA_VERSION } = await import("../src/lib/db.js");
  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  // v2 column landed on the legacy table
  assert.ok(db.prepare(`SELECT redaction_count FROM turns LIMIT 1`));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()!["n" as never], 1);
  const turn = db.prepare(`SELECT * FROM turns WHERE id = 't1'`).get() as any;
  assert.equal(turn.content, "hello");
  assert.equal(turn.session_id, "s1");
});
