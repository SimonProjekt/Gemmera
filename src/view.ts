import { ItemView, WorkspaceLeaf } from "obsidian";
import type { ChatMessage, IndexSearchResult } from "./contracts";
import type { IntentLabel, RecentTurn, RouteDecision } from "./contracts/classifier";
import type { Services } from "./services";
import { parseFileOps, handleFileOps } from "./fileops";
import { classifyTurn } from "./services/classifier-orchestrator";
import { toDisambiguationRow } from "./services/classifier-events";
import { DisambiguationChip } from "./disambiguation-chip";
import { IndexingPill } from "./ui/indexing-pill";

export const VIEW_TYPE = "gemmera-chat";

export class GemmeraChatView extends ItemView {
  private messagesEl!: HTMLElement;
  private inputAreaEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private history: ChatMessage[] = [];
  private model = "gemma3:latest";

  private chip = new DisambiguationChip();
  private chipEl: HTMLElement | null = null;
  private recentTurns: RecentTurn[] = [];
  private pill: IndexingPill | null = null;

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

    const headerEl = container.createEl("div", { cls: "gemmera-header" });
    const statusEl = headerEl.createEl("div", { cls: "gemmera-status" });
    this.checkOllamaStatus(statusEl);
    this.services.llm.pickDefaultModel().then((m) => { this.model = m; }).catch(() => {});

    this.pill = new IndexingPill(this.services.runnerStatus);
    this.pill.mount(headerEl, async () => {
      if (this.services.runnerControls.isPaused()) {
        await this.services.runnerControls.resume();
      } else {
        await this.services.runnerControls.pause();
      }
    });

    this.messagesEl = container.createEl("div", { cls: "gemmera-messages" });

    this.inputAreaEl = container.createEl("div", { cls: "gemmera-input-area" });
    this.inputEl = this.inputAreaEl.createEl("textarea", {
      cls: "gemmera-input",
      attr: { placeholder: "Skriv ett meddelande...", rows: "3" },
    });
    this.sendBtn = this.inputAreaEl.createEl("button", {
      cls: "gemmera-send",
      text: "Skicka",
    });
    this.sendBtn.addEventListener("click", () => this.handleSend());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
  }

  async onClose(): Promise<void> {
    this.pill?.unmount();
    this.pill = null;
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

  private async handleSend(forcedLabel?: IntentLabel): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;

    // If chip is showing, queue and return — the chip is still for the
    // first message and applies only to it.
    if (this.chip.isShowing()) {
      this.chip.enqueue(text);
      this.inputEl.value = "";
      return;
    }

    this.inputEl.value = "";
    this.setInputDisabled(true);

    const turnId = crypto.randomUUID();

    // ── Classify ──────────────────────────────────────────────────────
    let route: RouteDecision | null = null;
    if (!forcedLabel) {
      try {
        route = await classifyTurn(
          { messageText: text, attachments: [], activeFile: null, recentTurns: this.recentTurns },
          { llm: this.services.llm, promptLoader: this.services.promptLoader, eventWriter: this.services.classifierEventWriter },
          turnId,
        );
      } catch {
        // Transport error — fall through as "ask" so the main chat can
        // surface the Ollama error to the user.
      }
    }

    // ── Meta short-circuit ────────────────────────────────────────────
    if (route?.shortCircuit && route.helpResponse) {
      this.appendMessage("assistant", route.helpResponse);
      this.setInputDisabled(false);
      this.inputEl.focus();
      return;
    }

    // ── Disambiguation chip ───────────────────────────────────────────
    if (!forcedLabel && route?.needsDisambiguation) {
      this.setInputDisabled(false);
      this.chip.hold(text, turnId, route.decision);
      this.renderChip(route.decision.output?.rationale ?? "");
      this.inputEl.focus();
      return;
    }

    // ── Chat ──────────────────────────────────────────────────────────
    await this.runChat(text, forcedLabel ?? route?.label ?? "ask", turnId);
  }

  private async runChat(text: string, intent: IntentLabel, turnId: string): Promise<void> {
    this.history.push({ role: "user", content: text });
    this.appendMessage("user", text);

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

      // Record for classifier context on the next turn (last 3 only).
      this.recentTurns = [...this.recentTurns.slice(-2), { text, intent }];

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

  // ── Disambiguation chip DOM ──────────────────────────────────────────

  private renderChip(rationale: string): void {
    this.removeChip();

    const chip = this.inputAreaEl.createEl("div", {
      cls: "gemmera-disambig-chip",
      attr: { title: rationale },
    });
    chip.createEl("span", {
      cls: "gemmera-disambig-chip__prompt",
      text: "Did you mean to save this, or ask about it?",
    });

    const actions = chip.createEl("div", { cls: "gemmera-disambig-chip__actions" });

    const saveBtn = actions.createEl("button", {
      cls: "gemmera-disambig-chip__btn gemmera-disambig-chip__btn--save",
      text: "Save",
    });
    const askBtn = actions.createEl("button", {
      cls: "gemmera-disambig-chip__btn gemmera-disambig-chip__btn--ask",
      text: "Ask",
    });
    const cancelBtn = actions.createEl("button", {
      cls: "gemmera-disambig-chip__btn gemmera-disambig-chip__btn--cancel",
      text: "Cancel",
    });

    saveBtn.addEventListener("click", () => this.handleChipAction("save"));
    askBtn.addEventListener("click", () => this.handleChipAction("ask"));
    cancelBtn.addEventListener("click", () => this.handleChipAction("cancel"));

    // Prepend so the chip appears above the textarea.
    this.inputAreaEl.insertBefore(chip, this.inputEl);
    this.chipEl = chip;
  }

  private async handleChipAction(action: "save" | "ask" | "cancel"): Promise<void> {
    this.removeChip();

    if (action === "cancel") {
      const cancelled = this.chip.cancel();
      if (cancelled) {
        await this.services.classifierEventWriter.writeDisambiguation(
          toDisambiguationRow(cancelled.turnId, {
            originalLabel: cancelled.originalDecision.output?.label ?? "ask",
            originalConfidence: cancelled.originalDecision.output?.confidence ?? 0,
            chosenLabel: null,
            cancelled: true,
          }),
        );
      }
    } else {
      const resolution = this.chip.resolve(action);
      if (resolution) {
        const chosenLabel: IntentLabel = action === "save" ? "capture" : "ask";
        await this.services.classifierEventWriter.writeDisambiguation(
          toDisambiguationRow(resolution.turnId, {
            originalLabel: resolution.originalDecision.output?.label ?? "ask",
            originalConfidence: resolution.originalDecision.output?.confidence ?? 0,
            chosenLabel,
            cancelled: false,
          }),
        );
        await this.runChat(resolution.text, chosenLabel, resolution.turnId);
      }
    }

    // Process any messages submitted while the chip was showing.
    // Catch per-iteration: drainQueue() already cleared the internal queue,
    // so an uncaught throw would silently drop everything after the failing item.
    for (const queued of this.chip.drainQueue()) {
      this.inputEl.value = queued;
      try {
        await this.handleSend();
      } catch {
        // runChat handles display errors internally; this guard ensures the
        // remaining queued messages are not lost on an unexpected throw.
      }
    }
  }

  private removeChip(): void {
    this.chipEl?.remove();
    this.chipEl = null;
  }

  // ── DOM helpers ──────────────────────────────────────────────────────

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
