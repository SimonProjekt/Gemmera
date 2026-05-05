import type { Chunk } from "./chunker";

export interface NoteState {
  path: string;
  contentHash: string; // sha256 of raw file bytes
  bodyHash: string; // sha256 of body after frontmatter strip
  mtime: number;
  frontmatter: string | null; // raw YAML between --- fences, null if absent
}

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
}

export interface IngestionPipeline {
  ingest(path: string, opts?: IngestOptions): Promise<IngestDecision>;
}
