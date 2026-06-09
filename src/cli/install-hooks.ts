import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function distHook(name: string): string {
  // dist/cli/install-hooks.js -> dist/hooks/<name>.js
  return path.resolve(__dirname, "..", "hooks", name).replace(/\\/g, "/");
}

function commandFor(scriptPath: string): string {
  return `node "${scriptPath}"`;
}

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

function ensureHook(settings: any, event: string, command: string): boolean {
  settings.hooks = settings.hooks || {};
  const groups: HookGroup[] = settings.hooks[event] || [];
  const already = groups.some((g) => g.hooks?.some((h) => h.command === command));
  if (already) return false;
  groups.push({ hooks: [{ type: "command", command }] });
  settings.hooks[event] = groups;
  return true;
}

function main(): void {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");

  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (e) {
      console.error(`Refusing to touch unparseable settings.json: ${(e as Error).message}`);
      process.exit(1);
    }
    const backup = `${settingsPath}.bak-${Date.now()}`;
    fs.copyFileSync(settingsPath, backup);
    console.log(`Backed up existing settings to ${backup}`);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }

  const stopCmd = commandFor(distHook("stop-hook.js"));
  const promptCmd = commandFor(distHook("prompt-hook.js"));

  const addedStop = ensureHook(settings, "Stop", stopCmd);
  const addedPrompt = ensureHook(settings, "UserPromptSubmit", promptCmd);

  if (!addedStop && !addedPrompt) {
    console.log("Hooks already installed — nothing to do.");
    return;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`Updated ${settingsPath}`);
  if (addedStop) console.log(`  + Stop:             ${stopCmd}`);
  if (addedPrompt) console.log(`  + UserPromptSubmit: ${promptCmd}`);
  console.log("\nRestart Claude Code sessions to pick up the new hooks.");
}

main();
