export interface VaultFileRef {
  path: string;
  basename: string;
}

export interface VaultService {
  listMarkdownFiles(): Promise<VaultFileRef[]>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  create(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  getHeadings(path: string): Promise<string[]>;
}
