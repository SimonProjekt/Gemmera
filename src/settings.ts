export interface GemmeraSettings {
  /**
   * Dev-only: force "mock" to bypass Ollama entirely. Default is "ollama".
   *
   * Not exposed in the UI — change only by editing the plugin's `data.json`
   * (or in code for tests). Intended for developers and CI, not end users.
   */
  llmBackend: "ollama" | "mock";

  /**
   * Show classifier label + confidence + rationale inline on every message.
   * Wired to Settings → Advanced → "Show classifier decisions" (#67).
   */
  showClassifierDecisions: boolean;

  /**
   * When true, captures pass through a preview modal before being written.
   * When false, high-confidence creates are saved silently and the
   * silent-save indicator is shown. Wired to Settings → "Always preview
   * before save" (#67).
   */
  alwaysPreviewBeforeSave: boolean;

  /** Folder for new ingest notes. Default `Inbox/`. */
  inboxFolder: string;

  /** Cosine score above which a similar note is treated as a near-duplicate. */
  dedupThreshold: number;
}

export const DEFAULT_SETTINGS: GemmeraSettings = {
  llmBackend: "ollama",
  showClassifierDecisions: false,
  alwaysPreviewBeforeSave: true,
  inboxFolder: "Inbox/",
  dedupThreshold: 0.85,
};
