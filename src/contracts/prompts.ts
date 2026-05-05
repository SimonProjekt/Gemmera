export const PROMPT_IDS = [
  "ingest-parser",
  "note-writer",
  "intent-classifier",
  "dedup-decider",
  "retrieval-reasoner",
  "synthesis-writer",
] as const;

export type PromptId = (typeof PROMPT_IDS)[number];

export interface LoadedPrompt {
  id: PromptId;
  version: string;
  body: string;
}

export interface PromptLoader {
  load(id: PromptId): Promise<LoadedPrompt>;
  // Drop one or all entries from the cache. In dev mode, callers invalidate
  // when a prompt file changes on disk so the next load reads fresh content.
  invalidate(id?: PromptId): void;
}
