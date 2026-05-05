import type { HeadingRef } from "./vault";

export interface ChunkerInput {
  path: string;
  title: string;
  content: string;
  headings: HeadingRef[];
}

export interface Chunk {
  path: string;
  ord: number;
  headingPath: string[];
  text: string;
  textForEmbed: string;
  tokenCount: number;
  contentHash: string;
}

export interface Chunker {
  chunk(input: ChunkerInput): Chunk[];
}

// Spec from issue #6 / planning/rag.md.
export const CHUNK_TARGET_TOKENS = 800;
export const CHUNK_CEILING_TOKENS = 1200;
export const CHUNK_OVERLAP_TOKENS = 100;
export const CHARS_PER_TOKEN = 4;
