/**
 * Regression gate for the retrieval eval (#16).
 *
 * Compares one run's headline metrics against a committed baseline.
 * The issue's P0: any ≥10% drop in Recall@10 fails the gate. Smaller
 * drops and changes to other metrics surface as warnings — they're
 * still noise but they don't fail CI.
 *
 * Kept as a pure function so the runner stays thin and the deliberate-
 * regression test can call it directly without spawning the whole
 * pipeline.
 */

export interface BaselineMetrics {
  recallAt10: number;
  recallAt30: number;
  mrr: number;
  citationCorrectness: number;
}

export interface GateResult {
  /** A P0 (≥10% Recall@10 drop) was detected. Caller should exit non-zero. */
  regressed: boolean;
  /** Human-readable lines for the report. */
  messages: string[];
}

/** Recall@10 drop above this (absolute, fraction of 1.0) is a P0 regression. */
export const RECALL_REGRESSION_THRESHOLD = 0.1;

export function checkRegression(
  current: BaselineMetrics,
  baseline: BaselineMetrics,
): GateResult {
  const messages: string[] = [];
  let regressed = false;

  const r10Drop = baseline.recallAt10 - current.recallAt10;
  // FP-tolerant: a drop of exactly 10% should still trip; 0.93 - 0.10
  // rounds to 0.0999... in IEEE-754 so we need a small epsilon.
  if (r10Drop >= RECALL_REGRESSION_THRESHOLD - 1e-9) {
    regressed = true;
    messages.push(
      `[P0] Recall@10 dropped ${pct(r10Drop)} vs baseline (${pct(baseline.recallAt10)} → ${pct(current.recallAt10)}). Threshold: ${pct(RECALL_REGRESSION_THRESHOLD)}.`,
    );
  } else if (r10Drop > 0) {
    messages.push(
      `[warn] Recall@10 dropped ${pct(r10Drop)} (${pct(baseline.recallAt10)} → ${pct(current.recallAt10)}).`,
    );
  }

  const r30Drop = baseline.recallAt30 - current.recallAt30;
  if (r30Drop > 0) {
    messages.push(
      `[warn] Recall@30 dropped ${pct(r30Drop)} (${pct(baseline.recallAt30)} → ${pct(current.recallAt30)}).`,
    );
  }

  const mrrDrop = baseline.mrr - current.mrr;
  if (mrrDrop > 0.05) {
    messages.push(
      `[warn] MRR dropped ${mrrDrop.toFixed(3)} (${baseline.mrr.toFixed(3)} → ${current.mrr.toFixed(3)}).`,
    );
  }

  const citationDrop = baseline.citationCorrectness - current.citationCorrectness;
  if (citationDrop > 0) {
    messages.push(
      `[warn] Citation correctness dropped ${pct(citationDrop)} (${pct(baseline.citationCorrectness)} → ${pct(current.citationCorrectness)}).`,
    );
  }

  return { regressed, messages };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
