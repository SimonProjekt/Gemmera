export interface EmbedRequest {
  /** Caller-chosen identity carried back in the result. Typically the chunk's contentHash. */
  id: string;
  text: string;
}

export interface EmbedResult {
  id: string;
  vec: Float32Array;
}

/**
 * Pure embedding model. Stateless — the service handles batching, deduping,
 * and persistence (via VectorStore). Implementations declare their model
 * name and dimension; VectorStore pins those at construction so a model
 * swap invalidates the cache automatically.
 *
 * Vectors returned MUST be L2-normalized so VectorStore search can reduce
 * to dot product.
 */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(reqs: EmbedRequest[]): Promise<EmbedResult[]>;
}
