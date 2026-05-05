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
