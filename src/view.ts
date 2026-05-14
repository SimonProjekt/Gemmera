import { FileSystemAdapter, ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { ChatHistoryStore } from "./services/chat-history";
import type { ChatMessage, IndexSearchResult } from "./contracts";
import type { IntentLabel, RecentTurn, RouteDecision } from "./contracts/classifier";
import type { Services } from "./services";
import type { GemmeraSettings } from "./settings";
import { parseFileOps, handleFileOps } from "./fileops";
import { classifyTurn } from "./services/classifier-orchestrator";
import { toDisambiguationRow } from "./services/classifier-events";
import { runIngest } from "./services/ingest-orchestrator";
import { runMixed } from "./services/mixed-orchestrator";
import { runQuery } from "./services/query-orchestrator";
import { createSynthesisNote } from "./services/synthesis-writer";
import { dispatchToolCall, SAVE_NOTE_TOOL, type ToolDispatchDeps } from "./services/tool-dispatcher";
import { DisambiguationChip } from "./disambiguation-chip";
import { IndexingPill } from "./ui/indexing-pill";
import { openIngestPreview } from "./ui/ingest-preview-modal";
import { openNotePreview } from "./ui/note-preview-modal";
import { buildMessageDecoration } from "./message-decoration";
import { showSaveUndoNotice } from "./notices";
import { labelForState } from "./services/turn-status";
import { CitationChipRow } from "./ui/citation-chips";

export const VIEW_TYPE = "gemmera-chat";

export class GemmeraChatView extends ItemView {
  private messagesEl!: HTMLElement;
  private inputAreaEl!: HTMLElement;
  private contextPanelEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private history: ChatMessage[] = [];

  private chip = new DisambiguationChip();
  private chipEl: HTMLElement | null = null;
  private statusChipEl: HTMLElement | null = null;
  private recentTurns: RecentTurn[] = [];
  private pill: IndexingPill | null = null;

  private chatHistory: ChatHistoryStore | null = null;
  private currentSessionId: string | null = null;
  private escCleared = false;
  private prefersReducedMotion = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly services: Services,
    private readonly settings: GemmeraSettings,
  ) {
    super(leaf);
    this.prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

  /** Pre-fill the composer with text and focus it. Does NOT send. */
  setComposerText(text: string): void {
    this.inputEl.value = text;
    this.inputEl.focus();
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("gemmera-view");

    const headerEl = container.createEl("div", { cls: "gemmera-header" });
    const statusEl = headerEl.createEl("div", {
      cls: "gemmera-status",
      attr: { role: "status", "aria-live": "polite" },
    });
    this.checkOllamaStatus(statusEl);

    this.pill = new IndexingPill(this.services.runnerStatus);
    this.pill.mount(headerEl, async () => {
      if (this.services.runnerControls.isPaused()) {
        await this.services.runnerControls.resume();
      } else {
        await this.services.runnerControls.pause();
      }
    });

    const bodyEl = container.createEl("div", { cls: "gemmera-body" });
    const mainEl = bodyEl.createEl("div", { cls: "gemmera-main" });

    this.messagesEl = mainEl.createEl("div", {
      cls: "gemmera-messages",
      attr: { role: "log", "aria-label": "Chat messages" },
    });

    this.statusChipEl = mainEl.createEl("div", { cls: "gemmera-status-chip" });
    this.statusChipEl.hide();

    this.inputAreaEl = mainEl.createEl("div", { cls: "gemmera-input-area" });
    this.inputEl = this.inputAreaEl.createEl("textarea", {
      cls: "gemmera-input",
      attr: {
        placeholder: "Skriv ett meddelande...",
        rows: "3",
        "aria-label": "Message input",
      },
    });
    this.sendBtn = this.inputAreaEl.createEl("button", {
      cls: "gemmera-send",
      text: "Skicka",
      attr: { "aria-label": "Send message" },
    });
    this.sendBtn.addEventListener("click", () => this.handleSend());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.inputEl.value.trim().length > 0 && !this.escCleared) {
          this.inputEl.value = "";
          this.escCleared = true;
          e.preventDefault();
        } else {
          this.app.workspace.detachLeavesOfType(VIEW_TYPE);
        }
        return;
      }
      this.escCleared = false;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    this.contextPanelEl = bodyEl.createEl("div", { cls: "gemmera-context-panel" });

    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const historyPath = adapter.getFullPath(".coworkmd/chats.json");
    this.chatHistory = new ChatHistoryStore(historyPath);
    // Sessions are created lazily on the first persisted turn so opening the
    // panel without sending anything doesn't accumulate empty rows in chats.json.
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
          { llm: this.services.llm, promptLoader: this.services.promptLoader, eventWriter: this.services.classifierEventWriter, model: this.settings.chatModel },
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

    // ── Capture (#13) ─────────────────────────────────────────────────
    const intent = forcedLabel ?? route?.label ?? "ask";
    if (intent === "capture") {
      await this.runCapture(text, turnId);
      this.recentTurns = [...this.recentTurns.slice(-2), { text, intent: "capture" }];
      this.setInputDisabled(false);
      this.inputEl.focus();
      return;
    }

    // ── Mixed (#47) ───────────────────────────────────────────────────
    if (intent === "mixed") {
      await this.runMixed(text, turnId);
      this.recentTurns = [...this.recentTurns.slice(-2), { text, intent: "mixed" }];
      this.setInputDisabled(false);
      this.inputEl.focus();
      return;
    }

    // ── Ask (#14) — vault-grounded query through the RAG tool loop ────
    if (intent === "ask") {
      await this.runAsk(text, turnId, route ?? null);
      this.recentTurns = [...this.recentTurns.slice(-2), { text, intent: "ask" }];
      this.setInputDisabled(false);
      this.inputEl.focus();
      return;
    }

    // ── Chat (meta / fallback, no retrieval) ──────────────────────────
    await this.runChat(text, intent, turnId, route ?? null);
  }

  private async runCapture(text: string, turnId: string): Promise<void> {
    this.appendMessage("user", text);
    try {
      const outcome = await runIngest(
        { text },
        {
          llm: this.services.llm,
          promptLoader: this.services.promptLoader,
          retriever: this.services.retriever,
          store: this.services.ingestionStore,
          vault: this.services.vault,
          writer: this.services.ingestWriter,
          jobQueue: this.services.jobQueue,
          preview: (preview) => openIngestPreview(this.app, preview),
          eventLog: this.services.eventLog,
          turnId,
          inboxFolder: this.settings.inboxFolder,
          dedupThreshold: this.settings.dedupThreshold,
          alwaysPreview: this.settings.alwaysPreviewBeforeSave,
          onStateChange: (state, label) => {
            if (state === "DONE" || state === "CANCELLED" || state === "TOOL_FAILED") {
              this.hideStatusChip();
            } else {
              this.showStatusChip(label);
            }
          },
        },
      );
      this.services.runnerStatus.recompute();

      if (outcome.kind === "saved") {
        const verb = outcome.mode === "append" ? "Appended to" : "Saved to";
        if (outcome.mode === "create") {
          showSaveUndoNotice(this.app, outcome.path);
        } else {
          new Notice(`Gemmera: ${verb} ${outcome.path}`);
        }
        this.appendMessage("assistant", `${verb} **${outcome.path}**`);
      } else if (outcome.kind === "split_saved") {
        new Notice(`Gemmera: saved ${outcome.paths.length} notes`);
        const list = outcome.paths.map((p) => `- **${p}**`).join("\n");
        this.appendMessage("assistant", `Saved ${outcome.paths.length} notes:\n${list}`);
      } else if (outcome.kind === "cancelled") {
        this.appendMessage("assistant", "Cancelled.");
      } else if (outcome.kind === "skipped_existing") {
        new Notice(`Gemmera: already saved as ${outcome.path}`);
        this.appendMessage("assistant", `Already in vault: **${outcome.path}**`);
      } else {
        this.appendMessage("assistant", `Capture failed: ${outcome.reason}`);
      }
    } catch (err) {
      this.appendErrorMessage(err, () => { this.inputEl.value = text; this.inputEl.focus(); });
    }
  }

  private async runMixed(text: string, turnId: string): Promise<void> {
    this.appendMessage("user", text);

    const ingestStatusEl = this.messagesEl.createEl("div", {
      cls: "gemmera-mixed-status gemmera-mixed-status--ingest",
      text: "Saving note…",
    });
    const queryStatusEl = this.messagesEl.createEl("div", {
      cls: "gemmera-mixed-status gemmera-mixed-status--query",
      text: "Searching notes…",
    });
    queryStatusEl.style.display = "none";

    let savedPathSoFar: string | undefined;

    try {
      const outcome = await runMixed(text, {
        llm: this.services.llm,
        promptLoader: this.services.promptLoader,
        retriever: this.services.retriever,
        store: this.services.ingestionStore,
        vault: this.services.vault,
        writer: this.services.ingestWriter,
        jobQueue: this.services.jobQueue,
        preview: (preview) => openIngestPreview(this.app, preview),
        assembler: this.services.payloadAssembler,
        eventLog: this.services.eventLog,
        turnId,
        inboxFolder: this.settings.inboxFolder,
        dedupThreshold: this.settings.dedupThreshold,
        alwaysPreview: this.settings.alwaysPreviewBeforeSave,
        onStateChange: (state, label, phase) => {
          if (phase === "ingest") {
            ingestStatusEl.textContent = label;
          } else {
            queryStatusEl.style.display = "";
            queryStatusEl.textContent = label;
          }
        },
        onIngestComplete: (path) => { savedPathSoFar = path; },
      });

      this.services.runnerStatus.recompute();
      ingestStatusEl.remove();
      queryStatusEl.remove();

      if (outcome.kind === "cancelled") {
        this.appendMessage("assistant", "Cancelled.");
      } else if (outcome.kind === "failed") {
        if (outcome.phase === "query" && outcome.savedPath) {
          this.appendMessage("assistant", `Answer failed: ${outcome.reason}\n\nNote was saved to **${outcome.savedPath}**.`);
        } else {
          this.appendMessage("assistant", `Save failed: ${outcome.reason}`);
        }
      } else if (outcome.kind === "validation_failed") {
        new Notice(`Gemmera: saved to ${outcome.savedPath}`);
        this.appendMessage("assistant", `Saved to **${outcome.savedPath}**\n\n${outcome.answer}`);
      } else {
        new Notice(`Gemmera: saved to ${outcome.savedPath}`);
        const citations = outcome.citations.length > 0
          ? `\n\n*Sources: ${outcome.citations.map((c) => `[[${c}]]`).join(", ")}*`
          : "";
        this.appendMessage("assistant", `Saved to **${outcome.savedPath}**\n\n${outcome.answer}${citations}`);
      }
    } catch (err) {
      ingestStatusEl.remove();
      queryStatusEl.remove();
      if (savedPathSoFar) {
        this.appendMessage("assistant", `Note was saved to **${savedPathSoFar}**, but the query failed unexpectedly.`);
      }
      this.appendErrorMessage(err, () => { this.inputEl.value = text; this.inputEl.focus(); });
    }
  }

  // INVARIANT (#14): every vault-tagged turn ("ask" intent, or "mixed" via
  // runMixed) must reach `runQuery`, which exercises the hybrid retriever and
  // emits a RETRIEVE event. Do NOT route ask intents through `runChat`: that
  // path uses the linear scan kept only as a fallback for `meta`.
  private async runAsk(
    text: string,
    turnId: string,
    route: RouteDecision | null = null,
  ): Promise<void> {
    const decoration = buildMessageDecoration(
      route,
      this.settings.showClassifierDecisions,
      this.settings.alwaysPreviewBeforeSave,
    );
    this.appendMessage("user", text, decoration);

    const statusEl = this.messagesEl.createEl("div", {
      cls: "gemmera-mixed-status gemmera-mixed-status--query",
      text: "Searching notes…",
    });

    try {
      const outcome = await runQuery(
        { query: text },
        {
          retriever: this.services.retriever,
          assembler: this.services.payloadAssembler,
          llm: this.services.llm,
          eventLog: this.services.eventLog,
          turnId,
          model: this.settings.chatModel,
          onStateChange: (_state, label) => {
            statusEl.textContent = label;
          },
        },
      );

      statusEl.remove();

      if (outcome.kind === "empty") {
        this.appendMessage("assistant", "No relevant notes found.");
      } else if (outcome.kind === "failed") {
        this.appendMessage("assistant", `Answer failed: ${outcome.reason}`);
      } else if (outcome.kind === "validation_failed") {
        this.appendMessage("assistant", outcome.answer);
      } else {
        const el = this.messagesEl.createEl("div", { cls: "gemmera-message gemmera-message--assistant" });
        el.createEl("span", { cls: "gemmera-message__role", text: "Gemma" });
        el.createEl("p", { cls: "gemmera-message__text", text: outcome.answer });
        if (outcome.citations.length > 0) {
          this.renderCitationChips(el, outcome.citations);
        }
        this.renderSynthesisButton(el, {
          question: text,
          answer: outcome.answer,
          citations: outcome.citations,
          turnId,
        });
        this.scrollToBottom();
      }
    } catch (err) {
      statusEl.remove();
      this.appendErrorMessage(err, () => { this.inputEl.value = text; this.inputEl.focus(); });
    }
  }

  private async runChat(
    text: string,
    intent: IntentLabel,
    turnId: string,
    route: RouteDecision | null = null,
  ): Promise<void> {
    const decoration = buildMessageDecoration(
      route,
      this.settings.showClassifierDecisions,
      this.settings.alwaysPreviewBeforeSave,
    );

    this.history.push({ role: "user", content: text });
    this.appendMessage("user", text, decoration);

    // Silent-save indicator: appears before the LLM call and is removed after.
    let silentSaveEl: HTMLElement | null = null;
    if (decoration.silentSave) {
      silentSaveEl = this.messagesEl.createEl("div", {
        cls: "gemmera-silent-save-indicator",
        text: "saving as note…",
      });
    }

    const userTs = Date.now();
    const { el: assistantEl, textEl } = this.appendStreamingMessage();

    try {
      const searchResults = await this.services.index.search(text);
      const messages = withContext(this.history, searchResults);

      const reply = await this.services.llm.chat({
        model: this.settings.chatModel,
        messages,
        tools: [SAVE_NOTE_TOOL],
        onToken: (token) => {
          textEl.textContent += token;
          this.scrollToBottom();
        },
      });
      this.history.push({ role: "assistant", content: reply.content });

      // Dispatch structured tool calls emitted by the LLM (#53).
      if (reply.toolCalls && reply.toolCalls.length > 0) {
        const dispatchDeps: ToolDispatchDeps = {
          vault: this.services.vault,
          inboxFolder: this.settings.inboxFolder,
          openNotePreview: (opts) => openNotePreview(this.app, opts),
          appendSystemMessage: (msg) => this.appendMessage("assistant", msg),
        };
        for (const call of reply.toolCalls) {
          try {
            const result = await dispatchToolCall(call, dispatchDeps);
            if (result.kind === "done") {
              this.appendMessage("assistant", result.summary);
            } else if (result.kind === "unknown_tool") {
              this.appendMessage("assistant", `Unknown tool: ${call.name}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.appendMessage("assistant", `Tool call failed: ${msg}`);
          }
        }
      }

      if (this.chatHistory) {
        const ch = this.chatHistory;
        (async () => {
          if (!this.currentSessionId) {
            const session = await ch.createSession();
            this.currentSessionId = session.id;
          }
          const sid = this.currentSessionId;
          await ch.appendTurn(sid, { role: "user", content: text, timestamp: userTs });
          await ch.appendTurn(sid, { role: "assistant", content: reply.content, timestamp: Date.now() });
        })().catch(() => {});
      }

      // Record for classifier context on the next turn (last 3 only).
      this.recentTurns = [...this.recentTurns.slice(-2), { text, intent }];

      const ops = parseFileOps(reply.content);
      if (ops.length > 0) await handleFileOps(this.app, ops);

      // Render citation chips from wikilinks in the response.
      const citations = extractWikilinks(reply.content);
      if (citations.length > 0) {
        this.renderCitationChips(assistantEl, citations);
      }
    } catch (err) {
      assistantEl.remove();
      this.history.pop();
      this.appendErrorMessage(err, () => { this.inputEl.value = text; this.inputEl.focus(); });
    } finally {
      silentSaveEl?.remove();
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
      attr: { "aria-label": "Save as note" },
    });
    const askBtn = actions.createEl("button", {
      cls: "gemmera-disambig-chip__btn gemmera-disambig-chip__btn--ask",
      text: "Ask",
      attr: { "aria-label": "Ask question" },
    });
    const cancelBtn = actions.createEl("button", {
      cls: "gemmera-disambig-chip__btn gemmera-disambig-chip__btn--cancel",
      text: "Cancel",
      attr: { "aria-label": "Cancel" },
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
            // null when the original decision was a fallback (no model output).
            // Defaulting to "ask" here would mislabel fallback rows as model-
            // emitted "ask" corrections in the eval golden set.
            originalLabel: cancelled.originalDecision.output?.label ?? null,
            originalConfidence: cancelled.originalDecision.output?.confidence ?? null,
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
            originalLabel: resolution.originalDecision.output?.label ?? null,
            originalConfidence: resolution.originalDecision.output?.confidence ?? null,
            chosenLabel,
            cancelled: false,
          }),
        );
        if (chosenLabel === "capture") {
          await this.runCapture(resolution.text, resolution.turnId);
          this.recentTurns = [
            ...this.recentTurns.slice(-2),
            { text: resolution.text, intent: "capture" },
          ];
        } else {
          await this.runAsk(resolution.text, resolution.turnId);
          this.recentTurns = [
            ...this.recentTurns.slice(-2),
            { text: resolution.text, intent: "ask" },
          ];
        }
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

  private showStatusChip(label: string): void {
    if (!this.statusChipEl) return;
    this.statusChipEl.textContent = label;
    this.statusChipEl.show();
  }

  private hideStatusChip(): void {
    this.statusChipEl?.hide();
  }

  private renderCitationChips(parent: HTMLElement, citations: string[], needsReview = new Set<string>()): void {
    if (citations.length === 0) return;
    new CitationChipRow(this.app, parent, citations, needsReview);
  }

  private renderSynthesisButton(
    parent: HTMLElement,
    payload: { question: string; answer: string; citations: string[]; turnId: string },
  ): void {
    const btn = parent.createEl("button", {
      cls: "gemmera-synthesis-btn",
      text: "Save answer as note",
      attr: { "aria-label": "Save this answer as a synthesis note" },
    });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        const { path } = await createSynthesisNote(
          {
            question: payload.question,
            answer: payload.answer,
            citations: payload.citations,
            model: this.settings.chatModel,
            runId: payload.turnId,
          },
          this.services.ingestWriter,
          { folder: this.settings.inboxFolder },
        );
        btn.remove();
        new Notice(`Gemmera: synthesis saved to ${path}`);
        this.appendMessage("assistant", `Synthesis saved to **${path}**`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Save answer as note";
        new Notice(`Gemmera: synthesis save failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  // ── DOM helpers ──────────────────────────────────────────────────────

  private setInputDisabled(disabled: boolean): void {
    this.inputEl.disabled = disabled;
    this.sendBtn.disabled = disabled;
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTo({
      top: this.messagesEl.scrollHeight,
      behavior: this.prefersReducedMotion ? "auto" : "smooth",
    });
  }

  private appendStreamingMessage(): { el: HTMLElement; textEl: HTMLElement } {
    const el = this.messagesEl.createEl("div", { cls: "gemmera-message gemmera-message--assistant" });
    el.createEl("span", { cls: "gemmera-message__role", text: "Gemma" });
    const textEl = el.createEl("p", { cls: "gemmera-message__text", text: "" });
    this.scrollToBottom();
    return { el, textEl };
  }

  private appendMessage(
    role: "user" | "assistant",
    text: string,
    decoration?: { badge: string | null; tooltip: string | null } | null,
  ): void {
    const msg = this.messagesEl.createEl("div", { cls: `gemmera-message gemmera-message--${role}` });
    msg.createEl("span", { cls: "gemmera-message__role", text: role === "user" ? "Du" : "Gemma" });
    msg.createEl("p", { cls: "gemmera-message__text", text });
    if (decoration?.badge) {
      const badge = msg.createEl("span", { cls: "gemmera-classifier-badge", text: decoration.badge });
      if (decoration.tooltip) badge.setAttribute("title", decoration.tooltip);
    }
    this.scrollToBottom();
  }

  private appendErrorMessage(err: unknown, onRetry: () => void): void {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const category = categorizeError(err);
    const displayText = userMessageForCategory(category, rawMessage);

    const el = this.messagesEl.createEl("div", {
      cls: "gemmera-message gemmera-message--assistant gemmera-message--error",
    });
    el.createEl("span", { cls: "gemmera-message__role", text: "Gemma" });
    el.createEl("p", { cls: "gemmera-message__text", text: displayText });
    const retryBtn = el.createEl("button", {
      cls: "gemmera-retry-btn",
      text: "Retry",
      attr: { "aria-label": "Retry last message" },
    });
    retryBtn.addEventListener("click", () => {
      el.remove();
      onRetry();
    });

    if (category === "ollama_down") {
      new Notice("Gemmera: Ollama is not responding. Check Settings → Gemmera → Ollama.");
    }

    this.scrollToBottom();
  }
}

type ErrorCategory = "ollama_down" | "timeout" | "model_missing" | "unknown";

function categorizeError(err: unknown): ErrorCategory {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  if (msg.includes("timeout")) return "timeout";
  if (msg.includes("econnrefused") || msg.includes("failed to fetch") || msg.includes("network error")) {
    return "ollama_down";
  }
  if (msg.includes("not found") || msg.includes("pull model") || msg.includes("no such model")) {
    return "model_missing";
  }
  return "unknown";
}

function userMessageForCategory(category: ErrorCategory, rawMessage: string): string {
  switch (category) {
    case "ollama_down": return "Ollama is not responding. Make sure Ollama is running and try again.";
    case "timeout": return "The request timed out. Please try again.";
    case "model_missing": return "Model not found. Check your Ollama installation.";
    default: return `Something went wrong: ${rawMessage}`;
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

/** Extract unique [[wikilink]] paths from markdown text. */
export function extractWikilinks(text: string): string[] {
  const re = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
  const seen = new Set<string>();
  const result: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1].trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}
