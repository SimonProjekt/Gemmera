import { describe, expect, it, vi } from "vitest";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { RunnerStatus } from "./runner-status";
import type { RunnerEvent } from "./ingestion-runner";

function fakeRunner(queue: { size(): number }) {
  const listeners = new Set<(e: RunnerEvent) => void>();
  let inFlight = 0;
  return {
    onResult(cb: (e: RunnerEvent) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    workSize() {
      return queue.size() + inFlight;
    },
    setInFlight(n: number) {
      inFlight = n;
    },
    emit(e: RunnerEvent) {
      for (const l of listeners) l(e);
    },
  };
}

describe("RunnerStatus", () => {
  it("starts idle with no batch", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner(queue);
    const status = new RunnerStatus(queue, runner);
    status.start();
    expect(status.get()).toEqual({ phase: "idle", pending: 0, total: undefined, completed: 0 });
  });

  it("transitions to running on arrival and tracks total via recompute", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner(queue);
    const status = new RunnerStatus(queue, runner);
    status.start();

    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });
    // Arrival only fires from-empty; mid-batch enqueues need an explicit
    // recompute. The bridge does this in production.
    status.recompute();

    expect(status.get()).toMatchObject({ phase: "running", pending: 2, total: 2, completed: 0 });
  });

  it("keeps pending accurate while runner has drained jobs in flight", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner(queue);
    const status = new RunnerStatus(queue, runner);
    status.start();

    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });
    status.recompute();
    expect(status.get()).toMatchObject({ phase: "running", pending: 2, total: 2 });

    // Simulate runner draining both jobs into its in-flight set.
    queue.drain();
    runner.setInFlight(2);
    runner.emit({ kind: "deleted", path: "a.md" });
    // After one event fires the runner has completed one job; in-flight drops.
    runner.setInFlight(1);
    runner.emit({ kind: "deleted", path: "a.md" });
    expect(status.get()).toMatchObject({ phase: "running", pending: 1, total: 2, completed: 1 });

    runner.setInFlight(0);
    runner.emit({ kind: "deleted", path: "b.md" });
    expect(status.get()).toMatchObject({ phase: "idle", pending: 0, total: undefined });
  });

  it("resets batch when queue fully drains, then starts a new one on next arrival", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner(queue);
    const status = new RunnerStatus(queue, runner);
    status.start();

    queue.enqueue({ kind: "index", path: "a.md" });
    queue.drain();
    runner.emit({ kind: "deleted", path: "a.md" });
    expect(status.get()).toMatchObject({ phase: "idle", total: undefined });

    queue.enqueue({ kind: "index", path: "x.md" });
    expect(status.get()).toMatchObject({ phase: "running", pending: 1, total: 1 });
  });

  it("notifies subscribers with current snapshot on subscribe and on change", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner(queue);
    const status = new RunnerStatus(queue, runner);
    status.start();

    const cb = vi.fn();
    status.subscribe(cb);
    expect(cb).toHaveBeenCalledTimes(1); // initial snapshot

    queue.enqueue({ kind: "index", path: "a.md" });
    expect(cb).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "running", pending: 1 }));
  });

  it("setPaused flips phase but keeps pending/total intact", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner(queue);
    const status = new RunnerStatus(queue, runner);
    status.start();

    queue.enqueue({ kind: "index", path: "a.md" });
    status.setPaused(true);
    expect(status.get()).toMatchObject({ phase: "paused", pending: 1, total: 1 });

    status.setPaused(false);
    expect(status.get()).toMatchObject({ phase: "running", pending: 1 });
  });

  it("setPaused is idempotent", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner(queue);
    const status = new RunnerStatus(queue, runner);
    status.start();
    const cb = vi.fn();
    status.subscribe(cb);
    cb.mockClear();

    status.setPaused(false); // already not paused
    expect(cb).not.toHaveBeenCalled();
  });

  it("seeds total from preexisting queue size on start (cold reconcile)", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner(queue);
    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });

    const status = new RunnerStatus(queue, runner);
    status.start();

    expect(status.get()).toMatchObject({ phase: "running", pending: 2, total: 2 });
  });
});

// Integration: real IngestionRunner draining a real queue. Regression for
// "pill drops to idle after first arrival because runner drained at once".
import { IngestionRunner } from "./ingestion-runner";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import type { IngestDecision, IngestionPipeline } from "../contracts";

class SlowPipeline implements IngestionPipeline {
  ran: string[] = [];
  resolve!: () => void;
  gate = new Promise<void>((r) => { this.resolve = r; });
  async ingest(path: string): Promise<IngestDecision> {
    this.ran.push(path);
    // Block until the test releases us. Lets us observe in-flight state.
    await this.gate;
    return {
      kind: "skip",
      state: { path, contentHash: "h", bodyHash: "h", mtime: 0, frontmatter: null },
    };
  }
}

describe("RunnerStatus + real IngestionRunner", () => {
  it("reports pending = total while runner is mid-batch (not zero)", async () => {
    const queue = new InMemoryJobQueue();
    const store = new InMemoryIngestionStore();
    const pipeline = new SlowPipeline();
    const runner = new IngestionRunner(queue, pipeline, store);
    const status = new RunnerStatus(queue, runner);
    status.start();
    runner.start();

    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });
    queue.enqueue({ kind: "index", path: "c.md" });
    status.recompute();

    // Yield once so the runner's microtask kicks and drain() runs. Pending
    // must NOT collapse to zero here — that was the bug.
    await Promise.resolve();
    await Promise.resolve();

    expect(status.get().pending).toBeGreaterThan(0);
    expect(status.get().total).toBe(3);

    // Release the pipeline gate so all jobs finish. Stop the runner.
    pipeline.resolve();
    await runner.drainNow();
    expect(status.get()).toMatchObject({ phase: "idle", pending: 0 });
  });
});
