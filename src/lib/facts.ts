import { createHash, randomUUID } from "node:crypto";
import { getDb, vecBlob } from "./db.js";
import { embedOne } from "./embed.js";

// Durable distilled facts: short, editable, ranked above raw snippets at
// recall time. One row per fact; embeddings live in vec_facts (rowid-paired).

export type FactKind = "decision" | "gotcha" | "preference" | "reference";

export interface Fact {
  id: string;
  kind: FactKind;
  content: string;
  content_hash: string;
  source_turn_ids: string; // JSON array
  project: string | null;
  created_at: string;
  updated_at: string;
  pinned: number;
  archived: number;
  edited: number;
  origin: string;
}

export const MAX_FACT_CHARS = 500;
const MERGE_SIM = 0.92;
export const NEAR_DUP_SIM = 0.86;

/** Test hook: substitute the embedder (unit tests avoid the 130MB model). */
export type FactEmbedder = (text: string) => Promise<Float32Array>;
let _embed: FactEmbedder = (t) => embedOne(t.slice(0, 1500));
export function setFactEmbedder(fn: FactEmbedder | null): void {
  _embed = fn ?? ((t) => embedOne(t.slice(0, 1500)));
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex");
}

function rowidOf(id: string): number | null {
  const r = getDb().prepare(`SELECT rowid FROM facts WHERE id = ?`).get(id) as any;
  return r ? r.rowid : null;
}

export interface AddResult {
  action: "inserted" | "merged-exact" | "merged-similar" | "near-duplicate-inserted";
  id: string;
  similarTo?: string;
}

/**
 * Insert a fact with dedup/merge semantics:
 *  - exact content_hash match → merge (union sources, bump updated_at)
 *  - vec similarity >= 0.92  → merge into the existing fact; human-edited
 *    content is never clobbered
 *  - 0.86..0.92              → insert, flagged near-duplicate in the result
 */
export async function addFact(input: {
  kind: FactKind;
  content: string;
  project?: string | null;
  sourceTurnIds?: string[];
  origin?: "distill" | "manual" | "sync";
  pinned?: boolean;
}): Promise<AddResult> {
  const db = getDb();
  const content = input.content.trim().slice(0, MAX_FACT_CHARS);
  const hash = contentHash(content);
  const now = new Date().toISOString();

  const mergeInto = (existing: Fact, action: AddResult["action"]): AddResult => {
    const sources = new Set<string>(JSON.parse(existing.source_turn_ids));
    for (const s of input.sourceTurnIds ?? []) sources.add(s);
    db.prepare(`UPDATE facts SET source_turn_ids = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify([...sources]),
      now,
      existing.id,
    );
    return { action, id: existing.id };
  };

  const exact = db.prepare(`SELECT * FROM facts WHERE content_hash = ?`).get(hash) as
    | Fact
    | undefined;
  if (exact) return mergeInto(exact, "merged-exact");

  const vec = await _embed(content);
  const nearest = db
    .prepare(
      `SELECT rowid, distance FROM vec_facts WHERE embedding MATCH ? AND k = 3 ORDER BY distance`,
    )
    .all(vecBlob(vec)) as { rowid: number; distance: number }[];

  let nearDup: string | undefined;
  for (const n of nearest) {
    const sim = 1 - n.distance;
    const row = db.prepare(`SELECT * FROM facts WHERE rowid = ?`).get(n.rowid) as Fact | undefined;
    if (!row || row.archived) continue;
    if (sim >= MERGE_SIM) return mergeInto(row, "merged-similar");
    if (sim >= NEAR_DUP_SIM && !nearDup) nearDup = row.id;
  }

  const id = randomUUID();
  const insert = db.prepare(`
    INSERT INTO facts (id, kind, content, content_hash, source_turn_ids, project, created_at, updated_at, pinned, archived, edited, origin)
    VALUES (@id, @kind, @content, @hash, @sources, @project, @now, @now, @pinned, 0, 0, @origin)
  `);
  const info = insert.run({
    id,
    kind: input.kind,
    content,
    hash,
    sources: JSON.stringify(input.sourceTurnIds ?? []),
    project: input.project ?? null,
    now,
    pinned: input.pinned ? 1 : 0,
    origin: input.origin ?? "distill",
  });
  db.prepare(`INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)`).run(
    BigInt(info.lastInsertRowid),
    vecBlob(vec),
  );
  return nearDup
    ? { action: "near-duplicate-inserted", id, similarTo: nearDup }
    : { action: "inserted", id };
}

export async function editFact(id: string, content: string): Promise<void> {
  const db = getDb();
  const rowid = rowidOf(id);
  if (rowid === null) throw new Error(`no fact ${id}`);
  const trimmed = content.trim().slice(0, MAX_FACT_CHARS);
  db.prepare(
    `UPDATE facts SET content = ?, content_hash = ?, edited = 1, updated_at = ? WHERE id = ?`,
  ).run(trimmed, contentHash(trimmed), new Date().toISOString(), id);
  const vec = await _embed(trimmed);
  // vec0 virtual tables don't implement conflict resolution — no OR REPLACE.
  db.prepare(`DELETE FROM vec_facts WHERE rowid = ?`).run(BigInt(rowid));
  db.prepare(`INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)`).run(
    BigInt(rowid),
    vecBlob(vec),
  );
}

export function setPinned(id: string, pinned: boolean): void {
  getDb().prepare(`UPDATE facts SET pinned = ?, updated_at = ? WHERE id = ?`).run(
    pinned ? 1 : 0,
    new Date().toISOString(),
    id,
  );
}

/** Archived facts keep their row but lose their vector — they can never rank. */
export async function setArchived(id: string, archived: boolean): Promise<void> {
  const db = getDb();
  const rowid = rowidOf(id);
  if (rowid === null) throw new Error(`no fact ${id}`);
  db.prepare(`UPDATE facts SET archived = ?, updated_at = ? WHERE id = ?`).run(
    archived ? 1 : 0,
    new Date().toISOString(),
    id,
  );
  if (archived) {
    db.prepare(`DELETE FROM vec_facts WHERE rowid = ?`).run(BigInt(rowid));
  } else {
    const row = db.prepare(`SELECT content FROM facts WHERE id = ?`).get(id) as any;
    const vec = await _embed(row.content);
    db.prepare(`DELETE FROM vec_facts WHERE rowid = ?`).run(BigInt(rowid));
    db.prepare(`INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)`).run(
      BigInt(rowid),
      vecBlob(vec),
    );
  }
}

export function deleteFact(id: string): void {
  const db = getDb();
  const rowid = rowidOf(id);
  if (rowid === null) return;
  db.prepare(`DELETE FROM vec_facts WHERE rowid = ?`).run(BigInt(rowid));
  db.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
}

export function listFacts(opts: { archived?: boolean; project?: string } = {}): Fact[] {
  const db = getDb();
  let sql = `SELECT * FROM facts WHERE archived = ?`;
  const params: any[] = [opts.archived ? 1 : 0];
  if (opts.project) {
    sql += ` AND project = ?`;
    params.push(opts.project);
  }
  sql += ` ORDER BY pinned DESC, updated_at DESC`;
  return db.prepare(sql).all(...params) as Fact[];
}

export function getFact(id: string): Fact | null {
  return (getDb().prepare(`SELECT * FROM facts WHERE id = ?`).get(id) as Fact) ?? null;
}
