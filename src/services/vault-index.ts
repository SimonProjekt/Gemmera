import type {
  IndexSearchOptions,
  IndexSearchResult,
  IndexService,
  VaultService,
} from "../contracts";

const DEFAULT_TOP_K = 3;
const SNIPPET_CHARS = 2000;

/**
 * Stub IndexService backed by linear vault scan. Same behavior as the existing
 * `searchVault` in src/search.ts, but exposed through the IndexService
 * contract so the UI can be wired against an interface today and swapped for
 * a real index later (see planning/decisions/01-rust-integration.md).
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
