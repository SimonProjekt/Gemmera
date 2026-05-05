/**
 * In-memory BM25 inverted index over chunk text.
 *
 * Documents are keyed by chunk `contentHash` — content-addressed, just like
 * the vector store. A given hash exists in the index at most once even if
 * multiple notes reference identical chunk content. Mutation reference-
 * counting is the wrapper service's job (same model as EmbeddingService:
 * the IngestionStore is the source of truth for whether a hash is still
 * live in the vault).
 */

export interface BM25Hit {
  contentHash: string;
  score: number;
}

export interface BM25Index {
  /** Add or replace a document. Same `contentHash` with the same text is a no-op. */
  addDoc(contentHash: string, text: string): void;
  /** Remove a document if present. No-op for unknown hashes. */
  removeDoc(contentHash: string): void;
  /** True iff `contentHash` is currently in the index. */
  has(contentHash: string): boolean;
  /** Total documents indexed. */
  count(): number;
  /** Top-k hits, highest score first. Empty result if the query has no recognized tokens. */
  search(query: string, topK: number): BM25Hit[];
}
