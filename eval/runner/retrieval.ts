#!/usr/bin/env tsx
/**
 * Retrieval eval runner (#16). Builds the RAG retrieval stack in-process
 * against the golden-set fixture vaults under `evals/golden/fixtures/`,
 * runs each shard's questions through `HybridRetriever`, and writes a
 * timestamped report under `eval/runs/<ts>/`.
 *
 * Phase 1 scope: mock-only, Recall@10 over the `link-structure` shard.
 * Later phases (#16) add: Recall@30, MRR, latency, per-signal breakdown,
 * payload metrics, persistence, and a regression gate.
 *
 * Modes:
 *   --mock              Deterministic in-process embedder (default for now).
 *   --shard <name>      Run a single shard. Default: all known shards.
 *   --compare <path>    Reserved for Phase 5 (regression gate).
 *   --save-baseline <p> Reserved for Phase 5.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryIngestionStore } from "../../src/contracts/mocks/in-memory-ingestion-store";
import { MockEmbedder } from "../../src/contracts/mocks/mock-embedder";
import { MockVaultService } from "../../src/contracts/mocks/mock-vault";
import type {
  RetrievalHit,
  SearchHit,
  VectorStore,
  WinningSignal,
} from "../../src/contracts";
import { BM25IndexService } from "../../src/services/bm25-index-service";
import { EmbeddingService } from "../../src/services/embedding-service";
import { HybridRetriever } from "../../src/services/hybrid-retriever";
import { HashGatedIngestionPipeline } from "../../src/services/ingestion-pipeline";
import { InMemoryBM25Index } from "../../src/services/in-memory-bm25-index";
import { InMemoryJobQueue } from "../../src/services/in-memory-job-queue";
import { InMemoryLinksIndex } from "../../src/services/in-memory-links-index";
import { IngestionRunner } from "../../src/services/ingestion-runner";
import { LinksIndexService } from "../../src/services/links-index-service";
import { MarkdownChunker } from "../../src/services/markdown-chunker";
import { loadFixtureVault, loadShard, SHARDS, type GoldenExample, type ShardName } from "../retrieval-golden/loader";

// ─── CLI ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
// `--mock` is the current default; real-embedder mode lands in a later phase.
const _useMock = argv.includes("--mock") || !argv.includes("--live");
const shardArg = flagValue("--shard") as ShardName | undefined;
const _compareArg = flagValue("--compare");
const _saveBaselineArg = flagValue("--save-baseline");

function flagValue(flag: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
  if (eq) return eq;
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

const DIM = 16;
const TOP_K = 10;
const CANDIDATE_K = 30;

const SIGNALS: WinningSignal[] = [
  "semantic",
  "lexical",
  "backlink",
  "tag",
  "recency",
];

// ─── In-memory vector store (mirrors hybrid-retriever.integration.test.ts) ─

class InMemoryVectorStore implements VectorStore {
  private vectors = new Map<string, Float32Array>();
  metadata() {
    return { model: "mock", dim: DIM };
  }
  async has(h: string) {
    return this.vectors.has(h);
  }
  async upsert(h: string, v: Float32Array) {
    this.vectors.set(h, v);
  }
  async delete(h: string) {
    this.vectors.delete(h);
  }
  async search(query: Float32Array, topK: number): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    for (const [h, v] of this.vectors) hits.push({ contentHash: h, score: dot(query, v) });
    hits.sort((a, b) => b.score - a.score || a.contentHash.localeCompare(b.contentHash));
    return hits.slice(0, topK);
  }
  async count() {
    return this.vectors.size;
  }
  async reset() {
    this.vectors.clear();
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ─── Pipeline build (per fixture vault, cached) ───────────────────────

interface Pipeline {
  retriever: HybridRetriever;
}

const pipelineCache = new Map<string, Promise<Pipeline>>();

function pipelineFor(vault: string): Promise<Pipeline> {
  const cached = pipelineCache.get(vault);
  if (cached) return cached;
  const built = buildPipeline(vault);
  pipelineCache.set(vault, built);
  return built;
}

async function buildPipeline(vaultName: string): Promise<Pipeline> {
  const files = loadFixtureVault(vaultName);
  const vault = new MockVaultService(files);
  const store = new InMemoryIngestionStore();
  const pipeline = new HashGatedIngestionPipeline(vault, new MarkdownChunker(), store);
  const queue = new InMemoryJobQueue();
  const runner = new IngestionRunner(queue, pipeline, store);
  const embedder = new MockEmbedder({ dim: DIM });
  const vectorStore = new InMemoryVectorStore();
  const embedSvc = new EmbeddingService(runner, embedder, vectorStore, store);
  const bm25 = new InMemoryBM25Index();
  const bm25Svc = new BM25IndexService(runner, bm25, store);
  const links = new InMemoryLinksIndex();
  const linksSvc = new LinksIndexService(runner, vault, links);

  runner.start();
  embedSvc.start();
  bm25Svc.start();
  linksSvc.start();

  for (const path of Object.keys(files)) queue.enqueue({ kind: "index", path });

  await runner.drainNow();
  await embedSvc.flush();
  await bm25Svc.flush();
  await linksSvc.flush();

  const retriever = new HybridRetriever(embedder, vectorStore, bm25, links, store);
  return { retriever };
}

// ─── Metrics ──────────────────────────────────────────────────────────

interface QuestionResult {
  shard: ShardName;
  id: string;
  question: string;
  idealPaths: string[];
  /** Top-30 path list (deduped, retriever order). */
  candidatePaths: string[];
  /** Top-10 slice of `candidatePaths`. */
  retrievedPaths: string[];
  /** For each ideal path that hit in top-10, the `winningSignal` of its first occurrence. */
  hitSignals: Record<string, WinningSignal>;
  recallAt10: number;
  recallAt30: number;
  /** Reciprocal rank of the first ideal-path hit anywhere in top-30. 0 if no hit. */
  reciprocalRank: number;
  /** Wall-clock retrieval time in ms. */
  latencyMs: number;
}

