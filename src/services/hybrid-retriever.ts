import type {
  BM25Index,
  Chunk,
  Embedder,
  IngestionStore,
  LinksIndex,
  RetrievalHit,
  RetrieveOptions,
  Retriever,
  SearchHit,
  VectorStore,
  WinningSignal,
} from "../contracts";

const RRF_K = 60;
const CANDIDATE_FACTOR = 5;
const LINK_BOOST_PER_NEIGHBOR = 0.15;
const LINK_BOOST_CAP = 2.0;
const DEFAULT_TOP_K = 30;

/**
 * Hybrid retriever for #8.
 *
 * Strategy
 *  1. Take top-`(K * CANDIDATE_FACTOR)` candidates from semantic and lexical
 *     search separately. Union by `contentHash`.
 *  2. Fuse using Reciprocal Rank Fusion (RRF). RRF is robust against the
 *     fact that BM25 and cosine produce scores on completely different
 *     scales — it only cares about ranks.
 *  3. For each candidate, expand to its `(path, ord)` chunks via
 *     `IngestionStore.getChunksByHash`. A chunk hash may be shared across
 *     notes; each chunk produces its own hit.
 *  4. Apply the multiplicative link-graph boost: count how many *other*
 *     candidate paths the chunk's note links to or is linked from, and
 *     scale the RRF score by `min(LINK_BOOST_CAP, 1 + α * overlap)`.
 *  5. Tag `winningSignal` by whichever of the three contributions
 *     (semantic-rank, lexical-rank, link-boost-excess) was largest.
 *  6. Sort by fused score, slice to `topK`.
 *
 * Returns [] when both indexes are empty. Throws on empty/whitespace queries
 * (the embedder would fail anyway, surfacing it earlier is friendlier).
 */
export class HybridRetriever implements Retriever {
  constructor(
    private readonly embedder: Embedder,
    private readonly vectorStore: Pick<VectorStore, "search">,
    private readonly bm25: Pick<BM25Index, "search">,
    private readonly links: LinksIndex,
    private readonly ingestionStore: Pick<IngestionStore, "getChunksByHash">,
  ) {}

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievalHit[]> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("HybridRetriever: empty query");
    const topK = opts.topK ?? DEFAULT_TOP_K;
    if (topK <= 0) return [];
    const candidateK = topK * CANDIDATE_FACTOR;

    // 1. Run both signals in parallel. Embedding is the slow path.
    const [qVecResult, lexHits] = await Promise.all([
      this.embedder.embed([{ id: "__q__", text: trimmed }]),
      Promise.resolve(this.bm25.search(trimmed, candidateK)),
    ]);
    const qVec = qVecResult[0]?.vec;
    const semHits: SearchHit[] = qVec ? await this.vectorStore.search(qVec, candidateK) : [];
    if (semHits.length === 0 && lexHits.length === 0) return [];

    // 2. Build per-signal rank tables.
    const semRank = new Map<string, number>();
    semHits.forEach((h, i) => semRank.set(h.contentHash, i));
    const lexRank = new Map<string, number>();
    lexHits.forEach((h, i) => lexRank.set(h.contentHash, i));

    const candidates = new Set<string>([...semRank.keys(), ...lexRank.keys()]);

    // 3. Hydrate to chunks. One hash → potentially many chunks (shared content).
    const hydrated: HydratedCandidate[] = [];
    for (const hash of candidates) {
      const chunks = await this.ingestionStore.getChunksByHash(hash);
      for (const chunk of chunks) {
        hydrated.push({ hash, chunk });
      }
    }
    if (hydrated.length === 0) return [];

    // 4. Link-graph boost. The "neighbor set" for a chunk is the set of
    //    *candidate paths* that its note either links to or is linked from.
    const candidatePaths = new Set(hydrated.map((c) => c.chunk.path));

    const scored: ScoredHit[] = hydrated.map(({ hash, chunk }) => {
      const sR = semRank.get(hash);
      const lR = lexRank.get(hash);
      const semContribution = sR !== undefined ? 1 / (RRF_K + sR + 1) : 0;
      const lexContribution = lR !== undefined ? 1 / (RRF_K + lR + 1) : 0;
      const baseFused = semContribution + lexContribution;

      const overlap = countNeighborOverlap(this.links, chunk.path, candidatePaths);
      const boost = Math.min(LINK_BOOST_CAP, 1 + LINK_BOOST_PER_NEIGHBOR * overlap);
      const linkExcess = baseFused * (boost - 1);
      const fused = baseFused + linkExcess;

      const winningSignal = pickSignal(semContribution, lexContribution, linkExcess);
      return { chunk, hash, fused, winningSignal };
    });

    // 5. Sort and slice. Stable secondary sort on (path, ord) for determinism.
    scored.sort(
      (a, b) =>
        b.fused - a.fused ||
        a.chunk.path.localeCompare(b.chunk.path) ||
        a.chunk.ord - b.chunk.ord,
    );

    return scored.slice(0, topK).map(({ chunk, hash, fused, winningSignal }) => ({
      path: chunk.path,
      title: titleOf(chunk.path),
      ord: chunk.ord,
      contentHash: hash,
      text: chunk.text,
      headingPath: chunk.headingPath,
      score: fused,
      winningSignal,
    }));
  }
}

interface HydratedCandidate {
  hash: string;
  chunk: Chunk;
}

interface ScoredHit extends HydratedCandidate {
  fused: number;
  winningSignal: WinningSignal;
}

function countNeighborOverlap(
  links: LinksIndex,
  path: string,
  candidatePaths: Set<string>,
): number {
  let n = 0;
  for (const link of links.outgoing(path)) {
    if (link.resolved && link.target && link.target !== path && candidatePaths.has(link.target)) {
      n++;
    }
  }
  for (const source of links.backlinks(path)) {
    if (source !== path && candidatePaths.has(source)) n++;
  }
  return n;
}

function pickSignal(sem: number, lex: number, linkExcess: number): WinningSignal {
  // Any link-graph reinforcement claims the tag — that's the user-facing
  // signal we want to surface ("this match was reinforced by the graph").
  // Multiplicative boost is capped at 2.0 so linkExcess is structurally
  // bounded below the rank-based contributions; gating on linkExcess > 0
  // (i.e. overlap > 0) is what makes the tag actually useful.
  if (linkExcess > 0) return "backlink";
  if (lex > sem) return "lexical";
  return "semantic";
}

function titleOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  return file.replace(/\.md$/i, "");
}
