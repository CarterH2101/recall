import { runDistill } from "../lib/distill.js";

// recalld distill [--apply] [--max N] [--project P]
// Dry-run by default: review the candidate→fact table before writing.

export async function run(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply");
  const maxIdx = argv.indexOf("--max");
  const projIdx = argv.indexOf("--project");
  const max = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 50;
  const project = projIdx >= 0 ? argv[projIdx + 1] : undefined;

  if (!apply) console.log("(dry run — pass --apply to write facts)\n");
  const r = await runDistill({ apply, max, project });

  for (const row of r.rows) {
    console.log(`[${row.action}] (${row.kind}) ${row.content.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  console.log(
    `\nexamined ${r.examined} candidate turns → ${r.promoted} promoted, ${r.merged} merged, ${r.skipped} skipped` +
      (r.nearDuplicates ? `, ${r.nearDuplicates} flagged near-duplicate` : ""),
  );
  if (!apply && r.promoted) console.log("Re-run with --apply to write these facts.");
}