function uniquePaths(hits: RetrievalHit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (seen.has(h.path)) continue;
    seen.add(h.path);
    out.push(h.path);
  }
  return out;
}

/** First-occurrence winningSignal per path, scanning hits in retriever order. */
function firstSignalByPath(hits: RetrievalHit[]): Map<string, WinningSignal> {
  const out = new Map<string, WinningSignal>();
  for (const h of hits) if (!out.has(h.path)) out.set(h.path, h.winningSignal);
  return out;
}

function recall(retrieved: string[], ideal: string[]): number {
  if (ideal.length === 0) return 1;
  const set = new Set(retrieved);
  let hits = 0;
  for (const p of ideal) if (set.has(p)) hits++;
  return hits / ideal.length;
}

async function runExample(
  shard: ShardName,
  ex: GoldenExample,
): Promise<QuestionResult> {
  const { retriever } = await pipelineFor(ex.fixtureVault);
  const t0 = performance.now();
  const hits = await retriever.retrieve(ex.question, { topK: CANDIDATE_K });
  const latencyMs = performance.now() - t0;

  const candidatePaths = uniquePaths(hits);
  const retrievedPaths = candidatePaths.slice(0, TOP_K);
  const signalByPath = firstSignalByPath(hits);

  const ideal = new Set(ex.idealNotePaths);
  const hitSignals: Record<string, WinningSignal> = {};
  for (const p of retrievedPaths) {
    if (ideal.has(p)) {
      const sig = signalByPath.get(p);
      if (sig) hitSignals[p] = sig;
    }
  }

  // MRR: rank of first ideal path within top-30 (1-indexed).
  let reciprocalRank = 0;
  for (let i = 0; i < candidatePaths.length; i++) {
    if (ideal.has(candidatePaths[i])) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }

  return {
    shard,
    id: ex.id,
    question: ex.question,
    idealPaths: ex.idealNotePaths,
    candidatePaths,
    retrievedPaths,
    hitSignals,
    recallAt10: recall(retrievedPaths, ex.idealNotePaths),
    recallAt30: recall(candidatePaths, ex.idealNotePaths),
    reciprocalRank,
    latencyMs,
  };
}

// ─── Report ───────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

interface SignalBreakdown {
  /** Number of ideal-path hits whose first occurrence came in with this signal. */
  hits: number;
  /** Share of all ideal-path hits attributable to this signal. */
  share: number;
}

function signalBreakdown(results: QuestionResult[]): Record<WinningSignal, SignalBreakdown> {
  const counts: Record<WinningSignal, number> = {
    semantic: 0,
    lexical: 0,
    backlink: 0,
    tag: 0,
    recency: 0,
  };
  let total = 0;
  for (const r of results) {
    for (const sig of Object.values(r.hitSignals)) {
      counts[sig]++;
      total++;
    }
  }
  return Object.fromEntries(
    SIGNALS.map((s) => [s, { hits: counts[s], share: total === 0 ? 0 : counts[s] / total }]),
  ) as Record<WinningSignal, SignalBreakdown>;
}

