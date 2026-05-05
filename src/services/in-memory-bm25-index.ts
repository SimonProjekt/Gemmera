import type { BM25Hit, BM25Index } from "../contracts/bm25-index";

const K1 = 1.2;
const B = 0.75;

interface DocStats {
  /** Total token count in the doc — the `|d|` in BM25's normalization. */
  length: number;
  /** Token → term frequency within this doc. */
  tf: Map<string, number>;
}

/**
 * In-memory BM25. Tokenizer lowercases and splits on non-letter/non-digit
 * boundaries using Unicode classes, so Swedish å/ä/ö (and equivalent
 * non-ASCII letters) are preserved as single tokens. No stopword filter
 * and no stemming in v1 — both can land later if the golden set demands.
 *
 * Memory note: JS Map of Map is heavy. A 5K-note vault at ~10 chunks/note,
 * ~100 unique tokens/chunk, gives ~5M entries — workable but worth keeping
 * in mind. The structure favors update simplicity over compactness; an
 * array-backed posting list would be tighter but more painful to mutate.
 */
export class InMemoryBM25Index implements BM25Index {
  // contentHash → doc stats
  private docs = new Map<string, DocStats>();
  // token → (contentHash → tf). Mirrors per-doc tf so search is one map walk.
  private postings = new Map<string, Map<string, number>>();
  private totalLength = 0;

  addDoc(contentHash: string, text: string): void {
    if (this.docs.has(contentHash)) return; // idempotent — content-addressed
    const tf = countTokens(tokenize(text));
    let length = 0;
    for (const c of tf.values()) length += c;

    this.docs.set(contentHash, { length, tf });
    this.totalLength += length;

    for (const [token, count] of tf) {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = new Map();
        this.postings.set(token, posting);
      }
      posting.set(contentHash, count);
    }
  }

  removeDoc(contentHash: string): void {
    const doc = this.docs.get(contentHash);
    if (!doc) return;

    this.totalLength -= doc.length;
    this.docs.delete(contentHash);

    for (const token of doc.tf.keys()) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      posting.delete(contentHash);
      if (posting.size === 0) this.postings.delete(token);
    }
  }

  has(contentHash: string): boolean {
    return this.docs.has(contentHash);
  }

  count(): number {
    return this.docs.size;
  }

  search(query: string, topK: number): BM25Hit[] {
    if (topK <= 0 || this.docs.size === 0) return [];
    const queryTokens = unique(tokenize(query));
    if (queryTokens.length === 0) return [];

    const N = this.docs.size;
    const avgdl = this.totalLength / N;
    const scores = new Map<string, number>();

    for (const token of queryTokens) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (const [hash, tf] of posting) {
        const dl = this.docs.get(hash)!.length;
        const denom = tf + K1 * (1 - B + (B * dl) / avgdl);
        const contribution = idf * ((tf * (K1 + 1)) / denom);
        scores.set(hash, (scores.get(hash) ?? 0) + contribution);
      }
    }

    if (scores.size === 0) return [];
    const hits: BM25Hit[] = [];
    for (const [hash, score] of scores) hits.push({ contentHash: hash, score });
    // Stable secondary sort on contentHash so equal-score ties are deterministic.
    hits.sort((a, b) => b.score - a.score || a.contentHash.localeCompare(b.contentHash));
    return hits.slice(0, topK);
  }
}

/** Lowercase + split on non-letter/non-digit (Unicode). Empty tokens dropped. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function countTokens(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
