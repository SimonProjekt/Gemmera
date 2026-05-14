import type { EmbedRequest, EmbedResult, Embedder } from "../contracts";

const DEFAULT_BASE = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "bge-m3";
const DEFAULT_DIM = 1024;
const DEFAULT_BATCH = 32;

interface OllamaEmbedResponse {
  embeddings: number[][];
}

export interface OllamaEmbedderOptions {
  baseUrl?: string;
  model?: string;
  dim?: number;
  batchSize?: number;
}

/**
 * BGE-M3 (or any Ollama-served embedding model) via `POST /api/embed`.
 * Splits requests into batches to keep individual HTTP payloads small,
 * and L2-normalizes returned vectors to satisfy the VectorStore contract.
 */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly batchSize: number;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dim = opts.dim ?? DEFAULT_DIM;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
  }

  async embed(reqs: EmbedRequest[]): Promise<EmbedResult[]> {
    if (reqs.length === 0) return [];
    const out: EmbedResult[] = [];
    for (let i = 0; i < reqs.length; i += this.batchSize) {
      const batch = reqs.slice(i, i + this.batchSize);
      const vecs = await this.callOllama(batch.map((r) => r.text));
      if (vecs.length !== batch.length) {
        throw new Error(
          `Ollama returned ${vecs.length} embeddings for ${batch.length} inputs`,
        );
      }
      for (let j = 0; j < batch.length; j++) {
        const vec = toFloat32(vecs[j]);
        if (vec.length !== this.dim) {
          throw new Error(
            `Ollama returned dim ${vec.length}, expected ${this.dim} for model ${this.model}`,
          );
        }
        out.push({ id: batch[j].id, vec: l2Normalize(vec) });
      }
    }
    return out;
  }

  private async callOllama(input: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as OllamaEmbedResponse;
    return data.embeddings;
  }
}

function toFloat32(arr: number[]): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i];
  return out;
}

function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}
