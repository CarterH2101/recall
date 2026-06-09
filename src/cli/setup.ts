import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOrCreateToken } from "../lib/token.js";
import { dbPath } from "../lib/paths.js";
import { health } from "../daemon/client.js";

// One-command beta setup: backfill -> install hooks -> start daemon -> status.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = (...p: string[]) => path.resolve(__dirname, "..", ...p);

function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function run(script: string): boolean {
  const r = spawnSync(process.execPath, [script], { stdio: "inherit" });
  return r.status === 0;
}

async function main(): Promise<void> {
  console.log("recall setup — local-first memory for your coding agents.");
  console.log("Everything below runs on your machine. Nothing is uploaded anywhere.");

  step("1/3 Backfill: indexing your existing Claude Code transcripts");
  console.log("(first run downloads the ~130MB embedding model, one time)");
  if (!run(dist("cli", "backfill.js"))) {
    console.error("Backfill failed — see output above. You can re-run with: npm run backfill");
    process.exit(1);
  }

  step("2/3 Hooks: registering capture + auto-recall in Claude Code");
  if (!run(dist("cli", "install-hooks.js"))) {
    console.error("Hook install failed — see output above.");
    process.exit(1);
  }

  step("3/3 Daemon: starting recalld");
  if (await health(500)) {
    console.log("recalld already running.");
  } else {
    const child = spawn(process.execPath, [dist("daemon", "server.js")], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 30; i++) {
      if (await health(400)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log((await health(400)) ? "recalld is up." : "recalld is warming up — it will be ready shortly.");
  }

  const token = getOrCreateToken();
  console.log(`
Done. Your agent now has memory.

  DB:        ${dbPath()}
  Daemon:    http://127.0.0.1:${process.env.RECALL_PORT || 4319}
  API token: ${token}   (only needed for non-localhost clients, e.g. the Siri shortcut)

Next:
  - Restart your Claude Code sessions to activate the hooks.
  - Optional: register the MCP server in other agents:
      node "${dist("mcp", "server.js")}"
  - Optional: voice access via Siri — see docs/siri.md
  - Kill switch: set RECALL_ENABLED=false to disable auto-inject.
`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
