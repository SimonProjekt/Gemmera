export class Notice {
  constructor(public message: string) {}
}

export class FileSystemAdapter {
  getFullPath(path: string): string {
    return path;
  }
}

export class Plugin {}
export class WorkspaceLeaf {}
export class ItemView {}
export class MarkdownRenderer {}

// Minimal stand-ins for tests that reference UI types but don't actually
// render. Real Obsidian provides full implementations at runtime.
export class Modal {
  contentEl: { empty: () => void; createEl: () => unknown } = {
    empty: () => {},
    createEl: () => ({}),
  };
  open(): void {}
  close(): void {}
}
export class PluginSettingTab {}
export class Setting {
  setName(_n: string): this { return this; }
  setDesc(_d: string): this { return this; }
  addToggle(_cb: (...args: unknown[]) => unknown): this { return this; }
  addButton(_cb: (...args: unknown[]) => unknown): this { return this; }
  addText(_cb: (...args: unknown[]) => unknown): this { return this; }
}