function report(results: QuestionResult[]): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(__dirname, "..", "runs", ts);
  mkdirSync(outDir, { recursive: true });

  const total = results.length;
  const meanRecall10 = mean(results.map((r) => r.recallAt10));
  const meanRecall30 = mean(results.map((r) => r.recallAt30));
  const meanMRR = mean(results.map((r) => r.reciprocalRank));
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  const byShard = new Map<ShardName, QuestionResult[]>();
  for (const r of results) {
    const arr = byShard.get(r.shard) ?? [];
    arr.push(r);
    byShard.set(r.shard, arr);
  }

  const breakdown = signalBreakdown(results);

  const md: string[] = [
    `# Retrieval Eval — ${new Date().toISOString()}`,
    "",
    `**Mode:** mock  `,
    `**Examples:** ${total}  `,
    `**Recall@${TOP_K}:** ${pct(meanRecall10)}  `,
    `**Recall@${CANDIDATE_K}:** ${pct(meanRecall30)}  `,
    `**MRR:** ${meanMRR.toFixed(3)}  `,
    `**Latency P50/P95:** ${p50.toFixed(1)}ms / ${p95.toFixed(1)}ms`,
    "",
    "## Per-shard",
    "",
    "| Shard | N | Recall@10 | Recall@30 | MRR | P50 (ms) |",
    "|-------|---|-----------|-----------|-----|----------|",
  ];
  for (const [shard, rs] of byShard) {
    const lats = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
    md.push(
      `| ${shard} | ${rs.length} | ${pct(mean(rs.map((r) => r.recallAt10)))} | ${pct(mean(rs.map((r) => r.recallAt30)))} | ${mean(rs.map((r) => r.reciprocalRank)).toFixed(3)} | ${percentile(lats, 50).toFixed(1)} |`,
    );
  }

  md.push(
    "",
    "## Per-signal recall@10 attribution",
    "",
    "First-occurrence `winningSignal` for each ideal-path hit in top-10. Shows whether the link-graph boost is doing work or pure semantic is carrying everything.",
    "",
    "| Signal | Hits | Share |",
    "|--------|------|-------|",
  );
  for (const sig of SIGNALS) {
    const b = breakdown[sig];
    md.push(`| ${sig} | ${b.hits} | ${pct(b.share)} |`);
  }

  const failures = results.filter((r) => r.recallAt10 < 1);
  if (failures.length > 0) {
    md.push("", "## Misses", "");
    for (const f of failures) {
      md.push(
        `**${f.id}** (${f.shard}) — recall@10 ${pct(f.recallAt10)}, recall@30 ${pct(f.recallAt30)}, MRR ${f.reciprocalRank.toFixed(3)}  `,
        `> Q: ${f.question}`,
        `> Ideal: ${f.idealPaths.join(", ")}`,
        `> Top-${TOP_K}: ${f.retrievedPaths.join(", ") || "(none)"}`,
        "",
      );
    }
  }

  const json = {
    timestamp: new Date().toISOString(),
    mode: "mock",
    total,
    recallAt10: meanRecall10,
    recallAt30: meanRecall30,
    mrr: meanMRR,
    latency: { p50, p95, min: latencies[0] ?? 0, max: latencies[latencies.length - 1] ?? 0 },
    signalBreakdown: breakdown,
    perShard: Object.fromEntries(
      [...byShard.entries()].map(([s, rs]) => {
        const lats = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
        return [
          s,
          {
            n: rs.length,
            recallAt10: mean(rs.map((r) => r.recallAt10)),
            recallAt30: mean(rs.map((r) => r.recallAt30)),
            mrr: mean(rs.map((r) => r.reciprocalRank)),
            latencyP50: percentile(lats, 50),
            latencyP95: percentile(lats, 95),
          },
        ];
      }),
    ),
    results,
  };

  writeFileSync(join(outDir, "report.md"), md.join("\n"));
  writeFileSync(join(outDir, "report.json"), JSON.stringify(json, null, 2));

  console.log(`Results → ${outDir}/`);
  console.log(`Examples: ${total}`);
  console.log(
    `Recall@${TOP_K}: ${pct(meanRecall10)}  Recall@${CANDIDATE_K}: ${pct(meanRecall30)}  MRR: ${meanMRR.toFixed(3)}`,
  );
  console.log(`P50: ${p50.toFixed(1)}ms  P95: ${p95.toFixed(1)}ms`);
  if (failures.length > 0) {
    console.log(`\nMisses (${failures.length}):`);
    for (const f of failures) {
      console.log(
        `  ${f.shard}/${f.id}: recall@10=${pct(f.recallAt10)} — ideal=${f.idealPaths.join(",")}`,
      );
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const shards: ShardName[] = shardArg ? [shardArg as ShardName] : [...SHARDS];
  const results: QuestionResult[] = [];
  for (const shard of shards) {
    const examples = loadShard(shard);
    for (const ex of examples) {
      results.push(await runExample(shard, ex));
    }
  }
  report(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
