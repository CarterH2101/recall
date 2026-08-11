import fs from "node:fs";
import { readManifest, appDir, binDir } from "../lib/install.js";
import { readDaemonInfo, identify } from "../daemon/lifecycle.js";
import { daemonPort } from "../daemon/client.js";
import { dbPath } from "../lib/paths.js";
import { VERSION } from "../lib/version.js";

export async function run(): Promise<void> {
  console.log(`recalld ${VERSION}\n`);

  const manifest = readManifest();
  if (manifest) {
    console.log(`Runtime:   v${manifest.version} at ${manifest.appDir}`);
    console.log(`Node:      ${manifest.nodePath}`);
  } else {
    console.log(`Runtime:   not installed (run: recalld setup)`);
  }
  console.log(`Shims:     ${fs.existsSync(binDir()) ? binDir() : "missing"}`);

  const live = await identify(daemonPort(), 800);
  if (live) {
    console.log(`Daemon:    up — v${live.version}, pid ${live.pid}, port ${live.port}, since ${live.startedAt}`);
  } else {
    const stale = readDaemonInfo();
    console.log(`Daemon:    down${stale ? ` (stale record: pid ${stale.pid}, port ${stale.port})` : ""}`);
  }

  if (fs.existsSync(dbPath())) {
    const sizeMb = (fs.statSync(dbPath()).size / 1024 / 1024).toFixed(1);
    try {
      const { getDb } = await import("../lib/db.js");
      const db = getDb();
      const sessions = (db.prepare(`SELECT COUNT(*) n FROM sessions`).get() as any).n;
      const turns = (db.prepare(`SELECT COUNT(*) n FROM turns`).get() as any).n;
      const vecs = (db.prepare(`SELECT COUNT(*) n FROM vec_turns`).get() as any).n;
      console.log(`Database:  ${dbPath()} (${sizeMb} MB) — ${sessions} sessions, ${turns} turns, ${vecs} embedded`);
    } catch (e) {
      console.log(`Database:  ${dbPath()} (${sizeMb} MB) — could not open: ${(e as Error).message}`);
    }
  } else {
    console.log(`Database:  none yet at ${dbPath()}`);
  }
  if (!manifest) console.log(`\nGet started: npx recalld setup   (installs to ${appDir()})`);
}
