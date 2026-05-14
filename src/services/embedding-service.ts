import type { Chunk, Embedder, IngestionStore, VectorStore } from "../contracts";
import type { IngestionRunner } from "./ingestion-runner";

export type EmbeddingEvent =
  | { kind: "embedded"; path: string; count: number }
  | { kind: "skipped"; path: string; count: number }
  | { kind: "evicted"; path: string; count: number }
  | { kind: "error"; path: string | null; error: unknown };

/**
 * Bridges runner decisions to the vector store. Subscribes to the runner,
 * picks up `rechunk` decisions, dedupes chunks by contentHash, skips ones
 * already in the store, and writes the rest. All work is serialized through
 * a single inFlight promise — the embedder is the slow path and we don't
 * want concurrent HTTP calls hammering Ollama.
 *
 * Vectors are content-addressed via VectorStore, so `deleted` and `renamed`
 * events are intentional no-ops here. Stale vectors are tolerated cache;
 * a model swap (handled at VectorStore construction) is the only thing that
 * invalidates the cache.
 */
export class EmbeddingService {
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private listeners = new Set<(e: EmbeddingEvent) => void>();
  private running = false;

  constructor(
    private readonly runner: Pick<IngestionRunner, "onResult">,
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly ingestionStore: IngestionStore,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.runner.onResult((event) => {
      if (event.kind !== "decision") return;
      if (event.decision.kind !== "rechunk") return;
      this.schedule(event.decision.chunks, event.decision.priorChunks);
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await this.inFlight;
  }

  onEvent(cb: (e: EmbeddingEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isIdle(): boolean {
    return !this.running;
  }

  /** Wait for any pending work to finish. Test/cold-start affordance. */
  flush(): Promise<void> {
    return this.inFlight;
  }

  private schedule(chunks: Chunk[], priorChunks: Chunk[]): void {
    if (chunks.length === 0 && priorChunks.length === 0) return;
    const next = this.inFlight.then(() => this.process(chunks, priorChunks));
    this.inFlight = next.catch(() => undefined);
  }

  private async process(chunks: Chunk[], priorChunks: Chunk[]): Promise<void> {
    this.running = true;
    const path = chunks[0]?.path ?? priorChunks[0]?.path ?? "";
    try {
      await this.evictOrphans(path, chunks, priorChunks);

      if (chunks.length === 0) return;

      // Dedupe by contentHash within the batch (same content can repeat).
      const byHash = new Map<string, Chunk>();
      for (const c of chunks) byHash.set(c.contentHash, c);

      // Filter out hashes already embedded under the active model.
      const todo: Chunk[] = [];
      for (const chunk of byHash.values()) {
        if (await this.store.has(chunk.contentHash)) continue;
        todo.push(chunk);
      }

      const skipped = byHash.size - todo.length;
      if (todo.length === 0) {
        this.emit({ kind: "skipped", path, count: skipped });
        return;
      }

      const results = await this.embedder.embed(
        todo.map((c) => ({ id: c.contentHash, text: c.textForEmbed })),
      );
      for (const r of results) {
        await this.store.upsert(r.id, r.vec);
      }
      this.emit({ kind: "embedded", path, count: results.length });
    } catch (error) {
      this.emit({ kind: "error", path: path || null, error });
    } finally {
      this.running = false;
    }
  }

  private async evictOrphans(path: string, chunks: Chunk[], priorChunks: Chunk[]): Promise<void> {
    if (priorChunks.length === 0) return;
    const live = new Set(chunks.map((c) => c.contentHash));
    let evicted = 0;
    for (const prior of priorChunks) {
      if (live.has(prior.contentHash)) continue;
      // Another note may still reference this content. The IngestionStore is
      // post-ingest by the time we run, so its current state is authoritative.
      if (await this.ingestionStore.isHashReferenced(prior.contentHash)) continue;
      await this.store.delete(prior.contentHash);
      evicted++;
    }
    if (evicted > 0) this.emit({ kind: "evicted", path, count: evicted });
  }

  private emit(event: EmbeddingEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // listener errors must not break the loop
      }
    }
  }
}
