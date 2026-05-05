import type { BM25Index, Chunk, IngestionStore } from "../contracts";
import type { IngestionRunner, RunnerEvent } from "./ingestion-runner";

export type BM25IndexEvent =
  | { kind: "added"; path: string; count: number }
  | { kind: "evicted"; path: string; count: number }
  | { kind: "skipped"; path: string }
  | { kind: "error"; path: string | null; error: unknown };

/**
 * Bridges runner decisions to a BM25Index — the lexical-signal counterpart
 * to EmbeddingService. Same orphan-eviction semantics: documents are
 * content-addressed by `contentHash`, so `deleted` and `renamed` events
 * are intentional no-ops, and stale postings get cleaned up on the next
 * `rechunk` decision whose `priorChunks` include the orphan hash.
 *
 * Reads `textForEmbed` (the chunker's structured form: heading path +
 * body) so BM25 sees the same surface as the embedder.
 */
export class BM25IndexService {
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private listeners = new Set<(e: BM25IndexEvent) => void>();

  constructor(
    private readonly runner: Pick<IngestionRunner, "onResult">,
    private readonly index: BM25Index,
    private readonly ingestionStore: IngestionStore,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.runner.onResult((event) => {
      if (event.kind !== "decision") return;
      if (event.decision.kind !== "rechunk") return;
      this.schedule(event.decision.state.path, event.decision.chunks, event.decision.priorChunks);
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await this.inFlight;
  }

  onEvent(cb: (e: BM25IndexEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  flush(): Promise<void> {
    return this.inFlight;
  }

  private schedule(path: string, chunks: Chunk[], priorChunks: Chunk[]): void {
    if (chunks.length === 0 && priorChunks.length === 0) return;
    const next = this.inFlight.then(() => this.process(path, chunks, priorChunks));
    this.inFlight = next.catch(() => undefined);
  }

  private async process(path: string, chunks: Chunk[], priorChunks: Chunk[]): Promise<void> {
    try {
      // Evict orphans from prior set before adding new — keeps doc counts honest
      // if a chunk's hash happens to be both old and new (idempotent addDoc would
      // have masked the issue, but the ordering is more obvious this way).
      let evicted = 0;
      const liveHashes = new Set(chunks.map((c) => c.contentHash));
      for (const prior of priorChunks) {
        if (liveHashes.has(prior.contentHash)) continue;
        if (await this.ingestionStore.isHashReferenced(prior.contentHash)) continue;
        if (this.index.has(prior.contentHash)) {
          this.index.removeDoc(prior.contentHash);
          evicted++;
        }
      }
      if (evicted > 0) this.emit({ kind: "evicted", path, count: evicted });

      // Dedupe new chunks by contentHash (a chunk may appear multiple times in
      // a single rechunk batch).
      const byHash = new Map<string, Chunk>();
      for (const c of chunks) byHash.set(c.contentHash, c);

      let added = 0;
      for (const c of byHash.values()) {
        if (this.index.has(c.contentHash)) continue;
        this.index.addDoc(c.contentHash, c.textForEmbed);
        added++;
      }
      if (added > 0) this.emit({ kind: "added", path, count: added });
      else if (evicted === 0) this.emit({ kind: "skipped", path });
    } catch (error) {
      this.emit({ kind: "error", path: path || null, error });
    }
  }

  private emit(event: BM25IndexEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // listener errors must not break the loop
      }
    }
  }
}
