import { describe, expect, it } from "vitest";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { IngestionRunner } from "./ingestion-runner";
import { RunnerControls } from "./runner-controls";
import { RunnerStatus } from "./runner-status";
import type {
  IndexJob,
  IngestDecision,
  IngestionPipeline,
  Reconciler,
} from "../contracts";

class StubPipeline implements IngestionPipeline {
  ran: string[] = [];
  async ingest(path: string): Promise<IngestDecision> {
    this.ran.push(path);
    return {
      kind: "skip",
      state: {
        path,
        contentHash: "h",
        bodyHash: "h",
        mtime: 0,
        frontmatter: null,
      },
    };
  }
}

class StubReconciler implements Reconciler {
  constructor(
    private readonly queue: InMemoryJobQueue,
    private readonly paths: string[],
  ) {}
  async reconcile() {
    for (const p of this.paths) this.queue.enqueue({ kind: "index", path: p });
    return { enqueuedIndex: this.paths.length, enqueuedDelete: 0 };
  }
}

function setup(paths: string[] = []) {
  const queue = new InMemoryJobQueue();
  const store = new InMemoryIngestionStore();
  const pipeline = new StubPipeline();
  const runner = new IngestionRunner(queue, pipeline, store);
  const status = new RunnerStatus(queue, runner);
  status.start();
  const reconciler = new StubReconciler(queue, paths);
  const controls = new RunnerControls(runner, status, store, reconciler, queue);
  return { queue, store, pipeline, runner, status, controls };
}

describe("RunnerControls", () => {
  it("pause persists and stops new claims", async () => {
    const { queue, store, controls, runner, pipeline } = setup();
    runner.start();
    await controls.pause();

    queue.enqueue({ kind: "index", path: "a.md" });
    // Allow microtasks to settle. Runner should not have processed.
    await new Promise((r) => setTimeout(r, 5));

    expect(pipeline.ran).toHaveLength(0);
    expect(queue.size()).toBe(1);
    expect(await store.getMeta("paused")).toBe(true);
    expect(controls.isPaused()).toBe(true);
  });

  it("resume drains queued jobs", async () => {
    const { queue, controls, runner, pipeline } = setup();
    runner.start();
    await controls.pause();

    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });
    await controls.resume();
    // Wait for runner to drain.
    await runner.drainNow();

    expect(pipeline.ran).toEqual(["a.md", "b.md"]);
  });

  it("pause survives reload via persisted meta", async () => {
    const { store, controls, runner } = setup();
    runner.start();
    await controls.pause();

    // Simulate reload: new runner/status against the same store.
    const queue2 = new InMemoryJobQueue();
    const pipeline2 = new StubPipeline();
    const runner2 = new IngestionRunner(queue2, pipeline2, store);
    const status2 = new RunnerStatus(queue2, runner2);
    status2.start();
    const reconciler2 = new StubReconciler(queue2, []);
    const controls2 = new RunnerControls(runner2, status2, store, reconciler2, queue2);
    runner2.start();
    await controls2.applyPersistedState();

    expect(controls2.isPaused()).toBe(true);
    queue2.enqueue({ kind: "index", path: "x.md" } as IndexJob);
    await new Promise((r) => setTimeout(r, 5));
    expect(pipeline2.ran).toHaveLength(0);
  });

  it("rebuild bumps rebuildEpoch and re-enqueues everything", async () => {
    const { store, controls } = setup(["a.md", "b.md"]);
    const result = await controls.rebuild();
    expect(result.enqueued).toBe(2);

    const epoch = await store.getMeta("rebuildEpoch");
    expect(typeof epoch).toBe("number");
    expect((epoch as number) > 0).toBe(true);
  });

  it("reconcileNow stamps lastReconciledAt", async () => {
    const { store, controls } = setup(["a.md"]);
    const before = Date.now();
    await controls.reconcileNow();
    const ts = (await store.getMeta("lastReconciledAt")) ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before);
  });
});
