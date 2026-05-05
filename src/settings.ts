export interface GemmeraSettings {
  /**
   * Dev-only: force "mock" to bypass Ollama entirely. Default is "ollama".
   *
   * Not exposed in the UI — change only by editing the plugin's `data.json`
   * (or in code for tests). Intended for developers and CI, not end users.
   */
  llmBackend: "ollama" | "mock";
}

export const DEFAULT_SETTINGS: GemmeraSettings = {
  llmBackend: "ollama",
};
