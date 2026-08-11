import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexLine, sessionIdFromFile } from "../src/lib/sources/codex.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "fixtures",
  "codex",
);

function parseFile(name: string) {
  const filePath = path.join(fixtureDir, name);
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  return lines.map((l) => parseCodexLine(l, { filePath })).filter(Boolean);
}

const V142 = "rollout-2026-07-31T11-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001.jsonl";
const V119 = "rollout-2026-04-15T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002.jsonl";

test("session id derives from the rollout filename", () => {
  assert.equal(sessionIdFromFile(V142), "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001");
  assert.equal(sessionIdFromFile("not-a-rollout.jsonl"), null);
});

test("v0.142 fixture: meta + exactly one user and one assistant turn", () => {
  const parsed = parseFile(V142);
  const metas = parsed.filter((p) => p!.session);
  const turns = parsed.filter((p) => p!.turn).map((p) => p!.turn!);

  assert.equal(metas.length, 1);
  assert.equal(metas[0]!.session!.gitBranch, "main");
  assert.equal(metas[0]!.session!.cwd, "C:\\Users\\dev\\projects\\webapp");
  assert.equal(metas[0]!.session!.id, "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001");

  assert.equal(turns.length, 2, JSON.stringify(turns.map((t) => t.role)));
  assert.equal(turns[0].role, "user");
  assert.ok(turns[0].content.startsWith("why is the checkout page slow"));
  assert.equal(turns[1].role, "assistant");
  assert.ok(turns[1].content.includes("memo key"));

  // Every noise class must be absent.
  const all = JSON.stringify(parsed);
  for (const marker of ["DEVELOPER-MARKER", "ENV-MARKER", "DUPLICATE-MARKER", "NEVER-STORE-MARKER"]) {
    assert.ok(!all.includes(marker), `leaked: ${marker}`);
  }
});

test("v0.119 fixture: older envelope parses, injected user_instructions skipped", () => {
  const parsed = parseFile(V119);
  const turns = parsed.filter((p) => p!.turn).map((p) => p!.turn!);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].role, "assistant");
  assert.ok(!JSON.stringify(parsed).includes("INJECT-MARKER"));
  const meta = parsed.find((p) => p!.session)!.session!;
  assert.equal(meta.gitBranch, null); // no git field in the old format
});

test("turn ids are stable across double-parse and prefixed codex:", () => {
  const a = parseFile(V142).filter((p) => p!.turn).map((p) => p!.turn!.id);
  const b = parseFile(V142).filter((p) => p!.turn).map((p) => p!.turn!.id);
  assert.deepEqual(a, b);
  for (const id of a) {
    assert.match(id, /^codex:0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001:[0-9a-f]{20}$/);
  }
});

test("defensive: garbage, missing payload, unknown types all return null", () => {
  const ctx = { filePath: path.join(fixtureDir, V142) };
  assert.equal(parseCodexLine("", ctx), null);
  assert.equal(parseCodexLine("not json", ctx), null);
  assert.equal(parseCodexLine(`{"type":"response_item"}`, ctx), null);
  assert.equal(parseCodexLine(`{"type":"future_type","payload":{}}`, ctx), null);
  // No usable filename → whole file skipped
  assert.equal(
    parseCodexLine(`{"type":"session_meta","payload":{"id":"x"}}`, { filePath: "weird.jsonl" }),
    null,
  );
});
