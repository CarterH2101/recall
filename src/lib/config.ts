import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

/**
 * A cwd prefix that collapses to a single project label. Lets many code
 * subfolders under one root (e.g. a "Projects" dir) share one memory bucket
 * instead of fragmenting into a project-per-folder.
 */
export interface ProjectRoot {
  root: string; // normalized: forward slashes, no trailing slash, lowercased
  label: string;
}

export interface Config {
  projectRoots: ProjectRoot[];
}

/** Normalize a path for prefix comparison: forward slashes, no trailing slash, lowercased. */
export function normPath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function parseEnvRoots(raw: string | undefined): ProjectRoot[] {
  if (!raw) return [];
  // Format: "C:/path/one=label1;C:/path/two=label2"
  return raw
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const i = e.lastIndexOf("=");
      if (i < 0) return null;
      const root = normPath(e.slice(0, i).trim());
      const label = e.slice(i + 1).trim();
      return root && label ? { root, label } : null;
    })
    .filter((x): x is ProjectRoot => x !== null);
}

let _cache: Config | null = null;

/**
 * Load config from ~/.recall/config.json (override path: RECALL_DB_PATH's dir),
 * merged with the RECALL_PROJECT_ROOTS env override. Cached after first read;
 * tolerant of a missing or malformed file (returns empty config).
 */
export function loadConfig(): Config {
  if (_cache) return _cache;
  let fileRoots: ProjectRoot[] = [];
  try {
    const file = path.join(dataDir(), "config.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(raw?.projectRoots)) {
      fileRoots = raw.projectRoots
        .filter((r: any) => r && typeof r.root === "string" && typeof r.label === "string")
        .map((r: any) => ({ root: normPath(r.root), label: r.label }));
    }
  } catch {
    // no config file, or unreadable — fall back to env / defaults
  }
  const envRoots = parseEnvRoots(process.env.RECALL_PROJECT_ROOTS);
  // env entries win on conflict; longest root first so the most specific match applies.
  const merged = [...fileRoots, ...envRoots].sort((a, b) => b.root.length - a.root.length);
  _cache = { projectRoots: merged };
  return _cache;
}

/** Test/maintenance hook: drop the cached config so the next load re-reads. */
export function resetConfigCache(): void {
  _cache = null;
}
