// Pure metric functions over eval runs. A "hit" is a retrieved snippet whose
// turn id OR session id is expected by the case (session-level labels are the
// cheap default; retrieval dedupes to one snippet per session so it's
// well-defined).

export interface EvalCase {
  id: string;
  query: string;
  expected_session_ids?: string[];
  expected_turn_ids?: string[];
  forbidden_turn_ids?: string[];
  exclude_session_id?: string;
  notes?: string;
  source?: string;
}

export interface RankedItem {
  turnId: string;
  sessionId: string;
  score: number;
}

export interface CaseResult {
  case: EvalCase;
  ranked: RankedItem[]; // post-dedup ranked list (limit 5)
}

export function isHit(c: EvalCase, item: RankedItem): boolean {
  return (
    (c.expected_turn_ids ?? []).includes(item.turnId) ||
    (c.expected_session_ids ?? []).includes(item.sessionId)
  );
}

export function isForbidden(c: EvalCase, item: RankedItem): boolean {
  return (c.forbidden_turn_ids ?? []).includes(item.turnId);
}

export function recallAtK(results: CaseResult[], k: number): number {
  if (!results.length) return 0;
  const hits = results.filter((r) => r.ranked.slice(0, k).some((i) => isHit(r.case, i)));
  return hits.length / results.length;
}

export function mrr(results: CaseResult[]): number {
  if (!results.length) return 0;
  let sum = 0;
  for (const r of results) {
    const idx = r.ranked.findIndex((i) => isHit(r.case, i));
    if (idx >= 0) sum += 1 / (idx + 1);
  }
  return sum / results.length;
}

export interface OperatingPoint {
  minScore: number;
  limit: number;
}

export interface OperatingMetrics {
  injectionRate: number; // % of cases injecting >= 1 snippet
  missRate: number; // % of cases injecting nothing
  precision: number; // of injected snippets, fraction that are hits
  noiseRate: number; // 1 - precision
  forbiddenRate: number; // of injected snippets, fraction explicitly forbidden
  recallAt: number; // % of cases whose top-limit injected set contains a hit
  f05: number; // precision-weighted F-score at this operating point
  injected: number;
  hits: number;
}

export function atOperatingPoint(results: CaseResult[], op: OperatingPoint): OperatingMetrics {
  let injectedTotal = 0;
  let hitTotal = 0;
  let forbiddenTotal = 0;
  let casesInjecting = 0;
  let casesWithHit = 0;

  for (const r of results) {
    const injected = r.ranked.filter((i) => i.score >= op.minScore).slice(0, op.limit);
    if (injected.length) casesInjecting++;
    let anyHit = false;
    for (const item of injected) {
      injectedTotal++;
      if (isHit(r.case, item)) {
        hitTotal++;
        anyHit = true;
      }
      if (isForbidden(r.case, item)) forbiddenTotal++;
    }
    if (anyHit) casesWithHit++;
  }

  const n = results.length || 1;
  const precision = injectedTotal ? hitTotal / injectedTotal : 1;
  const recallVal = casesWithHit / n;
  const beta2 = 0.25; // F0.5: precision weighted 2x
  const f05 =
    precision + recallVal === 0
      ? 0
      : ((1 + beta2) * precision * recallVal) / (beta2 * precision + recallVal);

  return {
    injectionRate: casesInjecting / n,
    missRate: 1 - casesInjecting / n,
    precision,
    noiseRate: 1 - precision,
    forbiddenRate: injectedTotal ? forbiddenTotal / injectedTotal : 0,
    recallAt: recallVal,
    f05,
    injected: injectedTotal,
    hits: hitTotal,
  };
}

export interface SweepRow extends OperatingMetrics {
  minScore: number;
}

export function thresholdSweep(
  results: CaseResult[],
  limit: number,
  from = 0.5,
  to = 0.95,
  step = 0.01,
): SweepRow[] {
  const rows: SweepRow[] = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    const ms = Number(t.toFixed(2));
    rows.push({ minScore: ms, ...atOperatingPoint(results, { minScore: ms, limit }) });
  }
  return rows;
}

export function bestByF05(rows: SweepRow[]): SweepRow {
  return rows.reduce((best, r) => (r.f05 > best.f05 ? r : best), rows[0]);
}

/** 10-bucket score histogram of hits vs non-hits, for eyeballing separation. */
export function scoreHistogram(results: CaseResult[]): { bucket: string; hits: number; misses: number }[] {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    bucket: `${(0.5 + i * 0.05).toFixed(2)}-${(0.55 + i * 0.05).toFixed(2)}`,
    hits: 0,
    misses: 0,
  }));
  for (const r of results) {
    for (const item of r.ranked) {
      const idx = Math.min(9, Math.max(0, Math.floor((item.score - 0.5) / 0.05)));
      if (isHit(r.case, item)) buckets[idx].hits++;
      else buckets[idx].misses++;
    }
  }
  return buckets;
}
