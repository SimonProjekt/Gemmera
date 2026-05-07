import { ItemView, WorkspaceLeaf } from "obsidian";
import type { ChatMessage, IndexSearchResult } from "./contracts";
import type { ClassifierDecision, IntentLabel } from "./contracts/classifier";
import { DEFAULT_THRESHOLDS } from "./contracts/classifier";
import type { Services } from "./services";
import { parseFileOps, handleFileOps } from "./fileops";

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
  private history: ChatMessage[] = [];
  private recentTurns: RecentTurn[] = [];
  private model = "gemma3:latest";

  constructor(leaf: WorkspaceLeaf, private readonly services: Services) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Gemmera";
  }

  getIcon(): string {
    return "message-square";
  }

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
    this.sendBtn = inputArea.createEl("button", {
      cls: "gemmera-send",
      text: "Skicka",
    });
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

  private async handleSend(opts?: { text?: string; forcedLabel?: IntentLabel }): Promise<void> {
    const text = opts?.text ?? this.inputEl.value.trim();
    if (!text) return;

    if (!opts?.text) {
      this.inputEl.value = "";
    }
    this.dismissChip();
    this.setInputDisabled(true);

    const decision = await this.classifyMessage(text, opts?.forcedLabel);

    // Below-threshold or classifier failure → show disambiguation chip
    if (
      decision.source === "llm" &&
      !opts?.forcedLabel &&
      this.belowThreshold(decision)
    ) {
      this.showDisambiguationChip(text, decision.rationale);
      this.setInputDisabled(false);
      return;
    }

    this.history.push({ role: "user", content: text });
    this.appendMessage("user", text);
    this.recentTurns = [...this.recentTurns.slice(-2), { userText: text, label: decision.label }];

    switch (decision.label) {
      case "ask":
      case "mixed":
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
    if (decision.confidence === 0) return true; // classifier failure fallback
    const threshold = DEFAULT_THRESHOLDS[decision.label];
    return decision.confidence < threshold;
  }

  private showDisambiguationChip(text: string, rationale: string): void {
    this.dismissChip();

    const inputArea = this.inputEl.closest(".gemmera-input-area") as HTMLElement | null;
    if (!inputArea?.parentElement) return;

    const chip = inputArea.parentElement.createEl("div", { cls: "gemmera-chip" });
    chip.title = rationale;
    this.chipEl = chip;

    chip.createEl("span", { cls: "gemmera-chip__label", text: "Vad menade du?" });

    const saveBtn = chip.createEl("button", { cls: "gemmera-chip__btn", text: "Spara" });
    const askBtn = chip.createEl("button", { cls: "gemmera-chip__btn", text: "Fråga" });
    const cancelBtn = chip.createEl("button", { cls: "gemmera-chip__btn gemmera-chip__btn--cancel", text: "Avbryt" });

    saveBtn.addEventListener("click", () => {
      this.dismissChip();
      void this.handleSend({ text, forcedLabel: "capture" });
    });
    askBtn.addEventListener("click", () => {
      this.dismissChip();
      void this.handleSend({ text, forcedLabel: "ask" });
    });
    cancelBtn.addEventListener("click", () => this.dismissChip());

    // Insert the chip just before the input area
    inputArea.parentElement.insertBefore(chip, inputArea);
  }

  private dismissChip(): void {
    this.chipEl?.remove();
    this.chipEl = null;
  }

  private async runAskPath(text: string): Promise<void> {
    const { el: assistantEl, textEl } = this.appendStreamingMessage();
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
      const ops = parseFileOps(reply.content);
      if (ops.length > 0) await handleFileOps(this.app, ops);
    } catch (err) {
      textEl.textContent = `Fel: ${err instanceof Error ? err.message : "okänt fel"}`;
      assistantEl.addClass("gemmera-message--error");
      this.history.pop();
    } finally {
      this.setInputDisabled(false);
      this.inputEl.focus();
    }
  }

  // Capture routes to the ask path for now — the LLM creates notes via fileops.
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

  private setInputDisabled(disabled: boolean): void {
    this.inputEl.disabled = disabled;
    this.sendBtn.disabled = disabled;
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
