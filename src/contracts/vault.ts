export interface VaultFileRef {
  path: string;
  basename: string;
}

export interface HeadingRef {
  level: number;
  text: string;
  offset: number; // character offset of the heading line in the raw file
}

export interface VaultStat {
  mtime: number;
  size: number;
}

export interface VaultService {
  listMarkdownFiles(): Promise<VaultFileRef[]>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  create(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  getHeadings(path: string): Promise<HeadingRef[]>;
  /**
   * Lightweight metadata accessor. Avoids reading file contents — used by
   * the weekly reconciler (#15e) to skip rehashing files whose mtime hasn't
   * changed.
   */
  stat(path: string): Promise<VaultStat>;
}
