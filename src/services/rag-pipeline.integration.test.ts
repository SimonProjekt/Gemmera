import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { MockEmbedder } from "../contracts/mocks/mock-embedder";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { BinaryVectorStore } from "./binary-vector-store";
import { EmbeddingService, type EmbeddingEvent } from "./embedding-service";
import { HashGatedIngestionPipeline } from "./ingestion-pipeline";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { IngestionRunner } from "./ingestion-runner";
import { MarkdownChunker } from "./markdown-chunker";

/**
 * End-to-end RAG pipeline test (pre-chat scope).
 *
 * Wires the same components that `src/services/index.ts` builds at plugin
 * load: vault → chunker → ingestion pipeline → runner → embedding service →
 * BinaryVectorStore. Verifies the chain processes vault events into
 * persisted vectors, skips unchanged content on warm reload, evicts orphans
 * on edit, and resets cleanly on model swap.
 */

const DIM = 16;
const MODEL = "mock-embedder";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemmera-rag-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Harness {
  vault: MockVaultService;
  ingestionStore: InMemoryIngestionStore;
  queue: InMemoryJobQueue;
  runner: IngestionRunner;
  embedder: MockEmbedder;
  vectorStore: BinaryVectorStore;
  service: EmbeddingService;
  events: EmbeddingEvent[];
  drain: () => Promise<void>;
}

function harness(model = MODEL, files: Record<string, string> = {}): Harness {
  const vault = new MockVaultService(files);
  const ingestionStore = new InMemoryIngestionStore();
  const pipeline = new HashGatedIngestionPipeline(vault, new MarkdownChunker(), ingestionStore);
  const queue = new InMemoryJobQueue();
  const runner = new IngestionRunner(queue, pipeline, ingestionStore);
  const embedder = new MockEmbedder({ model, dim: DIM });
  const vectorStore = new BinaryVectorStore(
    join(dir, "vectors.bin"),
    join(dir, "vectors.json"),
    model,
    DIM,
  );
  const service = new EmbeddingService(runner, embedder, vectorStore, ingestionStore);
  runner.start();
  service.start();

  const events: EmbeddingEvent[] = [];
  service.onEvent((e) => events.push(e));

  const drain = async () => {
    await runner.drainNow();
    await service.flush();
  };

  return { vault, ingestionStore, queue, runner, embedder, vectorStore, service, events, drain };
}

const NOTE_A = `# Trip notes\n\nWent hiking near Sundsvall in late autumn.\n\n## Day one\n\nLong walk along the coast. The wind was sharp.\n`;
const NOTE_B = `# Project log\n\n## Week 3\n\nWired the embedder service into the plugin lifecycle.\n`;

