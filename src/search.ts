import { App, TFile } from "obsidian";

const MAX_FILES = 3;
const MAX_CHARS_PER_FILE = 2000;

export interface SearchResult {
  filename: string;
  content: string;
}

export async function searchVault(app: App, query: string): Promise<SearchResult[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  if (terms.length === 0) return [];

  const files = app.vault.getMarkdownFiles();
  const scored: { file: TFile; score: number }[] = [];

  for (const file of files) {
    const nameScore = terms.filter((t) => file.basename.toLowerCase().includes(t)).length * 2;
    if (nameScore === 0) {
      const cache = app.metadataCache.getFileCache(file);
      const headings = cache?.headings?.map((h) => h.heading.toLowerCase()).join(" ") ?? "";
      const headingScore = terms.filter((t) => headings.includes(t)).length;
      if (headingScore > 0) scored.push({ file, score: headingScore });
    } else {
      scored.push({ file, score: nameScore });
    }
  }

  // For top candidates, do a full content search
  const topByName = scored.sort((a, b) => b.score - a.score).slice(0, 10);
  const results: SearchResult[] = [];

  for (const { file } of topByName) {
    const content = await app.vault.cachedRead(file);
    const lowerContent = content.toLowerCase();
    const contentScore = terms.filter((t) => lowerContent.includes(t)).length;
    if (contentScore > 0) {
      results.push({ filename: file.name, content: content.slice(0, MAX_CHARS_PER_FILE) });
    }
  }

  // If name-based search found nothing, fall back to full content scan
  if (results.length === 0) {
    for (const file of files) {
      if (results.length >= MAX_FILES) break;
      const content = await app.vault.cachedRead(file);
      const lowerContent = content.toLowerCase();
      const score = terms.filter((t) => lowerContent.includes(t)).length;
      if (score > 0) {
        results.push({ filename: file.name, content: content.slice(0, MAX_CHARS_PER_FILE) });
      }
    }
  }

  return results.slice(0, MAX_FILES);
}

export function buildContextPrompt(results: SearchResult[]): string {
  if (results.length === 0) return "";
  const parts = results.map(
    (r) => `### ${r.filename}\n${r.content}`,
  );
  return (
    "Nedan följer relevanta anteckningar från användarens vault. " +
    "Använd dem som kontext när du svarar:\n\n" +
    parts.join("\n\n---\n\n")
  );
}
