import type {
  LinksIndex,
  PayloadAssembler,
  PayloadAssemblerOptions,
  PayloadChunk,
  RetrievalHit,
  RetrievalPayload,
} from "../contracts";

const DEFAULT_MAX_CHUNKS = 8;
const DEFAULT_MAX_NEIGHBORS = 5;

/**
 * Default PayloadAssembler (#10).
 *
 * Bridges retriever output to the bounded structured object the chat loop
 * hands to Gemma. The retriever ranks; this layer shapes. They're split so
 * the retriever can change algorithms without disturbing the prompt-facing
 * fields, and so #16's eval harness can target a stable payload shape.
 *
 * Three jobs:
 *   1. Head-slice hits to `maxChunks` (already retriever-sorted).
 *   2. Project `RetrievalHit → PayloadChunk`, dropping retrieval internals
 *      (contentHash, ord, and score unless `includeScores`) and renaming
 *      `winningSignal → whyMatched` for the prompt template.
 *   3. Resolve 1-hop neighbors via LinksIndex (outgoing + backlinks),
 *      dedup by path, drop self, derive titles by basename, cap per chunk.
 *
 * `LinksIndex` is read-only here; updates flow through LinksIndexService.
 * Neighbor lookups are memoized by path within a single assemble() call so
 * adjacent chunks from the same note don't re-scan the link graph.
 */
export class DefaultPayloadAssembler implements PayloadAssembler {
  constructor(private readonly links: Pick<LinksIndex, "outgoing" | "backlinks">) {}

  assemble(
    query: string,
    hits: RetrievalHit[],
    opts: PayloadAssemblerOptions = {},
  ): RetrievalPayload {
    const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
    const includeScores = opts.includeScores ?? false;
    const includeNeighbors = opts.includeNeighbors ?? true;
    const maxNeighborsPerChunk = opts.maxNeighborsPerChunk ?? DEFAULT_MAX_NEIGHBORS;

    if (maxChunks <= 0 || hits.length === 0) {
      return { query, chunks: [] };
    }

    const top = hits.slice(0, maxChunks);
    const neighborCache = new Map<string, string[]>();

    const chunks: PayloadChunk[] = top.map((hit) => {
      const chunk: PayloadChunk = {
        path: hit.path,
        title: hit.title,
        headingPath: hit.headingPath,
        text: hit.text,
        whyMatched: hit.winningSignal,
      };
      if (includeScores) chunk.score = hit.score;
      if (includeNeighbors) {
        let neighbors = neighborCache.get(hit.path);
        if (!neighbors) {
          neighbors = resolveNeighbors(this.links, hit.path, maxNeighborsPerChunk);
          neighborCache.set(hit.path, neighbors);
        }
        chunk.neighbors = neighbors;
      }
      return chunk;
    });

    return { query, chunks };
  }
}

function resolveNeighbors(
  links: Pick<LinksIndex, "outgoing" | "backlinks">,
  path: string,
  cap: number,
): string[] {
  if (cap <= 0) return [];
  // Order: outgoing-resolved first, then backlinks. Dedup by path before the
  // cap so a noisy hub doesn't crowd out distinct neighbors.
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const link of links.outgoing(path)) {
    if (!link.resolved || !link.target) continue;
    if (link.target === path) continue;
    if (seen.has(link.target)) continue;
    seen.add(link.target);
    paths.push(link.target);
  }
  for (const source of links.backlinks(path)) {
    if (source === path) continue;
    if (seen.has(source)) continue;
    seen.add(source);
    paths.push(source);
  }
  return paths.slice(0, cap).map(titleOf);
}

function titleOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  return file.replace(/\.md$/i, "");
}
