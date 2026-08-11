import fs from "node:fs";
import path from "node:path";
import { ingest } from "../lib/ingest.js";
import { enabledAdapters } from "../lib/sources/registry.js";
import type { SourceAdapter } from "../lib/sources/types.js";

// Daemon-side capture for sources without a push hook (Codex writes rollout
// files; nothing tells us when). Watch the session tree, debounce per file,
// and reuse the byte-cursor ingest — double events are harmless by design.

const DEBOUNCE_MS = 2000;
const CATCHUP_DAYS = 7;
const POLL_MS = 60_000;

const timers = new Map<string, NodeJS.Timeout>();
let queue: Promise<void> = Promise.resolve();
const unparseable = new Map<string, number>();

function enqueue(filePath: string, adapter: SourceAdapter): void {
  // Serialize ingests: embedding is the bottleneck and SQLite writes want one
  // writer at a time.
  queue = queue
    .then(async () => {
      const r = await ingest(filePath, adapter);
      if (r.newTurns) {
        console.error(`[watch:${adapter.name}] +${r.newTurns} turns ${path.basename(filePath)}`);
      }
    })
    .catch((e) => {
      const n = (unparseable.get(filePath) ?? 0) + 1;
      unparseable.set(filePath, n);
      // A sudden spike here is the format-drift alarm.
      console.error(`[watch:${adapter.name}] ingest error (${n}x) ${filePath}: ${e.message}`);
    });
}

function debounced(filePath: string, adapter: SourceAdapter): void {
  const existing = timers.get(filePath);
  if (existing) clearTimeout(existing);
  timers.set(
    filePath,
    setTimeout(() => {
      timers.delete(filePath);
      enqueue(filePath, adapter);
    }, DEBOUNCE_MS),
  );
}

function catchUp(adapter: SourceAdapter): void {
  const cutoff = Date.now() - CATCHUP_DAYS * 24 * 3600 * 1000;
  for (const f of adapter.discover()) {
    try {
      if (fs.statSync(f).mtimeMs >= cutoff) enqueue(f, adapter);
    } catch {
      /* raced deletion */
    }
  }
}

function watchRoot(root: string, adapter: SourceAdapter): boolean {
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = path.basename(String(filename));
      if (!/^rollout-.*\.jsonl$/.test(name) && !name.endsWith(".jsonl")) return;
      debounced(path.join(root, String(filename)), adapter);
    });
    watcher.on("error", (e) => console.error(`[watch:${adapter.name}] watcher died: ${e.message}`));
    return true;
  } catch (e) {
    return false;
  }
}

/** Poll fallback for filesystems where recursive fs.watch throws. */
function pollRoot(adapter: SourceAdapter): void {
  const seen = new Map<string, number>();
  setInterval(() => {
    for (const f of adapter.discover()) {
      try {
        const m = fs.statSync(f).mtimeMs;
        if ((seen.get(f) ?? 0) < m) {
          seen.set(f, m);
          enqueue(f, adapter);
        }
      } catch {
        /* raced deletion */
      }
    }
  }, POLL_MS).unref();
}

export function startWatchers(): void {
  for (const adapter of enabledAdapters()) {
    const roots = adapter.watchRoots();
    if (!roots.length) continue;
    catchUp(adapter);
    for (const root of roots) {
      if (watchRoot(root, adapter)) {
        console.error(`[recalld] watching ${root} (${adapter.name})`);
      } else {
        console.error(`[recalld] recursive watch unavailable for ${root}; polling every ${POLL_MS / 1000}s`);
        pollRoot(adapter);
      }
    }
  }
}
