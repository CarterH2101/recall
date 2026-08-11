import { getDb } from "../lib/db.js";
import { deriveProject } from "../lib/transcript.js";

// Maintenance: recompute every session's project label from its cwd (so a new
// project-root config takes effect on already-captured data) and optionally
// prune sessions whose cwd matches junk substrings.
//
//   recall-reproject              # dry run: show what would change
//   recall-reproject --apply      # write the changes
//   RECALL_PRUNE_CWD="\\.claude\\,\\AppData\\" recall-reproject --apply
//
// RECALL_PRUNE_CWD is a comma-separated list of case-insensitive substrings;
// any session whose cwd contains one is deleted along with its turns + vectors.

function pruneSubstrings(): string[] {
  return (process.env.RECALL_PRUNE_CWD || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const db = getDb();
  const prune = pruneSubstrings();

  const sessions = db
    .prepare(`SELECT id, cwd, project FROM sessions`)
    .all() as { id: string; cwd: string | null; project: string | null }[];

  const toPrune: string[] = [];
  const toRelabel: { id: string; from: string | null; to: string | null }[] = [];

  for (const s of sessions) {
    const cwdLower = (s.cwd || "").toLowerCase();
    if (prune.length && prune.some((p) => cwdLower.includes(p))) {
      toPrune.push(s.id);
      continue;
    }
    const next = deriveProject(s.cwd);
    if (next !== s.project) toRelabel.push({ id: s.id, from: s.project, to: next });
  }

  // Summaries
  const relabelCounts = new Map<string, number>();
  for (const r of toRelabel) {
    const key = `${r.from ?? "(none)"} -> ${r.to ?? "(none)"}`;
    relabelCounts.set(key, (relabelCounts.get(key) || 0) + 1);
  }

  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${sessions.length} sessions scanned`);
  console.log(`\nRelabel (${toRelabel.length} sessions):`);
  for (const [k, n] of [...relabelCounts].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(3)}  ${k}`);

  let pruneTurns = 0;
  if (toPrune.length) {
    const placeholders = toPrune.map(() => "?").join(",");
    pruneTurns = (
      db
        .prepare(`SELECT COUNT(*) n FROM turns WHERE session_id IN (${placeholders})`)
        .get(...toPrune) as { n: number }
    ).n;
  }
  console.log(`\nPrune (${toPrune.length} sessions, ${pruneTurns} turns):`);
  for (const id of toPrune) {
    const s = sessions.find((x) => x.id === id)!;
    console.log(`  ${s.cwd}`);
  }

  if (!apply) {
    console.log(`\nDry run only. Re-run with --apply to write changes.`);
    return;
  }

  const run = db.transaction(() => {
    const setProject = db.prepare(`UPDATE sessions SET project = ? WHERE id = ?`);
    for (const r of toRelabel) setProject.run(r.to, r.id);

    if (toPrune.length) {
      const placeholders = toPrune.map(() => "?").join(",");
      // Delete vectors first (keyed by turn rowid), then turns, then sessions.
      const rows = db
        .prepare(`SELECT rowid FROM turns WHERE session_id IN (${placeholders})`)
        .all(...toPrune) as { rowid: number }[];
      const delVec = db.prepare(`DELETE FROM vec_turns WHERE rowid = ?`);
      for (const r of rows) delVec.run(r.rowid);
      db.prepare(`DELETE FROM turns WHERE session_id IN (${placeholders})`).run(...toPrune);
      db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...toPrune);
    }
  });
  run();

  console.log(
    `\nDone. Relabeled ${toRelabel.length} sessions, pruned ${toPrune.length} sessions / ${pruneTurns} turns.`,
  );
}

main();
