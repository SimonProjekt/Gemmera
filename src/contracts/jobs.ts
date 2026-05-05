export type IndexJob =
  | { kind: "index"; path: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; from: string; to: string };

export interface JobQueue {
  /** Append a job. Consecutive duplicates of the same job are coalesced. */
  enqueue(job: IndexJob): void;
  /** Return all pending jobs in FIFO order and clear the queue. */
  drain(): IndexJob[];
  size(): number;
  /** Subscribe to "queue grew from empty" notifications. Returns an unsubscribe fn. */
  onArrival(cb: () => void): () => void;
}

export interface PathFilter {
  shouldIndex(path: string): boolean;
}

export interface UserIgnoreMatcher {
  matches(path: string): boolean;
}

/**
 * Cold-start reconciliation. Vault events only cover changes while the plugin
 * is running; on load, files may have been added, deleted, or edited
 * externally. The runner calls `reconcile()` once after subscribing to events:
 *
 *   1. List vault files; enqueue an `index` job for each. The hash gate in
 *      the ingestion pipeline (#5) makes warm reloads a near no-op — only
 *      changed files actually re-chunk.
 *   2. Find store entries whose path is no longer in the vault; enqueue a
 *      `delete` job for each.
 *
 * Live event subscription (#4) and reconcile (this) together cover every
 * vault state transition. Numbers returned are for telemetry / status bar.
 */
export interface Reconciler {
  reconcile(): Promise<{ enqueuedIndex: number; enqueuedDelete: number }>;
}

/**
 * Drains the JobQueue and dispatches each job to the right side of the
 * pipeline. Autonomous once started: subscribes to JobQueue.onArrival and
 * drains in the background. `drain()` is exposed for deterministic testing
 * (and for the reconciler bootstrap path).
 */
export interface JobRunner {
  start(): void;
  stop(): void;
  /** Process all currently-pending jobs and return when the queue is empty. */
  drain(): Promise<void>;
}
