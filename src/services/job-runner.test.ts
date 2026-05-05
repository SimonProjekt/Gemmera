import { describe, expect, it, vi } from "vitest";
import type {
  Chunk,
  IngestDecision,
  IngestionPipeline,
  NoteState,
} from "../contracts";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { IndexJobRunner } from "./job-runner";

const sampleState = (path: string): NoteState => ({
  path,
  contentHash: "c",
  bodyHash: "b",
  mtime: 0,
  frontmatter: null,
});

const sampleChunk = (path: string): Chunk => ({
  path,
  ord: 0,
  headingPath: ["t"],
  text: "x",
  textForEmbed: "t\n\nx",
  tokenCount: 1,
  contentHash: "h",
});

class StubPipeline implements IngestionPipeline {
  ingested: string[] = [];
  shouldFail: Set<string> = new Set();
  async ingest(path: string): Promise<IngestDecision> {
    this.ingested.push(path);
    if (this.shouldFail.has(path)) throw new Error("boom");
    return { kind: "skip", state: sampleState(path) };
  }
}

const setup = () => {
  const queue = new InMemoryJobQueue();
  const pipeline = new StubPipeline();
  const store = new InMemoryIngestionStore();
  const errors: unknown[] = [];
  const runner = new IndexJobRunner(queue, pipeline, store, {
    error: (msg, ...rest) => errors.push([msg, rest]),
  });
  return { queue, pipeline, store, runner, errors };
};

describe("IndexJobRunner", () => {
  it("dispatches index jobs to the pipeline", async () => {
    const { queue, pipeline, runner } = setup();
    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });
    await runner.drain();
    expect(pipeline.ingested).toEqual(["a.md", "b.md"]);
    expect(queue.size()).toBe(0);
  });

  it("dispatches delete jobs to the store", async () => {
    const { queue, store, runner } = setup();
    await store.upsert(sampleState("a.md"), [sampleChunk("a.md")]);
    queue.enqueue({ kind: "delete", path: "a.md" });
    await runner.drain();
    expect(await store.get("a.md")).toBeNull();
  });

  it("rename re-keys existing entries without re-embedding", async () => {
    const { queue, pipeline, store, runner } = setup();
    await store.upsert(sampleState("a.md"), [sampleChunk("a.md")]);
    queue.enqueue({ kind: "rename", from: "a.md", to: "moved/b.md" });
    await runner.drain();
    expect(pipeline.ingested).toEqual([]); // no re-embed
    expect(await store.get("a.md")).toBeNull();
    expect(await store.get("moved/b.md")).not.toBeNull();
  });

  it("rename falls back to ingest when source is unknown", async () => {
    const { queue, pipeline, store, runner } = setup();
    queue.enqueue({ kind: "rename", from: "ghost.md", to: "new.md" });
    await runner.drain();
    expect(pipeline.ingested).toEqual(["new.md"]);
    expect(await store.get("ghost.md")).toBeNull();
  });

  it("survives an individual job failure and continues draining", async () => {
    const { queue, pipeline, runner, errors } = setup();
    pipeline.shouldFail.add("bad.md");
    queue.enqueue({ kind: "index", path: "ok1.md" });
    queue.enqueue({ kind: "index", path: "bad.md" });
    queue.enqueue({ kind: "index", path: "ok2.md" });
    await runner.drain();
    expect(pipeline.ingested).toEqual(["ok1.md", "bad.md", "ok2.md"]);
    expect(errors).toHaveLength(1);
  });

  it("start() drains autonomously when jobs arrive", async () => {
    const { queue, pipeline, runner } = setup();
    runner.start();
    queue.enqueue({ kind: "index", path: "a.md" });
    await vi.waitFor(() => expect(pipeline.ingested).toEqual(["a.md"]));
    runner.stop();
  });

  it("start() picks up jobs already in the queue", async () => {
    const { queue, pipeline, runner } = setup();
    queue.enqueue({ kind: "index", path: "preloaded.md" });
    runner.start();
    await vi.waitFor(() => expect(pipeline.ingested).toEqual(["preloaded.md"]));
    runner.stop();
  });

  it("start() and stop() are idempotent", () => {
    const { runner } = setup();
    runner.start();
    runner.start();
    runner.stop();
    runner.stop();
  });

  it("processes jobs that arrive while a drain is in flight", async () => {
    const { queue, pipeline, runner } = setup();
    runner.start();
    queue.enqueue({ kind: "index", path: "first.md" });
    // Enqueue a second job synchronously after the first; the runner should
    // catch up and process both without stopping early.
    queue.enqueue({ kind: "index", path: "second.md" });
    await vi.waitFor(() =>
      expect(pipeline.ingested.sort()).toEqual(["first.md", "second.md"]),
    );
    runner.stop();
  });
});
