import { describe, expect, it } from "vitest";
import {
  checkRegression,
  RECALL_REGRESSION_THRESHOLD,
  type BaselineMetrics,
} from "./regression-gate";

const HEALTHY: BaselineMetrics = {
  recallAt10: 0.93,
  recallAt30: 1.0,
  mrr: 0.45,
  citationCorrectness: 1.0,
};

describe("regression-gate", () => {
  it("passes when current matches baseline", () => {
    const result = checkRegression(HEALTHY, HEALTHY);
    expect(result.regressed).toBe(false);
    expect(result.messages).toEqual([]);
  });

  it("passes on small Recall@10 drop below threshold", () => {
    const current = { ...HEALTHY, recallAt10: HEALTHY.recallAt10 - 0.05 };
    const result = checkRegression(current, HEALTHY);
    expect(result.regressed).toBe(false);
    expect(result.messages.some((m) => m.includes("[warn]"))).toBe(true);
  });

  it("fails on Recall@10 drop at or above threshold (deliberate-regression case)", () => {
    // Simulates the issue's acceptance test: "a deliberate chunker
    // regression in a test fixture trips the regression flag."
    const current = {
      ...HEALTHY,
      recallAt10: HEALTHY.recallAt10 - RECALL_REGRESSION_THRESHOLD,
    };
    const result = checkRegression(current, HEALTHY);
    expect(result.regressed).toBe(true);
    expect(result.messages.some((m) => m.includes("[P0]"))).toBe(true);
  });

  it("fails on a large Recall@10 drop", () => {
    const current = { ...HEALTHY, recallAt10: 0.3 };
    const result = checkRegression(current, HEALTHY);
    expect(result.regressed).toBe(true);
  });

  it("warns on MRR drop without failing", () => {
    const current = { ...HEALTHY, mrr: HEALTHY.mrr - 0.1 };
    const result = checkRegression(current, HEALTHY);
    expect(result.regressed).toBe(false);
    expect(result.messages.some((m) => m.toLowerCase().includes("mrr"))).toBe(true);
  });

  it("warns on citation-correctness drop without failing", () => {
    const current = { ...HEALTHY, citationCorrectness: 0.9 };
    const result = checkRegression(current, HEALTHY);
    expect(result.regressed).toBe(false);
    expect(result.messages.some((m) => m.toLowerCase().includes("citation"))).toBe(true);
  });

  it("does not warn when metrics improve", () => {
    const current = {
      recallAt10: 1.0,
      recallAt30: 1.0,
      mrr: 0.9,
      citationCorrectness: 1.0,
    };
    const result = checkRegression(current, HEALTHY);
    expect(result.regressed).toBe(false);
    expect(result.messages).toEqual([]);
  });
});
