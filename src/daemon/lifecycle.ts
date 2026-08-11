import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../lib/paths.js";
import { SERVICE } from "../lib/version.js";

export interface DaemonInfo {
  service: string;
  version: string;
  pid: number;
  port: number;
  startedAt: string;
}

export function daemonInfoPath(): string {
  return path.join(dataDir(), "daemon.json");
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(daemonInfoPath(), "utf8"));
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(daemonInfoPath(), JSON.stringify(info, null, 2));
}

export function clearDaemonInfo(pid = process.pid): void {
  // Only remove our own record — a replacement daemon may have already
  // written a fresh one.
  const info = readDaemonInfo();
  if (info && info.pid !== pid) return;
  try {
    fs.unlinkSync(daemonInfoPath());
  } catch {
    /* already gone */
  }
}

/**
 * Ask whatever is listening on a port to identify itself. Returns the health
 * payload when it is a recalld daemon, null when the port is free, dead, or
 * occupied by a foreign process.
 */
export async function identify(port: number, timeoutMs = 500): Promise<DaemonInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    if (body?.service !== SERVICE) return null;
    return body as DaemonInfo;
  } catch {
    return null;
  }
}

/** Request a graceful shutdown of the daemon on a port. Best-effort. */
export async function requestShutdown(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
