import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL log of every retrieval-eval run. One line per run.
 * The future in-app trend chart (#16 §"Continuous eval", UI-surfaces v1)
 * is the consumer — the harness just writes here.
 */

export interface MetricsRow {
  timestamp: string;
  mode: "mock" | "live";
  total: number;
  recallAt10: number;
  recallAt30: number;
  mrr: number;
  citationCorrectness: number;
  retrievalP50Ms: number;
  retrievalP95Ms: number;
  endToEndP50Ms: number;
  endToEndP95Ms: number;
  perShard: Record<string, { recallAt10: number; n: number }>;
}

export function appendMetrics(path: string, row: MetricsRow): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
}

export function readMetrics(path: string): MetricsRow[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as MetricsRow);
}
