export interface IndexSearchResult {
  path: string;
  basename: string;
  snippet: string;
  score: number;
}

export interface IndexSearchOptions {
  topK?: number;
}

export interface IndexService {
  search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>;
}
