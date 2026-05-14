import type {
  IndexSearchOptions,
  IndexSearchResult,
  IndexService,
  VaultService,
} from "../contracts";

const DEFAULT_TOP_K = 3;
const SNIPPET_CHARS = 2000;

/**
 * Stub IndexService backed by a linear vault scan.
 *
 * As of #14, vault-tagged turns ("ask" / "mixed") go through the
 * HybridRetriever via `runQuery`. This linear scanner remains as the
 * fallback context source for `meta` intent and any unclassified turn that
 * lands in `runChat` — i.e., turns that do not warrant the full RAG loop.
 *
 * Do NOT wire new vault-grounded code paths against this — use
 * `services.retriever` (HybridRetriever) so the retrieval-event invariant
 * holds.
 */
export class VaultLinearIndexService implements IndexService {
  constructor(private readonly vault: VaultService) {}

  async search(query: string, opts: IndexSearchOptions = {}): Promise<IndexSearchResult[]> {
    const topK = opts.topK ?? DEFAULT_TOP_K;
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    if (terms.length === 0) return [];

    const files = await this.vault.listMarkdownFiles();
    const scored: IndexSearchResult[] = [];

    for (const file of files) {
      const nameScore =
        terms.filter((t) => file.basename.toLowerCase().includes(t)).length * 2;
      const headings = (await this.vault.getHeadings(file.path))
        .map((h) => h.text)
        .join(" ")
        .toLowerCase();
      const headingScore = terms.filter((t) => headings.includes(t)).length;
      const content = await this.vault.read(file.path);
      const lower = content.toLowerCase();
      const contentScore = terms.filter((t) => lower.includes(t)).length;
      const score = nameScore + headingScore + contentScore;
      if (score > 0) {
        scored.push({
          path: file.path,
          basename: file.basename,
          snippet: content.slice(0, SNIPPET_CHARS),
          score,
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
