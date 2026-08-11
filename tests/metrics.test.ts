import test from "node:test";
import assert from "node:assert/strict";
import {
  atOperatingPoint,
  bestByF05,
  mrr,
  recallAtK,
  thresholdSweep,
  type CaseResult,
} from "../src/eval/metrics.js";

const mkCase = (id: string, expectSession: string): any => ({
  id,
  query: id,
  expected_session_ids: [expectSession],
});

const results: CaseResult[] = [
  {
    // hit at rank 1, score 0.9
    case: mkCase("a", "s1"),
    ranked: [
      { turnId: "t1", sessionId: "s1", score: 0.9 },
      { turnId: "t2", sessionId: "s2", score: 0.7 },
    ],
  },
  {
    // hit at rank 2, score 0.6 (below 0.75 operating point)
    case: mkCase("b", "s3"),
    ranked: [
      { turnId: "t3", sessionId: "s9", score: 0.8 },
      { turnId: "t4", sessionId: "s3", score: 0.6 },
    ],
  },
  {
    // no hit at all
    case: mkCase("c", "s5"),
    ranked: [{ turnId: "t5", sessionId: "s6", score: 0.85 }],
  },
];

test("recallAtK counts hits within k", () => {
  assert.equal(recallAtK(results, 1), 1 / 3);
  assert.equal(recallAtK(results, 2), 2 / 3);
});

test("mrr averages reciprocal ranks, zero for misses", () => {
  assert.ok(Math.abs(mrr(results) - (1 + 0.5 + 0) / 3) < 1e-9);
});

test("operating point counts injected snippets above threshold only", () => {
  const op = atOperatingPoint(results, { minScore: 0.75, limit: 3 });
  // injected: a→[0.9], b→[0.8], c→[0.85] = 3 snippets, hits = 1 (a)
  assert.equal(op.injected, 3);
  assert.equal(op.hits, 1);
  assert.ok(Math.abs(op.precision - 1 / 3) < 1e-9);
  assert.ok(Math.abs(op.recallAt - 1 / 3) < 1e-9);
  assert.equal(op.injectionRate, 1);
});

test("threshold sweep is monotonic in injection rate and picks a sane best", () => {
  const rows = thresholdSweep(results, 3);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].injectionRate <= rows[i - 1].injectionRate + 1e-9);
  }
  const best = bestByF05(rows);
  assert.ok(best.minScore >= 0.5 && best.minScore <= 0.95);
});
