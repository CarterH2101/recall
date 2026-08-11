import fs from "node:fs";
import { appDir, binDir, manifestPath, recallHome } from "../lib/install.js";
import { daemonPort } from "../daemon/client.js";
import { identify, requestShutdown } from "../daemon/lifecycle.js";
import { settingsPath, scrubRecallHooks } from "./install-hooks.js";

export async function run(argv: string[]): Promise<void> {
  const purge = argv.includes("--purge");

  // 1. Hooks out of Claude Code settings (with the usual backup).
  const file = settingsPath();
  if (fs.existsSync(file)) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, "utf8"));
      const backup = `${file}.bak-${Date.now()}`;
      fs.copyFileSync(file, backup);
      const removed = scrubRecallHooks(settings);
      fs.writeFileSync(file, JSON.stringify(settings, null, 2));
      console.log(`Removed ${removed.length} hook entr${removed.length === 1 ? "y" : "ies"} (backup: ${backup})`);
    } catch (e) {
      console.error(`Could not edit ${file}: ${(e as Error).message} — remove recall hooks manually.`);
    }
  }

  // 2. Autostart off (best-effort).
  try {
    const auto = await import("./autostart.js");
    auto.run(["off"]);
  } catch {
    /* nothing installed */
  }

  // 3. Stop the daemon.
  if (await identify(daemonPort(), 500)) {
    await requestShutdown(daemonPort());
    console.log("Daemon stopped.");
  }

  // 4. Remove runtime + shims + manifest.
  for (const dir of [appDir(), binDir()]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Removed ${dir}`);
    } catch {
      /* not present */
    }
  }
  try {
    fs.unlinkSync(manifestPath());
  } catch {
    /* not present */
  }

  // 5. Data: only with explicit consent.
  if (purge) {
    fs.rmSync(recallHome(), { recursive: true, force: true });
    console.log(`Removed ${recallHome()} (memory database included).`);
  } else {
    console.log(
      `\nYour memory database was kept at ${recallHome()}.\n` +
        `Run \`recalld uninstall --purge\` (before uninstalling the package) or delete the folder to remove it.`,
    );
  }
}
