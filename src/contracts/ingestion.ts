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
  | { kind: "rechunk"; state: NoteState; chunks: Chunk[] };

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
}

export interface IngestionPipeline {
  ingest(path: string, opts?: IngestOptions): Promise<IngestDecision>;
}
