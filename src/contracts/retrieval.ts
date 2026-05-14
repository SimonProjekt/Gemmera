/**
 * Retrieval contracts shared between the hybrid retriever (#8), the
 * payload assembler (#10), the (deferred) reranker (#9), and the query
 * tool loop (#14). Pinned here so those four can be built in parallel
 * against typed boundaries.
 *
 * Layered model:
 *
 *   query  ──►  Retriever         ──►  RetrievalHit[]
 *               (#8 hybrid;             (this is the
 *                #9 reranker is          contract you
 *                a Retriever too)        slot anything
 *                                        between).
 *
 *   RetrievalHit[]  ──►  PayloadAssembler  ──►  RetrievalPayload
 *                        (#10 — bounds size,    (this is what
 *                         resolves neighbors,   the chat loop
 *                         enforces citations)   sends to Gemma)
 */

/**
 * The signal that promoted this row to the top-k. Tagged on every result
 * so the UI can render *why* a match surfaced ("matched on backlink to
 * project log") and so #16's eval harness can compute per-signal recall.
 *
 * The union is forward-compatible: `tag` and `recency` are listed so
 * downstream consumers (rerankers, payload assemblers, eval) don't need
 * to be revised when those signals come online — even though the v1
 * HybridRetriever only emits `semantic | lexical | backlink`.
 */
export type WinningSignal = "semantic" | "lexical" | "backlink" | "tag" | "recency";

/**
 * One result row from the retriever. Identity + content + provenance.
 *
 * `score` is the fused score the retriever sorted by; higher is better.
 * It is comparable across rows in the same response but NOT across
 * retriever implementations or runs (different fusions, different scales).
 *
 * One-hop link neighbors are intentionally *not* on this struct —
 * `LinksIndex` is cheap to query, and forcing the retriever to enrich
 * every row would couple it to a piece of state it doesn't otherwise
 * own. The PayloadAssembler is responsible for that join.
 */
export interface RetrievalHit {
  // --- identity ---
  /** Note path in the vault (e.g. "Projects/Gemmera.md"). */
  path: string;
  /** Note basename without `.md`. Pre-resolved so consumers don't re-derive. */
  title: string;
  /** Chunk ordinal within the note. Stable tiebreaker for equal scores. */
  ord: number;
  /** Chunk content hash. Use for citation IDs and dedup. */
  contentHash: string;

  // --- content ---
  /** Raw chunk body, NOT `textForEmbed`. Safe to render to the user. */
  text: string;
  /** Section path leading to the chunk, e.g. ["Trip notes", "Day one"]. */
  headingPath: string[];

  // --- provenance ---
  /** Fused score, higher = more relevant. Comparable within one response. */
  score: number;
  /** Which signal promoted this row. */
  winningSignal: WinningSignal;
}

export interface RetrieveOptions {
  /**
   * Maximum number of hits to return. Implementations may return fewer.
   * Suggested defaults:
   *   30 for the pre-rerank retriever (#16 measures Recall@30)
   *    8 for a post-rerank retriever feeding directly into the payload
   */
  topK?: number;
}

export interface Retriever {
  /**
   * Run a query and return ranked hits, highest score first.
   *
   * Must return [] when the underlying indexes are empty (cold start
   * before reconcile). May throw on empty/invalid `query`.
   */
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrievalHit[]>;
}

// --- Payload (Retriever output → chat loop input) ---

/**
 * One chunk as it appears in the bounded Gemma payload. Mirrors
 * `RetrievalHit` but adds the link-neighbor enrichment from #10 and
 * narrows the signal name to `whyMatched` (the tag the prompt template
 * surfaces to the model).
 */
export interface PayloadChunk {
  path: string;
  title: string;
  headingPath: string[];
  text: string;
  whyMatched: WinningSignal;
  /** Present when the assembler is configured to forward scores (default false). */
  score?: number;
  /** Resolved 1-hop neighbor note titles, deduped. Empty if the assembler is configured to skip them. */
  neighbors?: string[];
}

export interface RetrievalPayload {
  /** The query the chunks were retrieved for. Carried through for the prompt template. */
  query: string;
  /** Chunks in retriever-order, capped by the assembler's `maxChunks`. */
  chunks: PayloadChunk[];
}

export interface PayloadAssemblerOptions {
  /** Max chunks in the payload. Default 8 per planning/rag.md §"What to send to Gemma". */
  maxChunks?: number;
  /** Forward `score` onto each PayloadChunk. Default false (Gemma doesn't need it for grounding). */
  includeScores?: boolean;
  /** Look up 1-hop neighbors via LinksIndex and attach them. Default true. */
  includeNeighbors?: boolean;
  /** Cap on neighbor titles per chunk. Default 5 — keeps payload bounded for noisy hubs. */
  maxNeighborsPerChunk?: number;
}

export interface PayloadAssembler {
  assemble(
    query: string,
    hits: RetrievalHit[],
    opts?: PayloadAssemblerOptions,
  ): RetrievalPayload;
}
