import type { HeadingRef, VaultFileRef, VaultService } from "../vault";

export class MockVaultService implements VaultService {
  private files = new Map<string, string>();
  private headings = new Map<string, HeadingRef[]>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
  }

  async listMarkdownFiles(): Promise<VaultFileRef[]> {
    return [...this.files.keys()]
      .filter((p) => p.endsWith(".md"))
      .map((path) => ({ path, basename: basename(path) }));
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async create(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    this.files.set(path, content);
  }

  /** Test-only convenience: overwrite an existing file or create a new one. */
  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  async append(path: string, content: string): Promise<void> {
    const existing = this.files.get(path);
    if (existing === undefined) throw new Error(`File not found: ${path}`);
    this.files.set(path, existing + content);
  }

  async getHeadings(path: string): Promise<HeadingRef[]> {
    return this.headings.get(path) ?? [];
  }

  setHeadings(path: string, headings: HeadingRef[] | string[]): void {
    const refs: HeadingRef[] = headings.map((h, i) =>
      typeof h === "string" ? { level: 2, text: h, offset: i } : h,
    );
    this.headings.set(path, refs);
  }
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  return file.replace(/\.md$/, "");
}
