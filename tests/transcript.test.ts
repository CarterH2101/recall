import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLine } from "../src/lib/transcript.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "fixtures",
  "claude-code",
);

test("parses a user turn with session meta", () => {
  const line = JSON.stringify({
    sessionId: "sess-1",
    type: "user",
    uuid: "uuid-1",
    timestamp: "2026-08-01T12:00:00Z",
    cwd: "C:\\Users\\dev\\Projects\\myapp",
    gitBranch: "main",
    message: { content: "how do I fix the timeout?" },
  });
  const parsed = parseLine(line);
  assert.ok(parsed);
  assert.equal(parsed!.sessionId, "sess-1");
  assert.ok(parsed!.session);
  assert.equal(parsed!.session!.gitBranch, "main");
  assert.ok(parsed!.turn);
  assert.equal(parsed!.turn!.id, "uuid-1");
  assert.equal(parsed!.turn!.role, "user");
  assert.equal(parsed!.turn!.content, "how do I fix the timeout?");
});

test("parses assistant block content and collects tool names", () => {
  const line = JSON.stringify({
    sessionId: "sess-1",
    type: "assistant",
    uuid: "uuid-2",
    timestamp: "2026-08-01T12:00:05Z",
    message: {
      content: [
        { type: "text", text: "Raise the limit in config." },
        { type: "tool_use", name: "Edit", input: {} },
      ],
    },
  });
  const parsed = parseLine(line);
  assert.ok(parsed?.turn);
  assert.equal(parsed!.turn!.role, "assistant");
  assert.equal(parsed!.turn!.content, "Raise the limit in config.");
  assert.equal(parsed!.turn!.toolSummary, "Edit");
});

test("returns null for garbage, empty, and irrelevant lines", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("not json"), null);
  assert.equal(parseLine(`{"type":"summary","text":"x"}`), null); // no sessionId
  // tool_use only, no text → no turn, no session meta
  assert.equal(
    parseLine(
      JSON.stringify({
        sessionId: "s",
        type: "assistant",
        uuid: "u",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      }),
    ),
    null,
  );
});

test("fixture file parses without throwing and yields expected turn count", () => {
  const text = fs.readFileSync(path.join(fixtureDir, "sample.jsonl"), "utf8");
  const turns = text
    .split("\n")
    .filter(Boolean)
    .map(parseLine)
    .filter((p) => p?.turn);
  assert.equal(turns.length, 4);
});
