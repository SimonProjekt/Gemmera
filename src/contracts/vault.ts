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
  /**
   * Moves the file to the system trash (Finder Trash on macOS, Recycle
   * Bin on Windows). Never a permanent delete; the user can restore the
   * file from the OS trash UI. Throws if the file does not exist.
   */
  trash(path: string): Promise<void>;
  /**
   * Renames or moves a file. In the real vault this delegates to
   * `FileManager.renameFile` so all incoming wikilinks update atomically.
   * Throws if `from` does not exist or `to` already exists.
   */
  rename(from: string, to: string): Promise<void>;
}
