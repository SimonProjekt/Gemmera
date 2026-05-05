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
