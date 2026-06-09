import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.RECALL_PORT || 4319);
const BASE = `http://127.0.0.1:${PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function health(timeoutMs = 400): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the daemon detached so it outlives this short-lived hook process. */
export function spawnDaemon(): void {
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

async function post(pathname: string, body: unknown, timeoutMs: number): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}${pathname}`, {
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
  opts: { excludeSessionId?: string; project?: string; limit?: number; minScore?: number },
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
 * Ingest for the stop hook. Tries the daemon; if it's down, spawns it, waits
 * for the model to warm, and retries once.
 */
export async function ingestRemote(transcriptPath: string): Promise<any | null> {
  let r = await post("/ingest", { transcriptPath }, 5000);
  if (r !== null) return r;

  spawnDaemon();
  for (let i = 0; i < 30; i++) {
    if (await health(300)) break;
    await sleep(500);
  }
  return post("/ingest", { transcriptPath }, 30000);
}
