import type { JobQueue } from "../contracts";
import type { IngestionRunner } from "./ingestion-runner";

/**
 * Subset of IngestionRunner that RunnerStatus actually depends on. Tests
 * pass a plain stub matching this shape; production passes the runner.
 */
export interface RunnerStatusSource {
  onResult(cb: (e: unknown) => void): () => void;
  workSize(): number;
}

export type IndexerPhase = "idle" | "running" | "paused";

export interface RunnerStatusSnapshot {
  phase: IndexerPhase;
  pending: number;
  /**
   * Total jobs observed in the current cold-start batch (high-water mark).
   * Resets when the queue fully drains. `undefined` means the queue is idle.
   */
  total: number | undefined;
  /** Jobs completed in the current batch (`total - pending`). */
  completed: number;
}

const INITIAL: RunnerStatusSnapshot = {
  phase: "idle",
  pending: 0,
  total: undefined,
  completed: 0,
};

/**
 * Aggregates indexing progress for the chat-header pill (#15b) and settings
 * panel (#15f).
 *
 * Strategy: `queue.size()` is the source of truth for pending. We track a
 * batch high-water mark (`high`) that resets to 0 whenever pending hits 0.
 * Recomputes are triggered on:
 *   - queue arrival (from-empty)
 *   - runner result event (per job processed)
 *   - explicit `recompute()` calls (used by the bridge / ingest writer when
 *     they enqueue mid-batch — the queue's `onArrival` only fires from empty,
 *     so callers must poke us when they grow a non-empty queue)
 *
 * Pause is purely a display flag; the controls service (#15c) flips it.
 */
export class RunnerStatus {
  private snapshot: RunnerStatusSnapshot = { ...INITIAL };
  private high = 0;
  private paused = false;
  private listeners = new Set<(s: RunnerStatusSnapshot) => void>();
  private offRunner: (() => void) | null = null;
  private offQueue: (() => void) | null = null;

  constructor(
    private readonly queue: JobQueue,
    private readonly runner: Pick<IngestionRunner, "onResult" | "workSize">,
  ) {}

  start(): void {
    if (this.offRunner) return;
    this.offQueue = this.queue.onArrival(() => this.recompute());
    this.offRunner = this.runner.onResult(() => this.recompute());
    this.recompute();
  }

  stop(): void {
    this.offRunner?.();
    this.offRunner = null;
    this.offQueue?.();
    this.offQueue = null;
  }

  get(): RunnerStatusSnapshot {
    return this.snapshot;
  }

  /**
   * Recompute the snapshot from current queue size. Idempotent — safe to call
   * after any enqueue / dequeue. Bridge and orchestrators call this directly
   * for mid-batch arrivals that `onArrival` would miss.
   */
  recompute(): void {
    // Queue size + in-flight is the true pending count. Reading queue.size()
    // alone would underreport during runner draining, since drain() empties
    // the queue at the start of each batch even though jobs are still in
    // flight inside the for-loop.
    const pending = this.runner.workSize();
    if (pending === 0) {
      this.high = 0;
      this.publish({
        phase: this.paused ? "paused" : "idle",
        pending: 0,
        total: undefined,
        completed: 0,
      });
      return;
    }
    if (pending > this.high) this.high = pending;
    this.publish({
      phase: this.paused ? "paused" : "running",
      pending,
      total: this.high,
      completed: this.high - pending,
    });
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.recompute();
  }

  subscribe(cb: (s: RunnerStatusSnapshot) => void): () => void {
    this.listeners.add(cb);
    cb(this.snapshot);
    return () => this.listeners.delete(cb);
  }

  private publish(next: RunnerStatusSnapshot): void {
    if (
      this.snapshot.phase === next.phase &&
      this.snapshot.pending === next.pending &&
      this.snapshot.total === next.total &&
      this.snapshot.completed === next.completed
    ) {
      return;
    }
    this.snapshot = next;
    for (const l of this.listeners) {
      try {
        l(next);
      } catch {
        // listener errors must not break the loop
      }
    }
  }
}
