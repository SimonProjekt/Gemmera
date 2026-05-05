export interface VectorStoreMetadata {
  model: string;
  dim: number;
}

export interface SearchHit {
  contentHash: string;
  score: number;
}

/**
 * Content-addressed embedding cache. Keyed on the chunk's `contentHash`
 * (which the chunker derives from `textForEmbed`, so identical content
 * across notes shares one vector). Knows nothing about chunks, paths,
 * or notes — retrieval joins SearchHit.contentHash to chunk metadata
 * via IngestionStore separately.
 *
 * Vectors are expected to be L2-normalized so search reduces to dot
 * product. Implementations may either accept normalized input or
 * normalize on upsert; both are valid as long as it's documented.
 *
 * Single-model per store instance: the manifest pins one (model, dim)
 * pair. Constructing a store with a different model than the on-disk
 * manifest resets the store (re-embed everything). This is correct
 * because vectors from different models occupy incomparable spaces.
 */
export interface VectorStore {
  metadata(): VectorStoreMetadata;
  /** True if a vector exists for `contentHash` under the active model. */
  has(contentHash: string): Promise<boolean>;
  /** Persist a vector. Length must equal metadata().dim. */
  upsert(contentHash: string, vec: Float32Array): Promise<void>;
  /** Remove a vector. No-op if unknown. */
  delete(contentHash: string): Promise<void>;
  /** Top-K most similar entries by dot product. Returns empty array on cold store. */
  search(queryVec: Float32Array, topK: number): Promise<SearchHit[]>;
  /** Number of stored vectors. */
  count(): Promise<number>;
  /** Test/dev convenience: drop all vectors and rewrite the manifest. */
  reset(): Promise<void>;
}
