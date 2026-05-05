export interface GemmeraSettings {
  /** Dev-only: force "mock" to bypass Ollama entirely. Default is "ollama". */
  llmBackend: "ollama" | "mock";
}

export const DEFAULT_SETTINGS: GemmeraSettings = {
  llmBackend: "ollama",
};
