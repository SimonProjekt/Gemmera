import { createHash } from "node:crypto";
import type { EmbedRequest, EmbedResult, Embedder } from "../embedder";

/**
 * Deterministic test embedder. Hashes the input text into a normalized vector
 * of the configured dim. Same text → same vector across runs and instances,
 * so tests can assert vectors equal across calls.
 */
export class MockEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  calls = 0;
  totalRequests = 0;

  constructor(opts: { model?: string; dim?: number } = {}) {
    this.model = opts.model ?? "mock-embedder";
    this.dim = opts.dim ?? 16;
  }

  async embed(reqs: EmbedRequest[]): Promise<EmbedResult[]> {
    this.calls++;
    this.totalRequests += reqs.length;
    return reqs.map((r) => ({ id: r.id, vec: textToVec(r.text, this.dim) }));
  }
}

function textToVec(text: string, dim: number): Float32Array {
  const seed = createHash("sha256").update(text, "utf8").digest();
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = (seed[i % seed.length] / 255) * 2 - 1;
  return l2Normalize(vec);
}

function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}
