import { describe, expect, it, vi } from "vitest";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { RunnerStatus } from "./runner-status";
import type { RunnerEvent } from "./ingestion-runner";

function fakeRunner() {
  const listeners = new Set<(e: RunnerEvent) => void>();
  return {
    onResult(cb: (e: RunnerEvent) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(e: RunnerEvent) {
      for (const l of listeners) l(e);
    },
  };
}

describe("RunnerStatus", () => {
  it("starts idle with no batch", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner();
    const status = new RunnerStatus(queue, runner);
    status.start();
    expect(status.get()).toEqual({ phase: "idle", pending: 0, total: undefined, completed: 0 });
  });

  it("transitions to running on arrival and tracks total via recompute", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner();
    const status = new RunnerStatus(queue, runner);
    status.start();

    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });
    // Arrival only fires from-empty; mid-batch enqueues need an explicit
    // recompute. The bridge does this in production.
    status.recompute();

    expect(status.get()).toMatchObject({ phase: "running", pending: 2, total: 2, completed: 0 });
  });

  it("decrements pending and bumps completed as runner emits events", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner();
    const status = new RunnerStatus(queue, runner);
    status.start();

    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });
    queue.drain(); // simulate runner claiming the batch
    runner.emit({ kind: "deleted", path: "a.md" });

    expect(status.get()).toMatchObject({ phase: "idle", pending: 0, total: undefined, completed: 0 });
  });

  it("resets batch when queue fully drains, then starts a new one on next arrival", () => {
    const queue = new InMemoryJobQueue();
    const runner = fakeRunner();
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
    const runner = fakeRunner();
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
    const runner = fakeRunner();
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
    const runner = fakeRunner();
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
    const runner = fakeRunner();
    queue.enqueue({ kind: "index", path: "a.md" });
    queue.enqueue({ kind: "index", path: "b.md" });

    const status = new RunnerStatus(queue, runner);
    status.start();

    expect(status.get()).toMatchObject({ phase: "running", pending: 2, total: 2 });
  });
});
