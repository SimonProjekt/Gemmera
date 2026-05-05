import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { MockEmbedder } from "../contracts/mocks/mock-embedder";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import type { RetrievalHit, SearchHit, VectorStore } from "../contracts";
import { BM25IndexService } from "./bm25-index-service";
import { EmbeddingService } from "./embedding-service";
import { HybridRetriever } from "./hybrid-retriever";
import { HashGatedIngestionPipeline } from "./ingestion-pipeline";
import { InMemoryBM25Index } from "./in-memory-bm25-index";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { InMemoryLinksIndex } from "./in-memory-links-index";
import { IngestionRunner } from "./ingestion-runner";
import { LinksIndexService } from "./links-index-service";
import { MarkdownChunker } from "./markdown-chunker";

const FIXTURE_DIR = join(__dirname, "..", "..", "evals", "golden", "fixtures", "link-graph");
const DIM = 16;

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

interface Pipeline {
  vault: MockVaultService;
  bm25: InMemoryBM25Index;
  links: InMemoryLinksIndex;
  vectorStore: InMemoryVectorStore;
  store: InMemoryIngestionStore;
  retriever: HybridRetriever;
  /** Same retriever wiring but with an empty LinksIndex — for boost-vs-no-boost comparisons. */
  retrieverNoLinks: HybridRetriever;
}

async function buildPipeline(files: Record<string, string>): Promise<Pipeline> {
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
  const emptyLinks = new InMemoryLinksIndex();
  const retrieverNoLinks = new HybridRetriever(embedder, vectorStore, bm25, emptyLinks, store);

  return { vault, bm25, links, vectorStore, store, retriever, retrieverNoLinks };
}

async function loadFixtureVault(): Promise<Record<string, string>> {
  const entries = await readdir(FIXTURE_DIR);
  const files: Record<string, string> = {};
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const text = await readFile(join(FIXTURE_DIR, name), "utf8");
    files[`link-graph/${name}`] = text;
  }
  return files;
}

function rankOf(hits: RetrievalHit[], path: string): number {
  return hits.findIndex((h) => h.path === path);
}

describe("HybridRetriever integration (link-graph fixture)", () => {
  let p: Pipeline;
  let files: Record<string, string>;

  beforeAll(async () => {
    files = await loadFixtureVault();
    p = await buildPipeline(files);
  });

  it("indexes every fixture file across all three indexes", async () => {
    const expectedPaths = Object.keys(files).sort();
    expect((await p.store.list()).sort()).toEqual(expectedPaths);
    expect(p.bm25.count()).toBeGreaterThan(0);
    expect(await p.vectorStore.count()).toBe(p.bm25.count());
    expect(p.links.size()).toBe(expectedPaths.length);
  });

  it("captures the link graph: migration-project links to migration-followups", () => {
    const out = p.links.outgoing("link-graph/migration-project.md");
    const targets = out.filter((l) => l.resolved).map((l) => l.target);
    expect(targets).toContain("link-graph/migration-followups.md");
    expect(p.links.backlinks("link-graph/migration-followups.md")).toContain(
      "link-graph/migration-project.md",
    );
  });

  it("captures backlink fan-in: bookshelf-build is linked from project-a and project-b", () => {
    const back = p.links.backlinks("link-graph/bookshelf-build.md");
    expect(back).toEqual(
      expect.arrayContaining(["link-graph/project-a.md", "link-graph/project-b.md"]),
    );
  });

  it("retrieve() returns RetrievalHit[] with all required fields", async () => {
    const hits = await p.retriever.retrieve("migration project", { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.path).toMatch(/^link-graph\//);
      expect(h.title).not.toMatch(/\//);
      expect(h.text.length).toBeGreaterThan(0);
      expect(h.score).toBeGreaterThan(0);
      expect(["semantic", "lexical", "backlink"]).toContain(h.winningSignal);
    }
  });

  it("retrieval is deterministic: identical queries return identical hits", async () => {
    const q = "migration project follow-up tasks";
    const r1 = await p.retriever.retrieve(q, { topK: 5 });
    const r2 = await p.retriever.retrieve(q, { topK: 5 });
    expect(r1).toEqual(r2);
  });

  it("link-boost causes orderings to differ between with-links and without-links retrievers", async () => {
    // Sanity check that the LinksIndex is actually being consulted: at least
    // one query produces a *different* ordering depending on whether link-graph
    // is plugged in. We don't assert which direction the difference goes here
    // — the mock embedder makes per-query rank-flipping unreliable. Rigorous
    // boost-effect validation against ideal-paths is in #16's golden-set
    // eval harness, which runs against a real embedder.
    const queries = [
      "migration project follow-up tasks",
      "which projects mentioned the bookshelf build",
      "first prototype attempt",
    ];
    let differingQueries = 0;
    for (const q of queries) {
      const withLinks = await p.retriever.retrieve(q, { topK: 6 });
      const withoutLinks = await p.retrieverNoLinks.retrieve(q, { topK: 6 });
      const a = withLinks.map((h) => h.path).join(",");
      const b = withoutLinks.map((h) => h.path).join(",");
      if (a !== b) differingQueries++;
    }
    expect(differingQueries).toBeGreaterThan(0);
  });

  it("at least one query produces a `backlink`-tagged hit when link-graph is plugged in", async () => {
    const queries = [
      "migration project follow-up tasks",
      "which projects mentioned the bookshelf build",
      "first prototype attempt",
    ];
    let sawBacklinkTag = false;
    for (const q of queries) {
      const hits = await p.retriever.retrieve(q, { topK: 6 });
      if (hits.some((h) => h.winningSignal === "backlink")) sawBacklinkTag = true;
    }
    expect(sawBacklinkTag).toBe(true);
  });

  it("a query whose terms appear in no chunk still produces well-formed hits via the semantic side", async () => {
    // The embedder encodes any string into a vector, so semantic search will
    // always have candidates even when BM25 is empty. We assert the shape is
    // sane, not the tag distribution — link-graph overlap in the candidate
    // set can still produce `backlink`-tagged hits.
    const hits = await p.retriever.retrieve("xyzzy plugh nonsense", { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.path).toMatch(/^link-graph\//);
      expect(["semantic", "backlink"]).toContain(h.winningSignal); // never "lexical" — BM25 had no hits
    }
  });
});
