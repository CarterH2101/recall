import { getDb, vecBlob } from "../lib/db.js";
import { redact, mergeCounts } from "../lib/redact.js";

// recalld redact [--backfill|--dry-run]
// Retroactively cleans secrets from turns ingested before redaction existed.
// Rewrites content, re-embeds only rows that had a vector, and truncates the
// WAL + VACUUMs at the end so plaintext doesn't linger in freed pages.

const BATCH = 500;

export async function run(argv: string[]): Promise<void> {
  if (argv.includes("--reembed")) return reembedRedacted();
  const dry = argv.includes("--dry-run") || !argv.includes("--backfill");
  if (dry && !argv.includes("--dry-run")) {
    console.log("(defaulting to --dry-run; pass --backfill to write changes)\n");
  }

  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) n FROM turns`).get() as any).n;
  const totals: Record<string, number> = {};
  let affectedTurns = 0;
  let scanned = 0;

  const updateTurn = db.prepare(
    `UPDATE turns SET content = ?, redaction_count = redaction_count + ? WHERE rowid = ?`,
  );
  const hasVec = db.prepare(`SELECT 1 FROM vec_turns WHERE rowid = ?`);
  const toReembed: { rowid: number; content: string }[] = [];

  for (let off = 0; off < total; off += BATCH) {
    const rows = db
      .prepare(`SELECT rowid, content FROM turns ORDER BY rowid LIMIT ? OFFSET ?`)
      .all(BATCH, off) as { rowid: number; content: string }[];
    for (const row of rows) {
      scanned++;
      const r = redact(row.content);
      if (!r.count) continue;
      affectedTurns++;
      mergeCounts(totals, r.byRule);
      if (dry) continue;
      updateTurn.run(r.text, r.count, row.rowid);
      if (hasVec.get(row.rowid)) toReembed.push({ rowid: row.rowid, content: r.text });
    }
  }

  if (!dry && toReembed.length) {
    await reembedRows(db, toReembed);
  }

  if (!dry && affectedTurns) {
    console.log("Checkpointing WAL and vacuuming (removes plaintext from freed pages)...");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  }

  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  const detail = Object.entries(totals)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  console.log(
    `\n${dry ? "[dry-run] Would redact" : "Redacted"} ${grand} secret(s) across ${affectedTurns} of ${scanned} turns${detail ? ` (${detail})` : ""}.`,
  );
  if (dry && grand) console.log("Run again with --backfill to apply.");
}

async function reembedRows(
  db: ReturnType<typeof getDb>,
  rows: { rowid: number; content: string }[],
): Promise<void> {
  console.log(`Re-embedding ${rows.length} rewritten turns...`);
  const { embed } = await import("../lib/embed.js");
  const insertVec = db.prepare(`INSERT OR REPLACE INTO vec_turns (rowid, embedding) VALUES (?, ?)`);
  for (let i = 0; i < rows.length; i += 32) {
    const chunk = rows.slice(i, i + 32);
    const vecs = await embed(chunk.map((c) => c.content.slice(0, 1500)));
    const tx = db.transaction(() => {
      // vec0 virtual tables require strictly-INTEGER rowids — bind as BigInt.
      for (let j = 0; j < chunk.length; j++) insertVec.run(BigInt(chunk[j].rowid), vecBlob(vecs[j]));
    });
    tx();
  }
}

/**
 * Recovery/maintenance: re-embed every already-redacted turn that still has a
 * vector (e.g. after an interrupted --backfill), then checkpoint + VACUUM.
 */
async function reembedRedacted(): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.rowid, t.content FROM turns t
       JOIN vec_turns v ON v.rowid = t.rowid
       WHERE t.redaction_count > 0`,
    )
    .all() as { rowid: number; content: string }[];
  if (!rows.length) {
    console.log("No redacted turns with vectors — nothing to do.");
    return;
  }
  await reembedRows(db, rows);
  console.log("Checkpointing WAL and vacuuming...");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  console.log(`Re-embedded ${rows.length} redacted turns.`);
}
