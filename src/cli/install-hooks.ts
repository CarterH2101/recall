import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shimPath } from "../lib/install.js";

// Registers the capture (Stop) and auto-recall (UserPromptSubmit) hooks in
// the user's global Claude Code settings, pointing at the stable shims in
// ~/.recall/bin. Also scrubs legacy clone-era hook entries (absolute paths
// into a repo checkout's dist/) so reinstalls never leave duplicates.

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

// Anything recall has ever written: clone-era `node ".../dist/hooks/x.js"`
// commands, and shim paths from any prior install location.
const RECALL_HOOK_PATTERNS = [
  /dist[\/\\]hooks[\/\\](stop|prompt)-hook\.js/,
  /[\/\\]\.recall[\/\\]bin[\/\\]recall-(stop|prompt)-hook\.(cmd|sh)/,
];

export function isRecallHookCommand(command: string): boolean {
  return RECALL_HOOK_PATTERNS.some((p) => p.test(command));
}

/** Remove every recall-authored hook entry. Returns the removed commands. */
export function scrubRecallHooks(settings: any): string[] {
  const removed: string[] = [];
  if (!settings.hooks) return removed;
  for (const event of Object.keys(settings.hooks)) {
    const groups: HookGroup[] = settings.hooks[event] ?? [];
    for (const g of groups) {
      const keep = (g.hooks ?? []).filter((h) => {
        const isOurs = typeof h.command === "string" && isRecallHookCommand(h.command);
        if (isOurs) removed.push(h.command);
        return !isOurs;
      });
      g.hooks = keep;
    }
    settings.hooks[event] = groups.filter((g) => (g.hooks ?? []).length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  return removed;
}

export function ensureHook(
  settings: any,
  event: string,
  command: string,
  timeoutSecs: number,
): boolean {
  settings.hooks = settings.hooks || {};
  const groups: HookGroup[] = settings.hooks[event] || [];
  const already = groups.some((g) => g.hooks?.some((h) => h.command === command));
  if (already) return false;
  groups.push({ hooks: [{ type: "command", command, timeout: timeoutSecs }] });
  settings.hooks[event] = groups;
  return true;
}

export function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function run(): void {
  const file = settingsPath();

  let settings: any = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`Refusing to touch unparseable settings.json: ${(e as Error).message}`);
      process.exit(1);
    }
    const backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
    console.log(`Backed up existing settings to ${backup}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const removed = scrubRecallHooks(settings);
  for (const cmd of removed) console.log(`  - removed: ${cmd}`);

  // Stop gets headroom for a cold daemon + model warm on first ingest after
  // reboot; the prompt hook must never stall a prompt, so it stays tight
  // (its own internal backstop is 1.5s).
  const stopCmd = `"${shimPath("recall-stop-hook")}"`;
  const promptCmd = `"${shimPath("recall-prompt-hook")}"`;
  ensureHook(settings, "Stop", stopCmd, 60);
  ensureHook(settings, "UserPromptSubmit", promptCmd, 5);

  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  console.log(`Updated ${file}`);
  console.log(`  + Stop:             ${stopCmd} (timeout 60s)`);
  console.log(`  + UserPromptSubmit: ${promptCmd} (timeout 5s)`);
  console.log("\nRestart Claude Code sessions to pick up the new hooks.");
}
