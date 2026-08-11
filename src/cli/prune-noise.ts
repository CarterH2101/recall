import { getDb } from "../lib/db.js";
import { isLowSignal } from "../lib/signal.js";

// Maintenance: remove embeddings for already-ingested low-signal turns so
// narration fragments ("Updated", "Run all these") stop surfacing as matches.
// Turn rows are kept — they still serve as context expansion for neighbors.
//
//   recall-prune-noise           # dry run: report what would be pruned
//   recall-prune-noise --apply   # delete the vectors

function main(): void {
  const apply = process.argv.includes("--apply");
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT t.rowid, t.role, t.content FROM turns t
       WHERE EXISTS (SELECT 1 FROM vec_turns v WHERE v.rowid = t.rowid)`,
    )
    .all() as { rowid: number; role: string; content: string }[];

  const drop = rows.filter((r) => isLowSignal(r.role, r.content));
  const byRole = new Map<string, number>();
  for (const r of drop) byRole.set(r.role, (byRole.get(r.role) || 0) + 1);

  console.log(
    `${apply ? "APPLY" : "DRY RUN"} — ${rows.length} embedded turns scanned, ${drop.length} low-signal`,
  );
  for (const [role, n] of byRole) console.log(`  ${role}: ${n}`);

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to delete these embeddings.");
    return;
  }

  const delVec = db.prepare(`DELETE FROM vec_turns WHERE rowid = ?`);
  const run = db.transaction(() => {
    for (const r of drop) delVec.run(r.rowid);
  });
  run();
  console.log(`\nDone. Pruned ${drop.length} embeddings (turn rows retained).`);
}

main();
