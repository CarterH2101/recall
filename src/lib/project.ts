import { loadConfig, normPath } from "./config.js";

/**
 * Map a session's cwd to a project label. If the cwd falls under a configured
 * project root (see config.ts / RECALL_PROJECT_ROOTS), it collapses to that
 * root's label so many code subfolders share one memory bucket. Otherwise the
 * label is the cwd's basename. Adapter-neutral: every source uses this.
 */
export function deriveProject(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const norm = normPath(cwd);
  for (const { root, label } of loadConfig().projectRoots) {
    if (norm === root || norm.startsWith(root + "/")) return label;
  }
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return base || null;
}
