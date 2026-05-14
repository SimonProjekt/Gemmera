import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMetrics, readMetrics, type MetricsRow } from "./metrics-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "metrics-store-"));
  file = join(dir, "metrics.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const row = (recall: number): MetricsRow => ({
  timestamp: new Date().toISOString(),
  mode: "mock",
  total: 30,
  recallAt10: recall,
  recallAt30: 1.0,
  mrr: 0.45,
  citationCorrectness: 1.0,
  retrievalP50Ms: 0.1,
  retrievalP95Ms: 1.6,
  endToEndP50Ms: 0.1,
  endToEndP95Ms: 1.6,
  perShard: {},
});

describe("metrics-store", () => {
  it("returns empty when file does not exist", () => {
    expect(readMetrics(file)).toEqual([]);
  });

  it("round-trips a single row", () => {
    const r = row(0.93);
    appendMetrics(file, r);
    expect(readMetrics(file)).toEqual([r]);
  });

  it("preserves ordering across multiple appends", () => {
    const a = row(0.9);
    const b = row(0.95);
    appendMetrics(file, a);
    appendMetrics(file, b);
    expect(readMetrics(file).map((r) => r.recallAt10)).toEqual([0.9, 0.95]);
  });

  it("creates parent directory when missing", () => {
    const nested = join(dir, "nested", "deep", "metrics.jsonl");
    appendMetrics(nested, row(0.93));
    expect(readMetrics(nested)).toHaveLength(1);
  });
});
