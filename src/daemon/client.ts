import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDaemonInfo, identify, requestShutdown } from "./lifecycle.js";
import { readManifest, runtimeEntry } from "../lib/install.js";
import { VERSION } from "../lib/version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where the daemon lives right now: explicit env wins, then the port the
 * daemon advertised in daemon.json (it may have fallen back off 4319), then
 * the default.
 */
export function daemonPort(): number {
  if (process.env.RECALL_PORT) return Number(process.env.RECALL_PORT);
  const info = readDaemonInfo();
  if (info?.port) return info.port;
  return 4319;
}

function base(): string {
  return `http://127.0.0.1:${daemonPort()}`;
}

export async function health(timeoutMs = 400): Promise<boolean> {
  return (await identify(daemonPort(), timeoutMs)) !== null;
}

/**
 * Resolve the daemon entry script. Prefer the stable ~/.recall/app runtime
 * (works from plugin bundles, which have no adjacent server.js); fall back to
 * the sibling file for clone/dev installs.
 */
function serverEntry(): string | null {
  if (readManifest()) {
    const installed = runtimeEntry("dist", "daemon", "server.js");
    if (fs.existsSync(installed)) return installed;
  }
  const sibling = path.join(__dirname, "server.js");
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

/** Start the daemon detached so it outlives this short-lived hook process. */
export function spawnDaemon(): void {
  const entry = serverEntry();
  if (!entry) return; // plugin bundle with no runtime installed yet — fail open
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

/**
 * Make sure the reachable daemon matches the installed runtime version; ask a
 * stale one to shut down and respawn. Compares against the install manifest,
 * not this module's own compiled version — a plugin bundle may be older or
 * newer than the runtime it launches, and must not thrash the daemon over it.
 * Used by non-latency-critical callers (stop hook, CLI) — the prompt hook
 * stays on the fast fail-open path.
 */
export async function ensureCurrentDaemon(timeoutMs = 500): Promise<void> {
  const info = await identify(daemonPort(), timeoutMs);
  if (!info) {
    spawnDaemon();
    return;
  }
  const expected = readManifest()?.version ?? VERSION;
  if (info.version !== expected) {
    await requestShutdown(info.port);
    await sleep(500);
    spawnDaemon();
  }
}

async function post(pathname: string, body: unknown, timeoutMs: number): Promise<any | null> {
  try {
    const res = await fetch(`${base()}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Recall for the prompt hook. Never blocks on a cold start: if the daemon is
 * down we fire it up for next time and fail open (return null) right now.
 */
export async function recallRemote(
  query: string,
  opts: { excludeSessionId?: string; project?: string; limit?: number; minScore?: number; source?: string },
  timeoutMs = 800,
): Promise<any[] | null> {
  const r = await post("/recall", { query, ...opts }, timeoutMs);
  if (r === null) {
    spawnDaemon();
    return null;
  }
  return r.snippets ?? [];
}

/**
 * Ingest for the stop hook. Tries the daemon; if it's down or stale, spawns
 * the current version, waits for it, and retries once.
 */
export async function ingestRemote(transcriptPath: string): Promise<any | null> {
  await ensureCurrentDaemon();
  let r = await post("/ingest", { transcriptPath }, 5000);
  if (r !== null) return r;

  spawnDaemon();
  for (let i = 0; i < 30; i++) {
    if (await health(300)) break;
    await sleep(500);
  }
  return post("/ingest", { transcriptPath }, 30000);
}
