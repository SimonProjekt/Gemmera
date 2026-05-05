import type {
  IndexJob,
  IngestionPipeline,
  IngestionStore,
  JobQueue,
  JobRunner,
} from "../contracts";

export interface JobRunnerLogger {
  error(message: string, ...rest: unknown[]): void;
}

const CONSOLE_LOGGER: JobRunnerLogger = {
  error: (msg, ...rest) => console.error(`[gemmera] ${msg}`, ...rest),
};

/**
 * Drains the queue, dispatches jobs to the ingestion pipeline / store, and
 * survives individual job failures (logs and continues — the next event for
 * the same path will retry).
 *
 * Single-flight: at most one drain runs at a time. If new jobs arrive while a
 * drain is in flight, a follow-up drain kicks off after the current one ends.
 */
export class IndexJobRunner implements JobRunner {
  private unsubArrival: (() => void) | null = null;
  private inFlight: Promise<void> | null = null;
  private kickPending = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly pipeline: IngestionPipeline,
    private readonly store: IngestionStore,
    private readonly logger: JobRunnerLogger = CONSOLE_LOGGER,
  ) {}

  start(): void {
    if (this.unsubArrival) return; // idempotent
    this.unsubArrival = this.queue.onArrival(() => this.kick());
    if (this.queue.size() > 0) this.kick();
  }

  stop(): void {
    this.unsubArrival?.();
    this.unsubArrival = null;
    // Let the in-flight drain complete; do not cancel mid-job.
  }

  async drain(): Promise<void> {
    while (this.queue.size() > 0) {
      const jobs = this.queue.drain();
      for (const job of jobs) {
        try {
          await this.process(job);
        } catch (err) {
          this.logger.error("job failed", { job, err });
        }
      }
    }
  }

  private kick(): void {
    if (this.inFlight) {
      this.kickPending = true;
      return;
    }
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
      if (this.kickPending) {
        this.kickPending = false;
        this.kick();
      }
    });
  }

  private async process(job: IndexJob): Promise<void> {
    switch (job.kind) {
      case "index":
        await this.pipeline.ingest(job.path);
        return;
      case "delete":
        await this.store.delete(job.path);
        return;
      case "rename": {
        const existing = await this.store.get(job.from);
        if (existing) {
          await this.store.rename(job.from, job.to);
        } else {
          // Source was never indexed (e.g. moved into scope from out-of-scope,
          // or a fresh file renamed before we saw it). Fall back to a normal
          // ingest of the destination — the hash gate ensures it's cheap if
          // we did have it under a different path.
          await this.pipeline.ingest(job.to);
        }
        return;
      }
    }
  }
}
