import type { App, TFile } from "obsidian";
import type { HeadingRef, VaultFileRef, VaultService } from "../contracts";

export class ObsidianVaultService implements VaultService {
  constructor(private readonly app: App) {}

  async listMarkdownFiles(): Promise<VaultFileRef[]> {
    return this.app.vault
      .getMarkdownFiles()
      .map((f) => ({ path: f.path, basename: f.basename }));
  }

  async read(path: string): Promise<string> {
    const file = this.requireFile(path);
    return this.app.vault.cachedRead(file);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  async create(path: string, content: string): Promise<void> {
    if (await this.exists(path)) {
      throw new Error(`File already exists: ${path}`);
    }
    await this.app.vault.create(path, content);
  }

  async append(path: string, content: string): Promise<void> {
    const file = this.requireFile(path);
    await this.app.vault.append(file, content);
  }

  async getHeadings(path: string): Promise<HeadingRef[]> {
    const file = this.requireFile(path);
    const cache = this.app.metadataCache.getFileCache(file);
    return (
      cache?.headings?.map((h) => ({
        level: h.level,
        text: h.heading,
        offset: h.position.start.offset,
      })) ?? []
    );
  }

  private requireFile(path: string): TFile {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return file;
  }
}
