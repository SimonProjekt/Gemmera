import type { Chunk } from "./chunker";

export interface NoteState {
  path: string;
  contentHash: string; // sha256 of raw file bytes
  bodyHash: string; // sha256 of body after frontmatter strip
  mtime: number;
  frontmatter: string | null; // raw YAML between --- fences, null if absent
  /**
   * Rebuild epoch this note was last processed under (#15d). When the user
   * triggers "Rebuild index", the global `rebuildEpoch` meta value is bumped;
   * any note with `lastEpoch < rebuildEpoch` is treated as stale by the
   * reconciler and re-enqueued. Resumability falls out for free: an interrupted
   * rebuild just leaves some `lastEpoch` values un-bumped.
   */
  lastEpoch?: number;
}

/**
 * Drift summary produced by the weekly reconciler (#15e). Counts what changed
 * between the disk vault and the ingestion store since the last reconcile.
 */
export interface DriftReport {
  ranAt: number;
  added: string[];
  removed: string[];
  hashChanged: string[];
}

/**
 * Process-wide ingestion metadata — runtime knobs that need to survive plugin
 * reloads. Distinct from per-note state because it's keyed by setting name,
 * not path. Persisted in the same JSON store under a separate `meta` namespace.
 */
export interface IngestionMeta {
  paused: boolean;
  rebuildEpoch: number;
  lastReconciledAt: number;
  lastRebuiltAt: number;
  lastDriftReport: DriftReport | null;
}

export const DEFAULT_INGESTION_META: IngestionMeta = {
  paused: false,
  rebuildEpoch: 0,
  lastReconciledAt: 0,
  lastRebuiltAt: 0,
  lastDriftReport: null,
};

export type IngestDecision =
  | { kind: "skip"; state: NoteState }
  | { kind: "metadata-only"; state: NoteState }
  /**
   * Body changed: emit the new chunks plus the prior set so downstream
   * consumers (notably the embedder) can compute a contentHash diff and
   * evict orphaned vectors without re-querying the store. `priorChunks`
   * is `[]` for a first-time ingest.
   */
  | { kind: "rechunk"; state: NoteState; chunks: Chunk[]; priorChunks: Chunk[] };

export interface IngestOptions {
  mtime?: number;
}

export interface IngestionStore {
  get(path: string): Promise<NoteState | null>;
  getChunks(path: string): Promise<Chunk[]>;
  /** Persist note state and chunks together. Atomic across both. */
  upsert(state: NoteState, chunks: Chunk[]): Promise<void>;
  /** Update note state without touching chunks (frontmatter-only edits). */
  upsertMetadata(state: NoteState): Promise<void>;
  delete(path: string): Promise<void>;
  /**
   * Re-key existing state and chunks from `from` to `to` without touching
   * content or hashes. Pure rename — used when a vault rename event fires
   * and re-embedding is unnecessary. No-op when `from` is unknown.
   */
  rename(from: string, to: string): Promise<void>;
  /** Enumerate all known note paths. Used by the reconciler to find orphans. */
  list(): Promise<string[]>;
  /**
   * True if any stored chunk in any path has the given contentHash. Used by
   * the embedding service to decide whether an orphaned chunkHash can have
   * its vector evicted, or whether another note still references it.
   */
  isHashReferenced(contentHash: string): Promise<boolean>;
  /**
   * Return every chunk currently stored under the given contentHash. A hash
   * may be referenced from more than one path when notes share identical
   * chunk content; all matching `(path, ord)` rows are returned. Used by
   * the retriever to hydrate `RetrievalHit` rows from a hash-keyed search.
   */
  getChunksByHash(contentHash: string): Promise<Chunk[]>;

  /**
   * Read a runtime metadata value (#15). Returns `null` for unset keys so
   * callers can distinguish "never written" from "explicitly false/0".
   */
  getMeta<K extends keyof IngestionMeta>(key: K): Promise<IngestionMeta[K] | null>;

  /** Write a runtime metadata value. Persisted alongside note state. */
  setMeta<K extends keyof IngestionMeta>(key: K, value: IngestionMeta[K]): Promise<void>;

  /**
   * Find note paths whose stored `bodyHash` matches `hash`. Used by the
   * ingest tool loop (#13) to short-circuit exact-content duplicates
   * without paying for an LLM call. Returns `[]` for no match.
   */
  findByBodyHash(hash: string): Promise<string[]>;
}

export interface IngestionPipeline {
  ingest(path: string, opts?: IngestOptions): Promise<IngestDecision>;
}
