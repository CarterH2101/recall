import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getOrCreateToken } from "../lib/token.js";
import { dbPath } from "../lib/paths.js";
import { health, spawnDaemon, ensureCurrentDaemon, daemonPort } from "../daemon/client.js";
import {
  appDir,
  installRuntime,
  runningFromApp,
  runtimeEntry,
  writeManifest,
  writeShims,
} from "../lib/install.js";
import { VERSION } from "../lib/version.js";

// One-command setup. Installs the heavy runtime into ~/.recall/app (a path
// that outlives npx caches and node version managers), writes hook shims,
// registers Claude Code hooks, backfills history, and starts the daemon.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function step(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function preflight(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 11)) {
    console.error(`recall needs Node >= 20.11 (you have ${process.versions.node}).`);
    process.exit(1);
  }
  if (
    (process.platform === "win32" && process.arch === "arm64") ||
    (process.platform === "linux" && fs.existsSync("/etc/alpine-release"))
  ) {
    console.error(
      `Unsupported platform (${process.platform}/${process.arch}): the sqlite-vec\n` +
        `extension has no prebuilt binary here yet. Sorry — tracking upstream.`,
    );
    process.exit(1);
  }
}

/** Package root of the currently running code (…/dist/cli -> package root). */
function selfPackageRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

export async function run(argv: string[]): Promise<void> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const fromIdx = argv.indexOf("--from");
  const fromSpec = fromIdx >= 0 ? argv[fromIdx + 1] : null;
  const runtimeOnly = flags.has("--runtime-only");

  console.log(`recall setup v${VERSION} — local-first memory for your coding agents.`);
  console.log(
    "Everything runs on your machine: the runtime (~550MB of dependencies, mostly the\n" +
      "local embedding engine) installs to ~/.recall/app, and a ~130MB embedding model\n" +
      "downloads on first index. Nothing is uploaded anywhere.",
  );

  preflight();

  step("1/4 Runtime: installing to ~/.recall/app");
  if (runningFromApp()) {
    console.log("Already running from the installed runtime — skipping.");
    writeManifest();
  } else {
    // Prefer the published package; fall back to installing this checkout
    // (dev / pre-publish). --install-links copies instead of symlinking so
    // the runtime survives the source disappearing (npx cache eviction).
    const spec = fromSpec ?? `recalld@${VERSION}`;
    let ok = installRuntime(spec);
    if (!ok && !fromSpec) {
      console.log(`Could not install ${spec} from npm — installing from this copy instead.`);
      ok = installRuntime(selfPackageRoot());
    }
    if (!ok || !fs.existsSync(runtimeEntry("dist", "cli", "main.js"))) {
      console.error("Runtime install failed — see npm output above.");
      process.exit(1);
    }
    writeManifest();
  }

  step("2/4 Shims: stable hook entrypoints in ~/.recall/bin");
  writeShims();
  console.log("Shims written (rewritten on every setup — hook paths never change).");

  if (runtimeOnly) {
    console.log("\n--runtime-only: skipping Claude Code settings.json hooks (plugin owns them).");
  } else {
    step("3/4 Hooks: registering capture + auto-recall in Claude Code");
    const hooks = await import("./install-hooks.js");
    hooks.run();
  }

  if (!flags.has("--no-backfill")) {
    step("4/4 Backfill: indexing your existing transcripts");
    console.log("(first run downloads the ~130MB embedding model, one time)");
    const r = spawnSync(
      process.execPath,
      [runtimeEntry("dist", "cli", "main.js"), "backfill"],
      { stdio: "inherit" },
    );
    if (r.status !== 0) {
      console.error("Backfill failed — you can re-run later with: recalld backfill");
    }
  }

  // Daemon: replace a stale version if one is up, else start fresh.
  await ensureCurrentDaemon();
  if (!(await health(500))) {
    spawnDaemon();
    for (let i = 0; i < 30; i++) {
      if (await health(400)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log((await health(400)) ? "\nrecalld is up." : "\nrecalld is warming up — ready shortly.");

  const token = getOrCreateToken();
  console.log(`
Done. Your agent now has memory.

  DB:        ${dbPath()}
  Runtime:   ${appDir()}
  Daemon:    http://127.0.0.1:${daemonPort()}
  API token: ${token}   (only needed for non-localhost clients, e.g. the Siri shortcut)

Next:
  - Restart your Claude Code sessions to activate the hooks.
  - recalld status | recalld doctor   — health checks
  - recalld autostart on              — start the daemon at login (optional)
  - Optional: register the MCP server in other agents:
      node "${runtimeEntry("dist", "mcp", "server.js").replace(/\\/g, "/")}"
  - Optional: voice access via Siri — see docs/siri.md
  - Kill switch: set RECALL_ENABLED=false to disable auto-inject.
`);
  process.exit(0);
}
