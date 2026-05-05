import { describe, expect, it, vi } from "vitest";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { MockEmbedder } from "../contracts/mocks/mock-embedder";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import type { Chunk, SearchHit, VectorStore } from "../contracts";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { EmbeddingService, type EmbeddingEvent } from "./embedding-service";
import { HashGatedIngestionPipeline } from "./ingestion-pipeline";
import { IngestionRunner } from "./ingestion-runner";
import { MarkdownChunker } from "./markdown-chunker";

class InMemoryVectorStore implements VectorStore {
  private vectors = new Map<string, Float32Array>();
  constructor(private readonly _model = "mock-embedder", private readonly _dim = 16) {}
  metadata() {
    return { model: this._model, dim: this._dim };
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
  async search(_q: Float32Array, _k: number): Promise<SearchHit[]> {
    return [];
  }
  async count() {
    return this.vectors.size;
  }
  async reset() {
    this.vectors.clear();
  }
}

function makeChunks(path: string, n: number, sharedHashes: string[] = []): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < n; i++) {
    const hash = sharedHashes[i] ?? `${path}-h${i}`;
    out.push({
      path,
      ord: i,
      headingPath: ["t"],
      text: `body-${i}`,
      textForEmbed: `t > body-${i}`,
      tokenCount: 1,
      contentHash: hash,
    });
  }
  return out;
}

function ringSetup() {
  const vault = new MockVaultService();
  const ingestionStore = new InMemoryIngestionStore();
  const pipeline = new HashGatedIngestionPipeline(vault, new MarkdownChunker(), ingestionStore);
  const queue = new InMemoryJobQueue();
  const runner = new IngestionRunner(queue, pipeline, ingestionStore);
  const embedder = new MockEmbedder();
  const vectorStore = new InMemoryVectorStore();
  const service = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
  const events: EmbeddingEvent[] = [];
  service.onEvent((e) => events.push(e));
  return { runner, embedder, vectorStore, ingestionStore, service, events };
}

function fakeRunner() {
  let cb: ((e: import("./ingestion-runner").RunnerEvent) => void) | null = null;
  return {
    onResult(handler: (e: import("./ingestion-runner").RunnerEvent) => void) {
      cb = handler;
      return () => {
        cb = null;
      };
    },
    emit(e: import("./ingestion-runner").RunnerEvent) {
      cb?.(e);
    },
    isAttached() {
      return cb !== null;
    },
  };
}

