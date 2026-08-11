import fs from "node:fs";
import net from "node:net";
import { readManifest, binDir, shimPath, runtimeEntry } from "../lib/install.js";
import { identify } from "../daemon/lifecycle.js";
import { daemonPort } from "../daemon/client.js";
import { dbPath, dataDir } from "../lib/paths.js";
import { settingsPath, isRecallHookCommand } from "./install-hooks.js";
import { VERSION } from "../lib/version.js";
import path from "node:path";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function portOccupied(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
  });
}

export async function run(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) =>
    checks.push({ name, ok, detail, fix });

  // Node version
  const [major, minor] = process.versions.node.split(".").map(Number);
  add(
    "node version",
    major > 20 || (major === 20 && minor >= 11),
    `v${process.versions.node}`,
    "install Node 20.11+",
  );

  // Data dir writable
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const probe = path.join(dataDir(), ".doctor-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    add("data dir writable", true, dataDir());
  } catch (e) {
    add("data dir writable", false, (e as Error).message, "check permissions on ~/.recall");
  }

  // Install manifest + runtime
  const manifest = readManifest();
  if (manifest) {
    add("install manifest", true, `v${manifest.version} (this CLI: v${VERSION})`);
    add(
      "recorded node exists",
      fs.existsSync(manifest.nodePath),
      manifest.nodePath,
      "re-run: recalld setup (rewrites shims with the current node)",
    );
    add(
      "runtime entry present",
      fs.existsSync(runtimeEntry("dist", "cli", "main.js")),
      runtimeEntry("dist", "cli", "main.js"),
      "re-run: recalld setup",
    );
  } else {
    add("install manifest", false, "missing", "run: recalld setup");
  }

  // Shims
  for (const name of ["recall-stop-hook", "recall-prompt-hook"] as const) {
    const p = shimPath(name);
    add(`shim ${name}`, fs.existsSync(p), p, "re-run: recalld setup");
  }

  // Claude Code hooks
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    const cmds: string[] = [];
    for (const groups of Object.values<any>(settings.hooks ?? {})) {
      for (const g of groups as any[]) for (const h of g.hooks ?? []) cmds.push(h.command);
    }
    const ours = cmds.filter(isRecallHookCommand);
    const legacy = ours.filter((c) => /dist[\/\\]hooks[\/\\]/.test(c));
    const viaShim = ours.filter((c) => /[\/\\]\.recall[\/\\]bin[\/\\]/.test(c));
    add(
      "claude hooks registered",
      viaShim.length >= 2,
      `${viaShim.length} shim hook(s), ${legacy.length} legacy clone-path hook(s)`,
      "run: recalld install-hooks (registers shims, scrubs legacy entries)",
    );
    if (legacy.length) {
      add("no legacy hooks", false, legacy.join(" | "), "run: recalld install-hooks");
    }
    const dupes = ours.length !== new Set(ours).size;
    add("no duplicate hooks", !dupes, dupes ? "duplicates found" : "clean", "run: recalld install-hooks");
  } catch {
    add("claude hooks registered", false, `${settingsPath()} missing/unreadable`, "run: recalld setup");
  }

  // Daemon
  const port = daemonPort();
  const live = await identify(port, 800);
  if (live) {
    add("daemon reachable", true, `v${live.version} pid ${live.pid} port ${live.port}`);
    const expected = manifest?.version ?? VERSION;
    add(
      "daemon version current",
      live.version === expected,
      `daemon v${live.version}, installed v${expected}`,
      "it will self-heal on next hook; or: recalld update",
    );
  } else {
    const occupied = await portOccupied(port);
    if (occupied) {
      add(
        "daemon reachable",
        false,
        `port ${port} is occupied by a non-recalld process`,
        "recalld daemon will fall back to the next free port automatically; check daemon.json",
      );
    } else {
      add("daemon reachable", false, `nothing on port ${port}`, "it starts on the next hook; or: recalld daemon");
    }
  }

  // Database + sqlite-vec
  try {
    const { getDb } = await import("../lib/db.js");
    const db = getDb();
    const turns = (db.prepare(`SELECT COUNT(*) n FROM turns`).get() as any).n;
    add("database + sqlite-vec", true, `${dbPath()} (${turns} turns)`);
  } catch (e) {
    add("database + sqlite-vec", false, (e as Error).message, "platform may lack sqlite-vec prebuilds");
  }

  // Model cache
  const modelDir = process.env.RECALL_MODEL_DIR || path.join(dataDir(), "models");
  add(
    "embedding model cached",
    fs.existsSync(modelDir) && fs.readdirSync(modelDir).length > 0,
    modelDir,
    "downloads (~130MB) on first backfill/daemon start",
  );

  // Kill switch
  add(
    "auto-inject enabled",
    (process.env.RECALL_ENABLED ?? "true") !== "false",
    `RECALL_ENABLED=${process.env.RECALL_ENABLED ?? "(unset, default true)"}`,
    "unset RECALL_ENABLED or set it to true",
  );

  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    console.log(`${mark} ${c.name.padEnd(26)} ${c.detail}`);
    if (!c.ok && c.fix) {
      console.log(`  ${" ".repeat(26)} fix: ${c.fix}`);
      failed++;
    }
  }
  console.log(failed ? `\n${failed} issue(s) found.` : "\nAll good.");
  process.exitCode = failed ? 1 : 0;
}
