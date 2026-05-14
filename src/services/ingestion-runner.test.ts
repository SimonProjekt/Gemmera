import { describe, expect, it, vi } from "vitest";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import type {
  IndexJob,
  IngestDecision,
  IngestionPipeline,
  IngestionStore,
  JobQueue,
} from "../contracts";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { HashGatedIngestionPipeline } from "./ingestion-pipeline";
import { IngestionRunner, type RunnerEvent } from "./ingestion-runner";
import { MarkdownChunker } from "./markdown-chunker";

function realPipeline(files: Record<string, string>) {
  const vault = new MockVaultService(files);
  const store = new InMemoryIngestionStore();
  const pipeline = new HashGatedIngestionPipeline(vault, new MarkdownChunker(), store);
  return { vault, store, pipeline };
}

function harness(pipeline: IngestionPipeline, store: IngestionStore) {
  const queue = new InMemoryJobQueue();
  const runner = new IngestionRunner(queue, pipeline, store);
  const events: RunnerEvent[] = [];
  runner.onResult((e) => events.push(e));
  return { queue, runner, events };
}

describe("IngestionRunner", () => {
  it("processes an index job and emits a decision", async () => {
    const { pipeline, store } = realPipeline({ "a.md": "# A\n\nbody" });
    const { queue, runner, events } = harness(pipeline, store);
    runner.start();
    queue.enqueue({ kind: "index", path: "a.md" });
    await runner.drainNow();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("decision");
    if (events[0].kind === "decision") {
      expect(events[0].decision.kind).toBe("rechunk");
    }
  });

  it("processes a delete job via the store and emits deleted", async () => {
    const { pipeline, store } = realPipeline({ "a.md": "# A\n\nbody" });
    const { queue, runner, events } = harness(pipeline, store);
    runner.start();
    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "delete", path: "a.md" });
    await runner.drainNow();
    expect(await store.get("a.md")).toBeNull();
    expect(events.some((e) => e.kind === "deleted")).toBe(true);
  });

  it("rename with known source uses store.rename, no pipeline call", async () => {
    const { pipeline, store } = realPipeline({ "a.md": "# A\n\nbody" });
    const ingestSpy = vi.spyOn(pipeline, "ingest");
    const { queue, runner, events } = harness(pipeline, store);
    runner.start();
    queue.enqueue({ kind: "index", path: "a.md" });
    await runner.drainNow();
    ingestSpy.mockClear();

    queue.enqueue({ kind: "rename", from: "a.md", to: "b.md" });
    await runner.drainNow();

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(await store.get("a.md")).toBeNull();
    expect(await store.get("b.md")).not.toBeNull();
    expect(events.at(-1)?.kind).toBe("renamed");
  });

  it("rename with unknown source falls back to ingesting the new path", async () => {
    const { vault, pipeline, store } = realPipeline({ "b.md": "# B\n\nbody" });
    void vault;
    const ingestSpy = vi.spyOn(pipeline, "ingest");
    const { queue, runner, events } = harness(pipeline, store);
    runner.start();
    queue.enqueue({ kind: "rename", from: "ghost.md", to: "b.md" });
    await runner.drainNow();
    expect(ingestSpy).toHaveBeenCalledWith("b.md");
    expect(events.at(-1)?.kind).toBe("decision");
  });

  it("runs jobs serially even when many are queued together", async () => {
    let inFlight = 0;
    let maxParallel = 0;
    const pipeline: IngestionPipeline = {
      async ingest(path: string): Promise<IngestDecision> {
        inFlight++;
        maxParallel = Math.max(maxParallel, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return {
          kind: "rechunk",
          state: { path, contentHash: path, bodyHash: path, mtime: 0, frontmatter: null },
          chunks: [],
          priorChunks: [],
        };
      },
    };
    const store = new InMemoryIngestionStore();
    const { queue, runner } = harness(pipeline, store);
    runner.start();
    for (const path of ["a.md", "b.md", "c.md", "d.md"]) {
      queue.enqueue({ kind: "index", path });
    }
    await runner.drainNow();
    expect(maxParallel).toBe(1);
  });

  it("picks up jobs that arrive during processing", async () => {
    let secondEnqueued = false;
    const order: string[] = [];
    const pipeline: IngestionPipeline = {
      async ingest(path: string): Promise<IngestDecision> {
        order.push(path);
        if (!secondEnqueued) {
          secondEnqueued = true;
          queue.enqueue({ kind: "index", path: "b.md" });
        }
        return {
          kind: "rechunk",
          state: { path, contentHash: path, bodyHash: path, mtime: 0, frontmatter: null },
          chunks: [],
          priorChunks: [],
        };
      },
    };
    const store = new InMemoryIngestionStore();
    const queue: JobQueue = new InMemoryJobQueue();
    const runner = new IngestionRunner(queue, pipeline, store);
    runner.start();
    queue.enqueue({ kind: "index", path: "a.md" });
    await runner.drainNow();
    expect(order).toEqual(["a.md", "b.md"]);
  });

  it("emits error when pipeline throws and continues with the next job", async () => {
    const calls: string[] = [];
    const pipeline: IngestionPipeline = {
      async ingest(path: string): Promise<IngestDecision> {
        calls.push(path);
        if (path === "boom.md") throw new Error("kaboom");
        return {
          kind: "rechunk",
          state: { path, contentHash: path, bodyHash: path, mtime: 0, frontmatter: null },
          chunks: [],
          priorChunks: [],
        };
      },
    };
    const store = new InMemoryIngestionStore();
    const { queue, runner, events } = harness(pipeline, store);
    runner.start();
    queue.enqueue({ kind: "index", path: "boom.md" });
    queue.enqueue({ kind: "index", path: "ok.md" });
    await runner.drainNow();
    expect(calls).toEqual(["boom.md", "ok.md"]);
    expect(events[0].kind).toBe("error");
    expect(events[1].kind).toBe("decision");
  });

  it("start is idempotent and does not double-subscribe", async () => {
    const { pipeline, store } = realPipeline({ "a.md": "# A\n\nbody" });
    const { queue, runner } = harness(pipeline, store);
    const ingestSpy = vi.spyOn(pipeline, "ingest");
    runner.start();
    runner.start();
    queue.enqueue({ kind: "index", path: "a.md" });
    await runner.drainNow();
    expect(ingestSpy).toHaveBeenCalledTimes(1);
  });

  it("stop unsubscribes and awaits in-flight work", async () => {
    let resolveSlow: () => void = () => {};
    const slow = new Promise<void>((r) => (resolveSlow = r));
    const pipeline: IngestionPipeline = {
      async ingest(path: string): Promise<IngestDecision> {
        await slow;
        return {
          kind: "rechunk",
          state: { path, contentHash: path, bodyHash: path, mtime: 0, frontmatter: null },
          chunks: [],
          priorChunks: [],
        };
      },
    };
    const store = new InMemoryIngestionStore();
    const { queue, runner, events } = harness(pipeline, store);
    runner.start();
    queue.enqueue({ kind: "index", path: "a.md" });
    const stopped = runner.stop();
    resolveSlow();
    await stopped;
    expect(events).toHaveLength(1);
    // After stop, new enqueues should not fire the runner.
    queue.enqueue({ kind: "index", path: "b.md" });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
  });

  it("drainNow runs pending jobs without start()", async () => {
    const { pipeline, store } = realPipeline({ "a.md": "# A\n\nbody" });
    const { queue, runner, events } = harness(pipeline, store);
    queue.enqueue({ kind: "index", path: "a.md" });
    await runner.drainNow();
    expect(events).toHaveLength(1);
    expect(runner.isIdle()).toBe(true);
  });
});