describe("EmbeddingService", () => {
  it("embeds chunks from a rechunk decision and writes them to the vector store", async () => {
    const { service, embedder, vectorStore, ingestionStore, events } = ringSetup();
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
    const got: EmbeddingEvent[] = [];
    svc.onEvent((e) => got.push(e));
    svc.start();

    const chunks = makeChunks("a.md", 3);
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: anyState("a.md"), chunks, priorChunks: [] },
    });
    await svc.flush();

    expect(await vectorStore.count()).toBe(3);
    expect(got[0]).toMatchObject({ kind: "embedded", path: "a.md", count: 3 });
    void service; // unused
    void events;
  });

  it("skips chunks whose contentHash is already embedded", async () => {
    const { service, embedder, vectorStore, ingestionStore } = ringSetup();
    const chunks = makeChunks("a.md", 2);
    for (const c of chunks) await vectorStore.upsert(c.contentHash, new Float32Array(16));
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
    const got: EmbeddingEvent[] = [];
    svc.onEvent((e) => got.push(e));
    svc.start();

    const embedSpy = vi.spyOn(embedder, "embed");
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: anyState("a.md"), chunks, priorChunks: [] },
    });
    await svc.flush();

    expect(embedSpy).not.toHaveBeenCalled();
    expect(got[0]).toMatchObject({ kind: "skipped", count: 2 });
    void service;
  });

  it("dedupes duplicate contentHash within one decision", async () => {
    const { embedder, vectorStore, ingestionStore } = ringSetup();
    const chunks = makeChunks("a.md", 3, ["x", "x", "y"]);
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
    svc.start();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: anyState("a.md"), chunks, priorChunks: [] },
    });
    await svc.flush();
    expect(embedder.totalRequests).toBe(2);
    expect(await vectorStore.count()).toBe(2);
  });

  it("ignores non-rechunk decisions and ignores deleted/renamed events", async () => {
    const { embedder, vectorStore, ingestionStore } = ringSetup();
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
    svc.start();
    const embedSpy = vi.spyOn(embedder, "embed");

    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "skip", state: anyState("a.md") },
    });
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "metadata-only", state: anyState("a.md") },
    });
    runner.emit({ kind: "deleted", path: "a.md" });
    runner.emit({ kind: "renamed", from: "a.md", to: "b.md" });
    await svc.flush();
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("processes consecutive decisions serially", async () => {
    const { vectorStore, ingestionStore } = ringSetup();
    let inFlight = 0;
    let maxParallel = 0;
    const slow: import("../contracts").Embedder = {
      model: "slow",
      dim: 16,
      async embed(reqs) {
        inFlight++;
        maxParallel = Math.max(maxParallel, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return reqs.map((r) => ({ id: r.id, vec: new Float32Array(16) }));
      },
    };
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, slow, vectorStore, ingestionStore);
    svc.start();
    for (let i = 0; i < 4; i++) {
      runner.emit({
        kind: "decision",
        job: { kind: "index", path: `${i}.md` },
        decision: {
          kind: "rechunk",
          state: anyState(`${i}.md`),
          chunks: makeChunks(`${i}.md`, 1),
          priorChunks: [],
        },
      });
    }
    await svc.flush();
    expect(maxParallel).toBe(1);
  });

  it("emits error and continues on embedder failure", async () => {
    const { vectorStore, ingestionStore } = ringSetup();
    let calls = 0;
    const flaky: import("../contracts").Embedder = {
      model: "flaky",
      dim: 16,
      async embed(reqs) {
        calls++;
        if (calls === 1) throw new Error("network down");
        return reqs.map((r) => ({ id: r.id, vec: new Float32Array(16) }));
      },
    };
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, flaky, vectorStore, ingestionStore);
    const got: EmbeddingEvent[] = [];
    svc.onEvent((e) => got.push(e));
    svc.start();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: anyState("a.md"), chunks: makeChunks("a.md", 1), priorChunks: [] },
    });
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "b.md" },
      decision: { kind: "rechunk", state: anyState("b.md"), chunks: makeChunks("b.md", 1), priorChunks: [] },
    });
    await svc.flush();
    expect(got[0].kind).toBe("error");
    expect(got[1].kind).toBe("embedded");
    expect(await vectorStore.count()).toBe(1);
  });

  it("stop() unsubscribes and awaits in-flight", async () => {
    const { vectorStore, ingestionStore } = ringSetup();
    let resolveSlow: (results: import("../contracts").EmbedResult[]) => void = () => {};
    const slowPromise = new Promise<import("../contracts").EmbedResult[]>((r) => {
      resolveSlow = r;
    });
    const slow: import("../contracts").Embedder = {
      model: "slow",
      dim: 16,
      embed: () => slowPromise,
    };
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, slow, vectorStore, ingestionStore);
    svc.start();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: {
        kind: "rechunk",
        state: anyState("a.md"),
        chunks: makeChunks("a.md", 1, ["x"]),
        priorChunks: [],
      },
    });
    const stopped = svc.stop();
    resolveSlow([{ id: "x", vec: new Float32Array(16) }]);
    await stopped;
    expect(await vectorStore.has("x")).toBe(true);

    // After stop, new emits should not produce work.
    expect(runner.isAttached()).toBe(false);
  });

  it("evicts orphaned vectors when chunks disappear and nothing else references them", async () => {
    const { embedder, vectorStore, ingestionStore } = ringSetup();
    const old = makeChunks("a.md", 2, ["old1", "old2"]);
    const next = makeChunks("a.md", 1, ["new1"]);
    // Seed: store reflects post-ingest state (next chunks live, old chunks gone).
    await ingestionStore.upsert(anyState("a.md"), next);
    // Pre-existing vectors for the old hashes simulate prior embeddings.
    for (const c of old) await vectorStore.upsert(c.contentHash, new Float32Array(16));
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
    const got: EmbeddingEvent[] = [];
    svc.onEvent((e) => got.push(e));
    svc.start();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: anyState("a.md"), chunks: next, priorChunks: old },
    });
    await svc.flush();
    expect(await vectorStore.has("old1")).toBe(false);
    expect(await vectorStore.has("old2")).toBe(false);
    expect(await vectorStore.has("new1")).toBe(true);
    expect(got.find((e) => e.kind === "evicted")).toMatchObject({ count: 2 });
  });

  it("keeps orphaned vectors that are still referenced by another note", async () => {
    const { embedder, vectorStore, ingestionStore } = ringSetup();
    const shared = makeChunks("b.md", 1, ["shared"]);
    // Another note still references "shared" after a.md drops it.
    await ingestionStore.upsert(anyState("b.md"), shared);
    await ingestionStore.upsert(anyState("a.md"), []); // a.md now has no chunks
    await vectorStore.upsert("shared", new Float32Array(16));
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
    svc.start();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: {
        kind: "rechunk",
        state: anyState("a.md"),
        chunks: [],
        priorChunks: makeChunks("a.md", 1, ["shared"]),
      },
    });
    await svc.flush();
    expect(await vectorStore.has("shared")).toBe(true);
  });

  it("does not evict when priorChunks is empty (first-time ingest)", async () => {
    const { embedder, vectorStore, ingestionStore } = ringSetup();
    const deleteSpy = vi.spyOn(vectorStore, "delete");
    const runner = fakeRunner();
    const svc = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
    svc.start();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: {
        kind: "rechunk",
        state: anyState("a.md"),
        chunks: makeChunks("a.md", 1),
        priorChunks: [],
      },
    });
    await svc.flush();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

function anyState(path: string) {
  return { path, contentHash: "c", bodyHash: "b", mtime: 0, frontmatter: null };
}
