import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureHook,
  scrubRecallHooks,
  isRecallHookCommand,
} from "../src/cli/install-hooks.js";

test("isRecallHookCommand matches clone-era and shim commands, not others", () => {
  assert.ok(
    isRecallHookCommand(
      'node "C:/Users/x/Documents/Claude/Carter/Projects/agent-memory/dist/hooks/stop-hook.js"',
    ),
  );
  assert.ok(isRecallHookCommand('"C:\\Users\\x\\.recall\\bin\\recall-prompt-hook.cmd"'));
  assert.ok(isRecallHookCommand('"/home/x/.recall/bin/recall-stop-hook.sh"'));
  assert.ok(!isRecallHookCommand("node /some/other/tool/dist/hooks/other.js"));
  assert.ok(!isRecallHookCommand("~/.claude/indicator/hook.js"));
});

test("scrub removes recall hooks, keeps foreign hooks, drops empty groups", () => {
  const settings: any = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: 'node "/repo/dist/hooks/stop-hook.js"' }] },
        { hooks: [{ type: "command", command: "node /other/indicator.js" }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: 'node "/repo/dist/hooks/prompt-hook.js"' }] },
      ],
      PostToolUse: [{ hooks: [{ type: "command", command: "some-unrelated-hook" }] }],
    },
  };
  const removed = scrubRecallHooks(settings);
  assert.equal(removed.length, 2);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "node /other/indicator.js");
  assert.equal(settings.hooks.UserPromptSubmit, undefined);
  assert.equal(settings.hooks.PostToolUse.length, 1);
});

test("scrub then ensure is idempotent across reinstalls at different paths", () => {
  const settings: any = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: 'node "/old/clone/dist/hooks/stop-hook.js"' }] },
        { hooks: [{ type: "command", command: '"/home/u/.recall/bin/recall-stop-hook.sh"' }] },
      ],
    },
  };
  // reinstall 1
  scrubRecallHooks(settings);
  ensureHook(settings, "Stop", '"/home/u/.recall/bin/recall-stop-hook.sh"', 60);
  // reinstall 2 (same shim path — must not duplicate)
  scrubRecallHooks(settings);
  ensureHook(settings, "Stop", '"/home/u/.recall/bin/recall-stop-hook.sh"', 60);

  const cmds = settings.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.deepEqual(cmds, ['"/home/u/.recall/bin/recall-stop-hook.sh"']);
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 60);
});

test("ensureHook preserves unrelated settings keys", () => {
  const settings: any = { model: "opus", hooks: {} };
  ensureHook(settings, "UserPromptSubmit", '"/x/recall-prompt-hook.sh"', 5);
  assert.equal(settings.model, "opus");
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].timeout, 5);
});
