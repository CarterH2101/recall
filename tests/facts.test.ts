import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-facts-test-"));
process.env.RECALL_DB_PATH = path.join(tmp, "memory.db");

// Deterministic fake embedder: hash n-grams into a 384-dim vector so similar
// strings get similar vectors — close enough to exercise merge thresholds.
function fakeVec(text: string): Float32Array {
  const v = new Float32Array(384);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const w of words) {
    const h = createHash("md5").update(w).digest();
    for (let i = 0; i < 8; i++) v[h[i] * 384 / 256 | 0] += 1;
  }
  let norm = Math.hypot(...v);
  if (!norm) norm = 1;
  return v.map((x) => x / norm) as Float32Array;
}

test("facts CRUD + dedup/merge semantics", async (t) => {
  const facts = await import("../src/lib/facts.js");
  facts.setFactEmbedder(async (s) => fakeVec(s));

  const a = await facts.addFact({
    kind: "gotcha",
    content: "sqlite vec0 virtual tables require BigInt rowids on insert",
    sourceTurnIds: ["t1"],
  });
  assert.equal(a.action, "inserted");

  await t.test("exact-hash re-add merges and unions sources", async () => {
    const b = await facts.addFact({
      kind: "gotcha",
      content: "  SQLITE vec0 virtual tables   require bigint rowids on insert ",
      sourceTurnIds: ["t2"],
    });
    assert.equal(b.action, "merged-exact");
    assert.equal(b.id, a.id);
    const f = facts.getFact(a.id)!;
    assert.deepEqual(JSON.parse(f.source_turn_ids).sort(), ["t1", "t2"]);
  });

  await t.test("identical-vector paraphrase merges, never clobbers edits", async () => {
    await facts.editFact(a.id, "vec0 tables demand BigInt rowid bindings when inserting embeddings");
    const edited = facts.getFact(a.id)!;
    assert.equal(edited.edited, 1);
    // same words → same fake vector → sim 1.0 → merge, content untouched
    const c = await facts.addFact({
      kind: "gotcha",
      content: "vec0 tables demand BigInt rowid bindings when inserting embeddings!!",
      sourceTurnIds: ["t3"],
    });
    assert.equal(c.action, "merged-similar");
    assert.equal(facts.getFact(a.id)!.content, edited.content);
  });

  await t.test("unrelated fact inserts fresh", async () => {
    const d = await facts.addFact({
      kind: "preference",
      content: "always write unit over home in prose for rental terminology",
    });
    assert.equal(d.action, "inserted");
    assert.notEqual(d.id, a.id);
  });

  await t.test("archive removes from vector ranking, unarchive restores", async () => {
    const list = facts.listFacts({});
    const target = list[list.length - 1];
    await facts.setArchived(target.id, true);
    assert.equal(facts.listFacts({}).length, list.length - 1);
    assert.equal(facts.listFacts({ archived: true }).length, 1);
    await facts.setArchived(target.id, false);
    assert.equal(facts.listFacts({}).length, list.length);
  });

  await t.test("delete removes row and vector", async () => {
    const e = await facts.addFact({ kind: "reference", content: "the daemon listens on port 4319 by default with fallback" });
    facts.deleteFact(e.id);
    assert.equal(facts.getFact(e.id), null);
  });
});

test("recallFactMatches ranks facts with boost and respects archive", async () => {
  const facts = await import("../src/lib/facts.js");
  const { recallFactMatches, setQueryEmbedder } = await import("../src/lib/recall.js");
  facts.setFactEmbedder(async (s) => fakeVec(s));
  setQueryEmbedder(async (s) => fakeVec(s));

  const r = await facts.addFact({
    kind: "decision",
    content: "we chose registry cache for the docker build pipeline speedup",
  });
  const hits = await recallFactMatches("docker build pipeline registry cache speedup choice");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].factId, r.id);
  assert.ok(hits[0].score > 0.6, `score ${hits[0].score}`); // strong word overlap + FACT_BOOST

  await facts.setArchived(r.id, true);
  const hits2 = await recallFactMatches("docker build pipeline registry cache speedup choice");
  assert.ok(!hits2.some((h) => h.factId === r.id));
  setQueryEmbedder(null);
});
