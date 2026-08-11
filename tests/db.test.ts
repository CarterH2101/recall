import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must be set before db.js is imported — paths are read at call time but the
// db handle is a module singleton.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-test-"));
process.env.RECALL_DB_PATH = path.join(tmp, "memory.db");

test("fresh db migrates to current user_version with full schema", async () => {
  const { getDb } = await import("../src/lib/db.js");
  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 1);
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((r: any) => r.name);
  for (const t of ["sessions", "turns", "vec_turns"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});
