import type { App, EventRef, TAbstractFile, TFile } from "obsidian";
import type { VaultEventSource } from "../contracts";

/**
 * Adapts Obsidian's vault + metadataCache event APIs to the
 * VaultEventSource contract. Filters non-file events (folders) so the
 * bridge only sees TFile paths.
 */
export class ObsidianVaultEventSource implements VaultEventSource {
  constructor(private readonly app: App) {}

  onCreate(cb: (path: string) => void): () => void {
    return wrap(this.app.vault.on("create", (file: TAbstractFile) => {
      const tfile = asTFile(file);
      if (tfile) cb(tfile.path);
    }), this.app);
  }

  onModify(cb: (path: string) => void): () => void {
    return wrap(this.app.vault.on("modify", (file: TAbstractFile) => {
      const tfile = asTFile(file);
      if (tfile) cb(tfile.path);
    }), this.app);
  }

  onDelete(cb: (path: string) => void): () => void {
    return wrap(this.app.vault.on("delete", (file: TAbstractFile) => {
      const tfile = asTFile(file);
      if (tfile) cb(tfile.path);
    }), this.app);
  }

  onRename(cb: (oldPath: string, newPath: string) => void): () => void {
    return wrap(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      const tfile = asTFile(file);
      if (tfile) cb(oldPath, tfile.path);
    }), this.app);
  }

  onMetadataChange(cb: (path: string) => void): () => void {
    return wrap(this.app.metadataCache.on("changed", (file: TFile) => {
      cb(file.path);
    }), this.app);
  }
}

function wrap(ref: EventRef, app: App): () => void {
  return () => app.vault.offref(ref);
}

function asTFile(file: TAbstractFile): TFile | null {
  // TFile has `extension`; folders don't. Avoid an `instanceof` import dance.
  return "extension" in file ? (file as TFile) : null;
}
