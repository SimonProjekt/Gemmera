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
   * Until that tab lands, toggle by editing `data.json`.
   */
  showClassifierDecisions: boolean;

  /**
   * When true, the user reviews a capture before it is written.
   * When false, captures are silent and the silent-save indicator is shown.
   * Wired to Settings → "Always preview before save" (#67).
   */
  alwaysPreviewBeforeSave: boolean;
}

export const DEFAULT_SETTINGS: GemmeraSettings = {
  llmBackend: "ollama",
  showClassifierDecisions: false,
  alwaysPreviewBeforeSave: false,
};
