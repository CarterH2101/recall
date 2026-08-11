import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shimPath } from "../lib/install.js";

// Opt-in login autostart for the daemon. Always targets the stable shim —
// never a node-version-manager path that breaks on upgrades.

const TASK_NAME = "recalld";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", "dev.recall.recalld.plist");
const UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const UNIT = path.join(UNIT_DIR, "recalld.service");

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

function enable(): void {
  const shim = shimPath("recalld");
  if (!fs.existsSync(shim)) {
    console.error("Shim missing — run `recalld setup` first.");
    process.exit(1);
  }

  if (process.platform === "win32") {
    const r = sh("schtasks", [
      "/Create",
      "/TN",
      TASK_NAME,
      "/SC",
      "ONLOGON",
      "/TR",
      `"\\"${shim}\\" daemon"`,
      "/F",
    ]);
    if (r.ok) {
      console.log(`Scheduled task "${TASK_NAME}" created (runs at logon).`);
    } else {
      // ONLOGON can require elevation on some setups — fall back to the
      // per-user Startup folder.
      const startup = path.join(
        os.homedir(),
        "AppData",
        "Roaming",
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
        "recalld.cmd",
      );
      fs.writeFileSync(startup, `@echo off\r\nstart "" /min "${shim}" daemon\r\n`);
      console.log(`schtasks failed (${r.out.trim()}); wrote Startup entry instead: ${startup}`);
    }
    return;
  }

  if (process.platform === "darwin") {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(
      PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.recall.recalld</string>
  <key>ProgramArguments</key><array><string>${shim}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`,
    );
    sh("launchctl", ["unload", PLIST]);
    const r = sh("launchctl", ["load", "-w", PLIST]);
    console.log(r.ok ? `LaunchAgent loaded: ${PLIST}` : `Wrote ${PLIST}; load failed: ${r.out.trim()}`);
    return;
  }

  // Linux
  if (!sh("systemctl", ["--user", "--version"]).ok) {
    console.log(
      `No systemd user session detected. Start the daemon from your init system with:\n  ${shim} daemon`,
    );
    return;
  }
  fs.mkdirSync(UNIT_DIR, { recursive: true });
  fs.writeFileSync(
    UNIT,
    `[Unit]
Description=recalld — local-first memory daemon

[Service]
ExecStart=${shim} daemon
Restart=on-failure

[Install]
WantedBy=default.target
`,
  );
  sh("systemctl", ["--user", "daemon-reload"]);
  const r = sh("systemctl", ["--user", "enable", "--now", "recalld"]);
  console.log(r.ok ? `systemd user unit enabled: ${UNIT}` : `Wrote ${UNIT}; enable failed: ${r.out.trim()}`);
}

function disable(): void {
  if (process.platform === "win32") {
    sh("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
    const startup = path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "recalld.cmd",
    );
    try {
      fs.unlinkSync(startup);
    } catch {
      /* not present */
    }
    console.log("Autostart removed.");
    return;
  }
  if (process.platform === "darwin") {
    sh("launchctl", ["unload", "-w", PLIST]);
    try {
      fs.unlinkSync(PLIST);
    } catch {
      /* not present */
    }
    console.log("LaunchAgent removed.");
    return;
  }
  sh("systemctl", ["--user", "disable", "--now", "recalld"]);
  try {
    fs.unlinkSync(UNIT);
  } catch {
    /* not present */
  }
  sh("systemctl", ["--user", "daemon-reload"]);
  console.log("systemd user unit removed.");
}

export function run(argv: string[]): void {
  const mode = argv[0];
  if (mode === "on") return enable();
  if (mode === "off") return disable();
  console.log("Usage: recalld autostart on|off");
  process.exit(1);
}
