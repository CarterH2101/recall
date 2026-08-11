import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

// Install layout. Hooks in ~/.claude/settings.json must reference a path that
// survives npx cache eviction, npm-prefix moves, and node-version-manager
// switches — so the runtime lives at a fixed location (~/.recall/app) and
// hooks go through shims in ~/.recall/bin that are rewritten on every setup.
// These paths are deliberately independent of RECALL_DB_PATH: data can move,
// the installation does not.

export function recallHome(): string {
  return path.join(os.homedir(), ".recall");
}

export function appDir(): string {
  return path.join(recallHome(), "app");
}

export function binDir(): string {
  return path.join(recallHome(), "bin");
}

export function manifestPath(): string {
  return path.join(recallHome(), "install.json");
}

/** Path inside the installed runtime package. */
export function runtimeEntry(...p: string[]): string {
  return path.join(appDir(), "node_modules", "recalld", ...p);
}

export interface InstallManifest {
  version: string;
  nodePath: string;
  appDir: string;
  installedAt: string;
}

export function readManifest(): InstallManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
  } catch {
    return null;
  }
}

export function writeManifest(version?: string): void {
  fs.mkdirSync(recallHome(), { recursive: true });
  // Record the version actually installed in appDir when it exists — the
  // running CLI (npx copy, plugin) may be a different release.
  let installed = version ?? VERSION;
  try {
    installed = JSON.parse(fs.readFileSync(runtimeEntry("package.json"), "utf8")).version;
  } catch {
    /* runtime not present (dev) — fall back to our own version */
  }
  const m: InstallManifest = {
    version: installed,
    nodePath: process.execPath,
    appDir: appDir(),
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
}

/** True when this code is executing from the ~/.recall/app runtime copy. */
export function runningFromApp(): boolean {
  const here = fileURLToPath(import.meta.url);
  return here.toLowerCase().startsWith(appDir().toLowerCase() + path.sep);
}

/**
 * Install (or update) the runtime into ~/.recall/app. `spec` is an npm
 * install spec: "recalld@0.1.0" normally, or a local directory path for
 * development installs (`recalld setup --from <repo>`).
 */
export function installRuntime(spec = `recalld@${VERSION}`): boolean {
  fs.mkdirSync(appDir(), { recursive: true });
  // --install-links: directory specs are copied, not symlinked, so the
  // runtime survives its install source disappearing (npx cache eviction).
  const r = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--prefix",
      appDir(),
      "--install-links",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      spec,
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  return r.status === 0;
}

function shimTargets(): { name: string; entry: string }[] {
  return [
    { name: "recall-stop-hook", entry: runtimeEntry("dist", "hooks", "stop-hook.js") },
    { name: "recall-prompt-hook", entry: runtimeEntry("dist", "hooks", "prompt-hook.js") },
    { name: "recalld", entry: runtimeEntry("dist", "cli", "main.js") },
  ];
}

/**
 * Write the stable shims. Content resolves the node recorded at setup time,
 * falling back to `node` on PATH (survives nvm/fnm upgrades that delete the
 * recorded binary).
 */
export function writeShims(nodePath = process.execPath): void {
  fs.mkdirSync(binDir(), { recursive: true });
  for (const { name, entry } of shimTargets()) {
    const posixEntry = entry.replace(/\\/g, "/");
    const cmd = [
      "@echo off",
      `if exist "${nodePath}" (`,
      `  "${nodePath}" "${entry}" %*`,
      `) else (`,
      `  node "${entry}" %*`,
      `)`,
      "",
    ].join("\r\n");
    fs.writeFileSync(path.join(binDir(), `${name}.cmd`), cmd);

    const sh = [
      "#!/bin/sh",
      `NODE="${nodePath.replace(/\\/g, "/")}"`,
      `[ -x "$NODE" ] || NODE=node`,
      `exec "$NODE" "${posixEntry}" "$@"`,
      "",
    ].join("\n");
    const shPath = path.join(binDir(), `${name}.sh`);
    fs.writeFileSync(shPath, sh);
    try {
      fs.chmodSync(shPath, 0o755);
    } catch {
      /* windows */
    }
  }
}

/** The shim path an installed hook command should reference. */
export function shimPath(name: "recall-stop-hook" | "recall-prompt-hook" | "recalld"): string {
  const ext = process.platform === "win32" ? ".cmd" : ".sh";
  return path.join(binDir(), `${name}${ext}`);
}
