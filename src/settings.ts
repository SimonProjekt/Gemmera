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

  /**
   * "auto" = find ollama on PATH. "manual" = use ollamaPath.
   * Wired to Settings → Ollama → path mode (#28).
   */
  ollamaPathMode: "auto" | "manual";

  /**
   * Explicit path to the Ollama binary. Only used when ollamaPathMode = "manual".
   * Example: "/usr/local/bin/ollama"
   */
  ollamaPath: string;

  /**
   * Wall-clock budget per turn in milliseconds. Clamped to
   * HARD_STOPS.WALL_CLOCK_MS_MAX (300 000 ms) on load. Other hard-stop
   * ceilings (tool calls, no-ops, retries) are constants and not exposed here.
   */
  turnTimeoutMs: number;

  /** Ollama tag used for chat and the classifier (e.g. `gemma4:e4b`). */
  chatModel: string;

  /**
   * When true, the "Open turn inspector" command appears in the palette.
   * Shows raw state traces with tool args, payloads, and per-step timing.
   * Intended for developers; hidden by default in production.
   */
  devMode: boolean;

  /**
   * Chat retention — cap how many days of chats are kept on disk. 0 / undefined
   * means unlimited. Pruning runs at view open and after every saved turn.
   * #43.
   */
  chatRetentionMaxDays: number;

  /**
   * Chat retention — cap the total number of sessions kept on disk, oldest
   * pruned first. 0 / undefined means unlimited. #43.
   */
  chatRetentionMaxSessions: number;
}

export const DEFAULT_CHAT_MODEL = "gemma4:e4b";

export const DEFAULT_SETTINGS: GemmeraSettings = {
  llmBackend: "ollama",
  showClassifierDecisions: false,
  alwaysPreviewBeforeSave: true,
  inboxFolder: "Inbox/",
  dedupThreshold: 0.85,
  ollamaPathMode: "auto",
  ollamaPath: "",
  turnTimeoutMs: 120_000,
  chatModel: DEFAULT_CHAT_MODEL,
  devMode: false,
  chatRetentionMaxDays: 0,
  chatRetentionMaxSessions: 0,
};
