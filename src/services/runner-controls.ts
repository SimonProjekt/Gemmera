import type { IngestionStore, JobQueue, Reconciler } from "../contracts";
import type { IngestionRunner } from "./ingestion-runner";
import type { RunnerStatus } from "./runner-status";

/**
 * User-facing indexer controls (#15c, #15d). Coordinates the runner, the
 * status observable, and persisted meta state. Single instance owns the
 * pause flag so the on-disk truth and the in-memory state can never drift.
 *
 * Pause persistence: written to `IngestionStore.meta.paused`. On plugin load,
 * `applyPersistedState()` restores the flag before the runner processes any
 * jobs.
 *
 * Rebuild: bumps `meta.rebuildEpoch`. Subsequent reconciles enqueue every
 * note (the hash gate makes warm paths free, so unchanged content is a
 * cheap traversal). A note's `lastEpoch` is stamped after successful ingest;
 * any path whose `lastEpoch < rebuildEpoch` is treated as stale and gets
 * re-enqueued. Resumability is automatic: an interrupted rebuild leaves
 * `lastEpoch` un-bumped on the remaining paths and the next reconcile
 * picks them up.
 */
export class RunnerControls {
  constructor(
    private readonly runner: IngestionRunner,
    private readonly status: RunnerStatus,
    private readonly store: IngestionStore,
    private readonly reconciler: Reconciler,
    private readonly queue: JobQueue,
  ) {}

  async applyPersistedState(): Promise<void> {
    const paused = (await this.store.getMeta("paused")) ?? false;
    this.runner.setPaused(paused);
    this.status.setPaused(paused);
  }

  async pause(): Promise<void> {
    this.runner.setPaused(true);
    this.status.setPaused(true);
    await this.store.setMeta("paused", true);
  }

  async resume(): Promise<void> {
    this.runner.setPaused(false);
    this.status.setPaused(false);
    await this.store.setMeta("paused", false);
    // Nudge the status — the runner may not emit anything immediately.
    this.status.recompute();
  }

  isPaused(): boolean {
    return this.runner.isPaused();
  }

  /**
   * Bump the rebuild epoch and re-enqueue every known note. Resumable: the
   * epoch is persisted before any work is enqueued, so an interrupted rebuild
   * picks up where it left off on next start (any path with `lastEpoch <
   * rebuildEpoch` is still stale).
   */
  async rebuild(): Promise<{ enqueued: number }> {
    const now = Date.now();
    await this.store.setMeta("rebuildEpoch", now);
    await this.store.setMeta("lastRebuiltAt", now);

    // Re-running reconcile is the simplest way to enqueue everything: it
    // walks the vault and pushes an `index` job for every indexable path.
    // The pipeline's hash gate decides whether each note actually re-chunks.
    const result = await this.reconciler.reconcile();
    this.status.recompute();
    return { enqueued: result.enqueuedIndex };
  }

  /** Drain helper for tests. */
  queueSize(): number {
    return this.queue.size();
  }
}
