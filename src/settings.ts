export interface GemmeraSettings {
  /**
   * Dev-only: force "mock" to bypass Ollama entirely. Default is "ollama".
   *
   * Not exposed in the UI — change only by editing the plugin's `data.json`
   * (or in code for tests). Intended for developers and CI, not end users.
   */
  llmBackend: "ollama" | "mock";
  /** Folder for new ingest notes. Default `Inbox/`. */
  inboxFolder: string;
  /** Cosine score above which a similar note is treated as a near-duplicate. */
  dedupThreshold: number;
  /** When true, every save passes through the preview modal. */
  alwaysPreview: boolean;
}

export const DEFAULT_SETTINGS: GemmeraSettings = {
  llmBackend: "ollama",
  inboxFolder: "Inbox/",
  dedupThreshold: 0.85,
  alwaysPreview: true,
};
