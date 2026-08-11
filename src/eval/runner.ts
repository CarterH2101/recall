import fs from "node:fs";
import { createHash } from "node:crypto";
import { recallCandidates, selectSnippets, setQueryEmbedder } from "../lib/recall.js";
import {
  type CaseResult,
  type EvalCase,
  type SweepRow,
  atOperatingPoint,
  bestByF05,
  mrr,
  recallAtK,
  scoreHistogram,
  thresholdSweep,
} from "./metrics.js";

export const RANK_LIMIT = 5;
export const HOOK_OP = { minScore: 0.75, limit: 3 };

export interface EvalReport {
  cases: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  hook: ReturnType<typeof atOperatingPoint>;
  sweep: SweepRow[];
  recommended: SweepRow;
  histogram: ReturnType<typeof scoreHistogram>;
  failures: { id: string; query: string; expected: string; got: string }[];
}

export function loadDataset(file: string): EvalCase[] {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const cases: EvalCase[] = [];
  for (const [i, line] of lines.entries()) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`${file}:${i + 1} is not valid JSON`);
    }
    if (!obj.id || !obj.query) throw new Error(`${file}:${i + 1} missing id/query`);
    if (!(obj.expected_session_ids?.length || obj.expected_turn_ids?.length)) {
      throw new Error(`${file}:${i + 1} (${obj.id}) has no expectations`);
    }
    cases.push(obj);
  }
  return cases;
}

export function queryHash(q: string): string {
  return createHash("sha256").update(q).digest("hex").slice(0, 16);
}

/** CI mode: substitute precomputed query vectors; hard error on a miss so a
 *  changed query forces a fixture rebuild instead of silently degrading. */
export function usePrecomputedVectors(vecFile: string): void {
  const table: Record<string, number[]> = JSON.parse(fs.readFileSync(vecFile, "utf8"));
  setQueryEmbedder(async (q: string) => {
    const v = table[queryHash(q)];
    if (!v) {
      throw new Error(
        `no precomputed vector for query "${q.slice(0, 60)}…" — run: recalld eval build-fixture`,
      );
    }
    return Float32Array.from(v);
  });
}

export async function runDataset(cases: EvalCase[]): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const candidates = await recallCandidates(c.query, {
      excludeSessionId: c.exclude_session_id,
      limit: RANK_LIMIT,
    });
    // Rank through the real selection path (dedup + ordering), no threshold.
    const snippets = selectSnippets(candidates, { limit: RANK_LIMIT, minScore: 0 });
    results.push({
      case: c,
      ranked: snippets.map((s) => ({ turnId: s.turnId, sessionId: s.sessionId, score: s.score })),
    });
  }

  const sweep = thresholdSweep(results, HOOK_OP.limit);
  const failures = results
    .filter((r) => !r.ranked.slice(0, 3).some((i) => (r.case.expected_turn_ids ?? []).includes(i.turnId) || (r.case.expected_session_ids ?? []).includes(i.sessionId)))
    .map((r) => ({
      id: r.case.id,
      query: r.case.query,
      expected: [...(r.case.expected_session_ids ?? []), ...(r.case.expected_turn_ids ?? [])].join(","),
      got: r.ranked
        .slice(0, 3)
        .map((i) => `${i.sessionId.slice(0, 8)}@${i.score.toFixed(2)}`)
        .join(" "),
    }));

  return {
    cases: cases.length,
    recallAt1: recallAtK(results, 1),
    recallAt3: recallAtK(results, 3),
    recallAt5: recallAtK(results, 5),
    mrr: mrr(results),
    hook: atOperatingPoint(results, HOOK_OP),
    sweep,
    recommended: bestByF05(sweep),
    histogram: scoreHistogram(results),
    failures,
  };
}

export function renderReport(r: EvalReport, md = false): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  const h = md ? "## " : "";
  lines.push(`${h}recall eval — ${r.cases} cases`);
  lines.push("");
  lines.push(md ? "| metric | value |\n|---|---|" : "metric            value");
  const row = (k: string, v: string) => (md ? `| ${k} | ${v} |` : `${k.padEnd(18)}${v}`);
  lines.push(row("recall@1", pct(r.recallAt1)));
  lines.push(row("recall@3", pct(r.recallAt3)));
  lines.push(row("recall@5", pct(r.recallAt5)));
  lines.push(row("MRR", r.mrr.toFixed(3)));
  lines.push(row("hook precision", pct(r.hook.precision)));
  lines.push(row("hook noise rate", pct(r.hook.noiseRate)));
  lines.push(row("hook injection", pct(r.hook.injectionRate)));
  lines.push(row("hook recall", pct(r.hook.recallAt)));
  lines.push("");
  lines.push(
    `recommended minScore (max F0.5): ${r.recommended.minScore} ` +
      `(precision ${pct(r.recommended.precision)}, recall ${pct(r.recommended.recallAt)}, injection ${pct(r.recommended.injectionRate)})`,
  );
  lines.push("");
  lines.push(md ? "### score histogram (hits / misses)" : "score histogram (hits / misses)");
  for (const b of r.histogram) {
    if (b.hits || b.misses) lines.push(`  ${b.bucket}  ${"#".repeat(b.hits)}${b.hits ? ` ${b.hits}` : ""} / ${b.misses}`);
  }
  if (r.failures.length) {
    lines.push("");
    lines.push(md ? "### failures (no hit in top 3)" : "failures (no hit in top 3):");
    for (const f of r.failures) {
      lines.push(`  [${f.id}] "${f.query.slice(0, 70)}" got ${f.got || "(nothing)"}`);
    }
  }
  return lines.join("\n");
}