describe("RAG pipeline integration (pre-chat)", () => {
  it("cold start: indexes every markdown file and persists vectors", async () => {
    const h = harness(MODEL, { "a.md": NOTE_A, "b.md": NOTE_B });
    h.queue.enqueue({ kind: "index", path: "a.md" });
    h.queue.enqueue({ kind: "index", path: "b.md" });
    await h.drain();

    expect(await h.vectorStore.count()).toBeGreaterThan(0);
    expect(await h.ingestionStore.list()).toEqual(["a.md", "b.md"]);

    // Every embedded chunk's hash is present in the vector store.
    const chunksA = await h.ingestionStore.getChunks("a.md");
    const chunksB = await h.ingestionStore.getChunks("b.md");
    for (const c of [...chunksA, ...chunksB]) {
      expect(await h.vectorStore.has(c.contentHash)).toBe(true);
    }

    expect(h.events.some((e) => e.kind === "embedded")).toBe(true);
    expect(h.events.some((e) => e.kind === "error")).toBe(false);
  });

  it("warm reload: re-enqueueing the same content does not re-embed", async () => {
    const h = harness(MODEL, { "a.md": NOTE_A });
    h.queue.enqueue({ kind: "index", path: "a.md" });
    await h.drain();
    const baselineCalls = h.embedder.calls;
    const baselineCount = await h.vectorStore.count();

    h.queue.enqueue({ kind: "index", path: "a.md" });
    await h.drain();

    expect(h.embedder.calls).toBe(baselineCalls); // pipeline returned `skip`
    expect(await h.vectorStore.count()).toBe(baselineCount);
  });

  it("edit: only the changed chunks are re-embedded; orphan chunks are evicted", async () => {
    const h = harness(MODEL, { "a.md": NOTE_A });
    h.queue.enqueue({ kind: "index", path: "a.md" });
    await h.drain();
    const beforeChunks = await h.ingestionStore.getChunks("a.md");
    const beforeCount = await h.vectorStore.count();
    expect(beforeChunks.length).toBeGreaterThan(0);

    // Replace the body entirely so all old chunk hashes are stale.
    h.vault.setFile("a.md", `# Trip notes\n\nCompletely rewritten body.\n`);
    h.queue.enqueue({ kind: "index", path: "a.md" });
    await h.drain();

    for (const c of beforeChunks) {
      expect(await h.vectorStore.has(c.contentHash)).toBe(false);
    }
    const afterChunks = await h.ingestionStore.getChunks("a.md");
    for (const c of afterChunks) {
      expect(await h.vectorStore.has(c.contentHash)).toBe(true);
    }
    expect(await h.vectorStore.count()).toBe(afterChunks.length);
    expect(h.events.some((e) => e.kind === "evicted")).toBe(true);
    void beforeCount;
  });

  it("delete job: ingestion entry is removed; vectors persist as content-addressed cache", async () => {
    const h = harness(MODEL, { "a.md": NOTE_A });
    h.queue.enqueue({ kind: "index", path: "a.md" });
    await h.drain();
    const chunks = await h.ingestionStore.getChunks("a.md");
    const countBefore = await h.vectorStore.count();
    expect(chunks.length).toBeGreaterThan(0);

    h.queue.enqueue({ kind: "delete", path: "a.md" });
    await h.drain();

    expect(await h.ingestionStore.get("a.md")).toBeNull();
    // Embedding service intentionally treats `deleted` as a no-op — vectors
    // are content-addressed and may be referenced again. Verify that contract.
    expect(await h.vectorStore.count()).toBe(countBefore);
  });

  it("rename job: ingestion entry moves to new path; content-addressed vectors stay live", async () => {
    const h = harness(MODEL, { "a.md": NOTE_A });
    h.queue.enqueue({ kind: "index", path: "a.md" });
    await h.drain();
    const chunks = await h.ingestionStore.getChunks("a.md");

    h.queue.enqueue({ kind: "rename", from: "a.md", to: "renamed.md" });
    await h.drain();

    expect(await h.ingestionStore.get("a.md")).toBeNull();
    expect(await h.ingestionStore.get("renamed.md")).not.toBeNull();
    for (const c of chunks) {
      expect(await h.vectorStore.has(c.contentHash)).toBe(true);
    }
  });

  it("metadata-only change: frontmatter edit preserves vectors and skips embedding", async () => {
    const h = harness(MODEL, { "a.md": `---\ntitle: A\n---\n${NOTE_A}` });
    h.queue.enqueue({ kind: "index", path: "a.md" });
    await h.drain();
    const callsAfterFirst = h.embedder.calls;
    const countAfterFirst = await h.vectorStore.count();

    // Same body, different frontmatter → bodyHash unchanged, contentHash changes.
    h.vault.setFile("a.md", `---\ntitle: A (edited)\n---\n${NOTE_A}`);
    h.queue.enqueue({ kind: "index", path: "a.md" });
    await h.drain();

    expect(h.embedder.calls).toBe(callsAfterFirst);
    expect(await h.vectorStore.count()).toBe(countAfterFirst);
  });

  it("model swap: existing vectors are reset and the next ingest re-embeds everything", async () => {
    // First indexing run under model A, against the same on-disk store paths.
    const a = harness("model-a", { "a.md": NOTE_A });
    a.queue.enqueue({ kind: "index", path: "a.md" });
    await a.drain();
    const chunks = await a.ingestionStore.getChunks("a.md");
    expect(await a.vectorStore.count()).toBe(chunks.length);
    await a.runner.stop();
    await a.service.stop();

    // Second run under model B reuses the same dir → BinaryVectorStore detects
    // the model mismatch on load and resets. EmbeddingService must re-embed.
    const b = harness("model-b", { "a.md": NOTE_A });
    expect(await b.vectorStore.count()).toBe(0); // reset on construction-load
    b.queue.enqueue({ kind: "index", path: "a.md" });
    await b.drain();

    expect(b.embedder.calls).toBeGreaterThan(0);
    expect(await b.vectorStore.count()).toBe(chunks.length);
    expect(b.vectorStore.metadata().model).toBe("model-b");
  });

  it("embedder error on one job does not poison the queue", async () => {
    const h = harness(MODEL, { "a.md": NOTE_A, "b.md": NOTE_B });
    let calls = 0;
    vi.spyOn(h.embedder, "embed").mockImplementation(async (reqs) => {
      calls++;
      if (calls === 1) throw new Error("ollama down");
      return reqs.map((r) => ({ id: r.id, vec: new Float32Array(DIM) }));
    });

    h.queue.enqueue({ kind: "index", path: "a.md" });
    h.queue.enqueue({ kind: "index", path: "b.md" });
    await h.drain();

    expect(h.events.some((e) => e.kind === "error")).toBe(true);
    expect(h.events.some((e) => e.kind === "embedded")).toBe(true);
    // b.md's chunks survived the failure of a.md.
    const chunksB = await h.ingestionStore.getChunks("b.md");
    for (const c of chunksB) {
      expect(await h.vectorStore.has(c.contentHash)).toBe(true);
    }
  });
});
