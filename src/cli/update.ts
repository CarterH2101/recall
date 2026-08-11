import { installRuntime, writeManifest, writeShims, runtimeEntry } from "../lib/install.js";
import { ensureCurrentDaemon } from "../daemon/client.js";
import fs from "node:fs";

export async function run(): Promise<void> {
  console.log("Updating runtime in ~/.recall/app to recalld@latest ...");
  if (!installRuntime("recalld@latest") || !fs.existsSync(runtimeEntry("dist", "cli", "main.js"))) {
    console.error("Update failed — see npm output above.");
    process.exit(1);
  }
  writeManifest();
  writeShims();
  await ensureCurrentDaemon(); // stale daemon shuts down; fresh one spawns
  console.log("Updated. The daemon restarts with the new version automatically.");
}
