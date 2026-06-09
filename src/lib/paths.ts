import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Root data dir for the local DB + cursor cache. Override via RECALL_DB_PATH. */
export function dataDir(): string {
  const dbPath = process.env.RECALL_DB_PATH;
  if (dbPath) return path.dirname(path.resolve(dbPath));
  return path.join(os.homedir(), ".recall");
}

export function dbPath(): string {
  return process.env.RECALL_DB_PATH
    ? path.resolve(process.env.RECALL_DB_PATH)
    : path.join(dataDir(), "memory.db");
}

export function cursorDir(): string {
  return path.join(dataDir(), "cursors");
}

/** Where Claude Code stores session transcripts. */
export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
