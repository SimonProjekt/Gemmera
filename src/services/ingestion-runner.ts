import type {
  IndexJob,
  IngestDecision,
  IngestionPipeline,
  IngestionStore,
  JobQueue,
} from "../contracts";

export type RunnerEvent =
  | { kind: "decision"; job: IndexJob; decision: IngestDecision }
  | { kind: "deleted"; path: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "error"; job: IndexJob; error: unknown };

/**
 * Single consumer of the JobQueue. Runs jobs serially through the pipeline
 * and store, broadcasts results to subscribers (the embedder will be one).
 *
 * Lifecycle: start() subscribes to onArrival, stop() unsubscribes and awaits
 * the in-flight loop. Both idempotent. drainNow() runs the queue once and
 * returns when it is empty — used by tests and cold-start reconcile.
 */
export class IngestionRunner {
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private running = false;
  private paused = false;
  private listeners = new Set<(e: RunnerEvent) => void>();
  // Jobs the runner has drained from the queue but has not yet emitted a
  // result for. Necessary because `processUntilEmpty` drains in batches —
  // `queue.size()` alone underreports work-in-progress and would tell
  // RunnerStatus the indexer is idle while 999 jobs are still iterating.
  private inFlightJobs = 0;

  constructor(
    private readonly queue: JobQueue,
    private readonly pipeline: IngestionPipeline,
    private readonly store: IngestionStore,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.queue.onArrival(() => {
      void this.kick();
    });
    // Pick up anything already pending at start time.
    if (this.queue.size() > 0) void this.kick();
  }

  /**
   * Halt new job claims. In-flight jobs run to completion. While paused,
   * arrivals enqueue but don't run; resume() re-kicks the loop.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!paused && this.queue.size() > 0) void this.kick();
  }

  isPaused(): boolean {
    return this.paused;
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await this.inFlight;
  }

  onResult(cb: (e: RunnerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isIdle(): boolean {
    return !this.running && this.queue.size() === 0 && this.inFlightJobs === 0;
  }

  /**
   * Total work the runner currently knows about: queued + drained-but-not-
   * yet-emitted. RunnerStatus reads this so the chat-header pill reflects
   * actual progress rather than dropping to "idle" the moment the runner
   * empties the queue at the start of a batch.
   */
  workSize(): number {
    return this.queue.size() + this.inFlightJobs;
  }

  /** Run the queue until empty. Safe to call concurrently — work coalesces. */
  drainNow(): Promise<void> {
    return this.kick();
  }

  private kick(): Promise<void> {
    // Chain onto the existing inFlight so concurrent kicks share a single loop.
    const next = this.inFlight.then(() => this.processUntilEmpty());
    this.inFlight = next.catch(() => undefined);
    return next;
  }

  private async processUntilEmpty(): Promise<void> {
    this.running = true;
    try {
      while (!this.paused && this.queue.size() > 0) {
        const jobs = this.queue.drain();
        this.inFlightJobs += jobs.length;
        for (const job of jobs) {
          if (this.paused) {
            // Re-queue jobs we drained but haven't started. Order is
            // preserved because nothing else has run between drain and
            // re-enqueue. Decrement in-flight by one for each job moved
            // back to the queue so workSize() stays consistent.
            this.queue.enqueue(job);
            this.inFlightJobs--;
            continue;
          }
          let event: RunnerEvent;
          try {
            event = await this.runOne(job);
          } catch (error) {
            event = { kind: "error", job, error };
          }
          // Decrement BEFORE emit. Listeners (RunnerStatus) read workSize()
          // from inside the emit callback; a job about to emit a result
          // must already be counted as done, not in flight.
          this.inFlightJobs--;
          this.emit(event);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(job: IndexJob): Promise<RunnerEvent> {
    if (job.kind === "index") {
      const decision = await this.pipeline.ingest(job.path);
      return { kind: "decision", job, decision };
    }
    if (job.kind === "delete") {
      await this.store.delete(job.path);
      return { kind: "deleted", path: job.path };
    }
    // rename
    const prior = await this.store.get(job.from);
    if (prior) {
      await this.store.rename(job.from, job.to);
      return { kind: "renamed", from: job.from, to: job.to };
    }
    // Unknown source — fall through to a normal index of the new path.
    const decision = await this.pipeline.ingest(job.to);
    return { kind: "decision", job, decision };
  }

  private emit(event: RunnerEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // listener errors must not break the loop
      }
    }
  }
}
