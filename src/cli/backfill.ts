import fs from "node:fs";
import path from "node:path";
import { claudeProjectsDir } from "../lib/paths.js";
import { ingest } from "../lib/ingest.js";
import { warmup } from "../lib/embed.js";

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(full));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const root = claudeProjectsDir();
  const files = walkJsonl(root);
  console.log(`Found ${files.length} transcript files under ${root}`);
  if (!files.length) return;

  console.log("Warming embedding model (first run downloads ~130MB)...");
  await warmup();

  let totalNew = 0;
  let totalLines = 0;
  const t0 = Date.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const r = await ingest(f);
      totalNew += r.newTurns;
      totalLines += r.scannedLines;
      if (r.newTurns) {
        console.log(`[${i + 1}/${files.length}] +${r.newTurns} turns  ${path.basename(f)}`);
      }
    } catch (err) {
      console.error(`[${i + 1}/${files.length}] ERROR ${f}: ${(err as Error).message}`);
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\nDone. ${totalNew} new turns from ${totalLines} lines across ${files.length} files in ${secs}s`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
