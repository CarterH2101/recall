import path from "node:path";
import { ingest } from "../lib/ingest.js";
import { warmup } from "../lib/embed.js";
import { getAdapter, enabledAdapters } from "../lib/sources/registry.js";
import type { SourceAdapter } from "../lib/sources/types.js";
import { mergeCounts } from "../lib/redact.js";

// recalld backfill [--source claude-code|codex|all]
// Default remains claude-code (matches pre-adapter behavior).

function pickAdapters(argv: string[]): SourceAdapter[] {
  const i = argv.indexOf("--source");
  const name = i >= 0 ? argv[i + 1] : "claude-code";
  if (name === "all") return enabledAdapters();
  const a = getAdapter(name);
  if (!a) {
    console.error(`Unknown source "${name}". Known: claude-code, codex, all`);
    process.exit(1);
  }
  return [a];
}

async function main(): Promise<void> {
  const adapters = pickAdapters(process.argv.slice(2));

  console.log("Warming embedding model (first run downloads ~130MB)...");
  await warmup();

  for (const adapter of adapters) {
    const files = adapter.discover();
    console.log(`\n[${adapter.name}] ${files.length} transcript files`);
    if (!files.length) continue;

    let totalNew = 0;
    let totalLines = 0;
    const redactions: Record<string, number> = {};
    const t0 = Date.now();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const r = await ingest(f, adapter);
        totalNew += r.newTurns;
        totalLines += r.scannedLines;
        mergeCounts(redactions, r.redactions);
        if (r.newTurns) {
          console.log(`[${i + 1}/${files.length}] +${r.newTurns} turns  ${path.basename(f)}`);
        }
      } catch (err) {
        console.error(`[${i + 1}/${files.length}] ERROR ${f}: ${(err as Error).message}`);
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const redTotal = Object.values(redactions).reduce((a, b) => a + b, 0);
    console.log(
      `[${adapter.name}] done: ${totalNew} new turns from ${totalLines} lines across ${files.length} files in ${secs}s`,
    );
    if (redTotal) {
      const detail = Object.entries(redactions)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      console.log(`[${adapter.name}] redacted ${redTotal} secret(s) before storage (${detail})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
