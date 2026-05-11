import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { spawn } from "child_process";
import type { ChatMessage, IndexSearchResult } from "./contracts";
import type { ClassifierDecision, IntentLabel } from "./contracts/classifier";
import { DEFAULT_THRESHOLDS } from "./contracts/classifier";
import type { Services } from "./services";
import type { GemmeraStatusBar } from "./statusbar";
import { classifyLLMError } from "./llm-error";
import { parseFileOps, handleFileOps } from "./fileops";
import { showOllamaDownNotice } from "./notices";

export const VIEW_TYPE = "gemmera-chat";

interface RecentTurn {
  userText: string;
  label: IntentLabel;
}

export class GemmeraChatView extends ItemView {
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private chipEl: HTMLElement | null = null;
  private chipDecision: ClassifierDecision | null = null;
  private history: ChatMessage[] = [];
  private recentTurns: RecentTurn[] = [];
  private model = "gemma3:latest";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly services: Services,
    private readonly statusBar?: GemmeraStatusBar,
  ) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Gemmera"; }
  getIcon(): string { return "message-square"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("gemmera-view");

    const statusEl = container.createEl("div", { cls: "gemmera-status" });
    this.checkOllamaStatus(statusEl);
    this.services.llm.pickDefaultModel().then((m) => { this.model = m; }).catch(() => {});

    this.messagesEl = container.createEl("div", { cls: "gemmera-messages" });

    const inputArea = container.createEl("div", { cls: "gemmera-input-area" });
    this.inputEl = inputArea.createEl("textarea", {
      cls: "gemmera-input",
      attr: { placeholder: "Skriv ett meddelande... (? för fråga, Ctrl+Enter för spara)", rows: "3" },
    });
    this.sendBtn = inputArea.createEl("button", { cls: "gemmera-send", text: "Skicka" });
    this.sendBtn.addEventListener("click", () => this.handleSend());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.handleSend({ forcedLabel: "capture" });
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
  }

  async onClose(): Promise<void> {
    this.dismissChip();
  }

  private async checkOllamaStatus(el: HTMLElement): Promise<void> {
    el.setText("Kollar Ollama...");
    const status = await this.services.llm.isReachable();
    if (status === "running") {
      el.setText("Ollama: körs");
      el.addClass("gemmera-status--ok");
    } else {
      el.setText("Ollama: hittades inte — starta Ollama för att chatta");
      el.addClass("gemmera-status--error");
    }
  }

  private async handleSend(opts?: {
    text?: string;
    forcedLabel?: IntentLabel;
    originalDecision?: ClassifierDecision;
  }): Promise<void> {
    const text = opts?.text ?? this.inputEl.value.trim();
    if (!text) return;

    if (!opts?.text) this.inputEl.value = "";
    this.dismissChip();
    this.setInputDisabled(true);

    const decision = await this.classifyMessage(text, opts?.forcedLabel);

    // Below-threshold or classifier failure → show disambiguation chip
    if (decision.source === "llm" && !opts?.forcedLabel && this.belowThreshold(decision)) {
      this.showDisambiguationChip(text, decision);
      this.setInputDisabled(false);
      return;
    }

    this.history.push({ role: "user", content: text });
    this.recentTurns = [...this.recentTurns.slice(-2), { userText: text, label: decision.label }];
    this.appendUserTurn(text, decision, opts?.originalDecision);

    switch (decision.label) {
      case "ask":
      case "mixed": // Mixed routes to ask path for now — save-ingest wiring tracked in #68.
        await this.runAskPath(text);
        break;
      case "capture":
        await this.runCapturePath(text);
        break;
      case "meta":
        this.runMetaPath();
        break;
    }
  }

  private async classifyMessage(text: string, forcedLabel?: IntentLabel): Promise<ClassifierDecision> {
    if (forcedLabel) {
      return {
        label: forcedLabel,
        confidence: 1.0,
        rationale: "User-forced intent",
        source: "skip",
        skipReason: "forced",
        latencyMs: 0,
        promptVersion: "",
      };
    }
    return this.services.classifier.classify({
      messageText: text,
      model: this.model,
      recentTurns: this.recentTurns,
    });
  }

  private belowThreshold(decision: ClassifierDecision): boolean {
    if (decision.failed) return false; // silent fallback — never show chip
    return decision.confidence < DEFAULT_THRESHOLDS[decision.label];
  }

  // ── Disambiguation chip ────────────────────────────────────────────────────

  private showDisambiguationChip(text: string, decision: ClassifierDecision): void {
    this.dismissChip();
    this.chipDecision = decision;

    const inputArea = this.inputEl.closest(".gemmera-input-area") as HTMLElement | null;
    if (!inputArea?.parentElement) return;

    const chip = inputArea.parentElement.createEl("div", { cls: "gemmera-chip" });
    chip.title = decision.rationale;
    this.chipEl = chip;

    chip.createEl("span", { cls: "gemmera-chip__label", text: "Vad menade du?" });

    const saveBtn = chip.createEl("button", { cls: "gemmera-chip__btn", text: "Spara" });
    const askBtn = chip.createEl("button", { cls: "gemmera-chip__btn", text: "Fråga" });
    const cancelBtn = chip.createEl("button", { cls: "gemmera-chip__btn gemmera-chip__btn--cancel", text: "Avbryt" });

    saveBtn.addEventListener("click", () => {
      const original = this.chipDecision;
      this.dismissChip();
      void this.handleSend({ text, forcedLabel: "capture", originalDecision: original ?? undefined });
    });
    askBtn.addEventListener("click", () => {
      const original = this.chipDecision;
      this.dismissChip();
      void this.handleSend({ text, forcedLabel: "ask", originalDecision: original ?? undefined });
    });
    cancelBtn.addEventListener("click", () => this.dismissChip());

    inputArea.parentElement.insertBefore(chip, inputArea);
  }

  private dismissChip(): void {
    this.chipEl?.remove();
    this.chipEl = null;
    this.chipDecision = null;
  }

  // ── Routing paths ──────────────────────────────────────────────────────────

  private async runAskPath(text: string): Promise<void> {
    const { el: assistantEl, textEl } = this.appendStreamingMessage();
    this.statusBar?.setThinking(true);
    try {
      const searchResults = await this.services.index.search(text);
      const messages = withContext(this.history, searchResults);

      const reply = await this.services.llm.chat({
        model: this.model,
        messages,
        onToken: (token) => {
          textEl.textContent += token;
          this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: "smooth" });
        },
      });
      this.history.push({ role: "assistant", content: reply.content });

      if (searchResults.length > 0) {
        this.appendCitations(assistantEl, searchResults.map((r) => r.basename));
      }

      const ops = parseFileOps(reply.content);
      if (ops.length > 0) await handleFileOps(this.app, ops);
    } catch (err) {
      const health = await this.services.llm.isReachable().catch(() => "missing" as const);
      this.statusBar?.setHealth(health);

      textEl.textContent = classifyLLMError(err, health);
      assistantEl.addClass("gemmera-message--error");

      const retryBtn = assistantEl.createEl("button", { cls: "gemmera-retry-btn", text: "Retry" });
      retryBtn.addEventListener("click", () => {
        assistantEl.remove();
        this.setInputDisabled(true);
        this.history.push({ role: "user", content: text });
        void this.runAskPath(text);
      });

      if (health === "missing") {
        showOllamaDownNotice(() => {
          spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
          new Notice("Gemmera: Starting Ollama...");
        });
      }

      this.history.pop();
    } finally {
      this.statusBar?.setThinking(false);
      this.setInputDisabled(false);
      this.inputEl.focus();
    }
  }

  private appendCitations(container: HTMLElement, basenames: string[]): void {
    const el = container.createEl("div", { cls: "gemmera-citations" });
    el.createEl("span", { cls: "gemmera-citations__label", text: "Källor:" });
    for (const name of basenames) {
      el.createEl("span", { cls: "gemmera-citations__chip", text: name });
    }
  }

  // Capture routes to the ask path for now — LLM creates notes via fileops.
  // Full ingest-state-machine wiring tracked in #68.
  private async runCapturePath(text: string): Promise<void> {
    return this.runAskPath(text);
  }

  private runMetaPath(): void {
    const help =
      "**Gemmera** hjälper dig att spara och hitta information i din vault.\n\n" +
      "- Skriv något för att spara det som en anteckning\n" +
      "- Ställ en fråga för att söka i din vault\n" +
      "- Börja med **?** för att ställa en fråga direkt\n" +
      "- Tryck **Ctrl+Enter** för att spara utan att klassificera";

    this.history.push({ role: "assistant", content: help });
    this.appendMessage("assistant", help);
    this.setInputDisabled(false);
    this.inputEl.focus();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private appendUserTurn(
    text: string,
    decision: ClassifierDecision,
    originalDecision?: ClassifierDecision,
  ): void {
    const wrap = this.messagesEl.createEl("div", { cls: "gemmera-turn" });
    const msg = wrap.createEl("div", { cls: "gemmera-message gemmera-message--user" });
    msg.createEl("span", { cls: "gemmera-message__role", text: "Du" });
    msg.createEl("p", { cls: "gemmera-message__text", text });
    this.appendInspectorPanel(wrap, decision, originalDecision);
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: "smooth" });
  }

  private appendInspectorPanel(
    container: HTMLElement,
    decision: ClassifierDecision,
    originalDecision?: ClassifierDecision,
  ): void {
    const panel = container.createEl("div", { cls: "gemmera-inspector" });

    if (decision.source === "skip") {
      const badge = panel.createEl("span", { cls: "gemmera-inspector__badge gemmera-inspector__badge--skip", text: "skip" });
      badge.title = "Intent was determined without calling the LLM";
      panel.createEl("span", { cls: "gemmera-inspector__label", text: decision.label });
      panel.createEl("span", { cls: "gemmera-inspector__meta", text: decision.skipReason ?? "" });
      return;
    }

    // LLM path
    const wasDisambiguated = !!originalDecision;
    const badgeText = wasDisambiguated ? "disambig" : "llm";
    const badge = panel.createEl("span", {
      cls: `gemmera-inspector__badge gemmera-inspector__badge--llm${wasDisambiguated ? " gemmera-inspector__badge--disambig" : ""}`,
      text: badgeText,
    });
    badge.title = wasDisambiguated
      ? `Original: ${originalDecision!.label} (${pct(originalDecision!.confidence)}) → user chose ${decision.label}`
      : "Intent classified by LLM";

    panel.createEl("span", { cls: "gemmera-inspector__label", text: decision.label });

    if (wasDisambiguated) {
      panel.createEl("span", {
        cls: "gemmera-inspector__meta",
        text: `was ${originalDecision!.label} ${pct(originalDecision!.confidence)}`,
      });
    } else {
      panel.createEl("span", { cls: "gemmera-inspector__confidence", text: pct(decision.confidence) });
    }

    panel.createEl("span", { cls: "gemmera-inspector__rationale", text: decision.rationale });
    panel.createEl("span", { cls: "gemmera-inspector__latency", text: `${decision.latencyMs}ms` });

    // Collapsible raw JSON
    const details = panel.createEl("details", { cls: "gemmera-inspector__raw" });
    details.createEl("summary", { text: "raw" });
    const payload: Record<string, unknown> = { ...decision };
    if (wasDisambiguated) payload["originalDecision"] = originalDecision;
    details.createEl("pre", { text: JSON.stringify(payload, null, 2) });
  }

  private appendStreamingMessage(): { el: HTMLElement; textEl: HTMLElement } {
    const el = this.messagesEl.createEl("div", { cls: "gemmera-message gemmera-message--assistant" });
    el.createEl("span", { cls: "gemmera-message__role", text: "Gemma" });
    const textEl = el.createEl("p", { cls: "gemmera-message__text", text: "" });
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: "smooth" });
    return { el, textEl };
  }

  private appendMessage(role: "user" | "assistant", text: string): void {
    const msg = this.messagesEl.createEl("div", { cls: `gemmera-message gemmera-message--${role}` });
    msg.createEl("span", { cls: "gemmera-message__role", text: role === "user" ? "Du" : "Gemma" });
    msg.createEl("p", { cls: "gemmera-message__text", text });
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: "smooth" });
  }

  private setInputDisabled(disabled: boolean): void {
    this.inputEl.disabled = disabled;
    this.sendBtn.disabled = disabled;
  }
}

function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function withContext(
  history: ChatMessage[],
  results: IndexSearchResult[],
): ChatMessage[] {
  if (results.length === 0) return history;
  const parts = results.map((r) => `### ${r.basename}\n${r.snippet}`);
  const contextPrompt =
    "Nedan följer relevanta anteckningar från användarens vault. " +
    "Använd dem som kontext när du svarar:\n\n" +
    parts.join("\n\n---\n\n");
  return [
    { role: "user", content: contextPrompt },
    { role: "assistant", content: "Förstått, jag har läst anteckningarna." },
    ...history,
  ];
}
