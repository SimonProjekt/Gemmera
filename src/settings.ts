import { App, PluginSettingTab, Setting } from "obsidian";
import type GemmeraPlugin from "./main";

export interface GemmeraSettings {
  /**
   * Dev-only: force "mock" to bypass Ollama entirely. Default is "ollama".
   *
   * Not exposed in the UI — change only by editing the plugin's `data.json`
   * (or in code for tests). Intended for developers and CI, not end users.
   */
  llmBackend: "ollama" | "mock";

  /** Chat model used for LLM calls (e.g. gemma3:latest). */
  chatModel: string;

  /** Default folder for saved notes (e.g. Inbox/). */
  inboxFolder: string;

  /** Stream tokens as they arrive. When off, full response is shown at once. */
  streamingEnabled: boolean;

  /** Show the turn inspector panel on every user message. Developer-only feature. */
  devMode: boolean;

  /** Comma-separated list of folder prefixes to exclude from indexing. */
  excludedFolders: string;

  /** "auto" uses the default Ollama URL; "manual" uses `ollamaUrl`. */
  ollamaUrlMode: "auto" | "manual";

  /** Override URL of the Ollama HTTP API (only used when `ollamaUrlMode` is "manual"). */
  ollamaUrl: string;
}

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export const DEFAULT_SETTINGS: GemmeraSettings = {
  llmBackend: "ollama",
  chatModel: "gemma3:latest",
  inboxFolder: "Inbox/",
  streamingEnabled: true,
  devMode: false,
  excludedFolders: "",
  ollamaUrlMode: "auto",
  ollamaUrl: DEFAULT_OLLAMA_URL,
};

export function effectiveOllamaUrl(settings: GemmeraSettings): string {
  return settings.ollamaUrlMode === "manual" && settings.ollamaUrl.trim()
    ? settings.ollamaUrl.trim()
    : DEFAULT_OLLAMA_URL;
}

export class GemmeraSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GemmeraPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── General ──────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "General" });

    new Setting(containerEl)
      .setName("Inbox folder")
      .setDesc("Default folder where saved notes are created.")
      .addText((text) =>
        text
          .setPlaceholder("Inbox/")
          .setValue(this.plugin.settings.inboxFolder)
          .onChange(async (value) => {
            this.plugin.settings.inboxFolder = value;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated folder prefixes to skip during indexing (e.g. 'Templates/, Archive/').")
      .addTextArea((text) =>
        text
          .setPlaceholder("Templates/, Archive/")
          .setValue(this.plugin.settings.excludedFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    // ── Model ────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Model" });

    new Setting(containerEl)
      .setName("Chat model")
      .setDesc("Ollama model used for chat and classification (e.g. gemma3:latest).")
      .addText((text) =>
        text
          .setPlaceholder("gemma3:latest")
          .setValue(this.plugin.settings.chatModel)
          .onChange(async (value) => {
            this.plugin.settings.chatModel = value;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Fixed: BGE-M3 (1024-dim). Used for vault indexing and RAG search.")
      .addExtraButton((btn) => btn.setIcon("info").setTooltip("bge-m3"));

    new Setting(containerEl)
      .setName("Ollama path")
      .setDesc("\"Auto\" uses the default URL (http://127.0.0.1:11434). \"Manual\" lets you point at a non-standard port or remote host.")
      .addDropdown((dd) =>
        dd
          .addOption("auto", "Auto")
          .addOption("manual", "Manual")
          .setValue(this.plugin.settings.ollamaUrlMode)
          .onChange(async (value) => {
            this.plugin.settings.ollamaUrlMode = value as "auto" | "manual";
            await this.plugin.saveData(this.plugin.settings);
            await this.plugin.applyOllamaUrl();
            this.display();
          }),
      );

    if (this.plugin.settings.ollamaUrlMode === "manual") {
      new Setting(containerEl)
        .setName("Ollama URL")
        .setDesc("HTTP endpoint of the Ollama server (e.g. http://localhost:11435 or http://192.168.1.5:11434). Click \"Restart Ollama\" below to verify.")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_OLLAMA_URL)
            .setValue(this.plugin.settings.ollamaUrl)
            .onChange(async (value) => {
              this.plugin.settings.ollamaUrl = value;
              await this.plugin.saveData(this.plugin.settings);
              this.plugin.applyOllamaUrl();
            }),
        );
    }

    // ── Chat ─────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Chat" });

    new Setting(containerEl)
      .setName("Stream responses")
      .setDesc("Show tokens as they arrive. When off, the full response appears at once.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.streamingEnabled)
          .onChange(async (value) => {
            this.plugin.settings.streamingEnabled = value;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    // ── Advanced ─────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Developer mode")
      .setDesc("Show the turn inspector panel on every user message (classifier verdict, latency, raw JSON).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.devMode)
          .onChange(async (value) => {
            this.plugin.settings.devMode = value;
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(containerEl)
      .setName("Restart Ollama")
      .setDesc("Attempt to start Ollama (if not already running) and re-check reachability. Use this after changing the Ollama URL.")
      .addButton((btn) => {
        btn.setButtonText("Restart Ollama").onClick(async () => {
          btn.setDisabled(true).setButtonText("Restarting…");
          try {
            await this.plugin.restartOllama();
          } finally {
            btn.setDisabled(false).setButtonText("Restart Ollama");
          }
        });
      });
  }
}
