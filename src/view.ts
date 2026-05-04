import { ItemView, WorkspaceLeaf } from "obsidian";
import { detectOllama, pickGemmaModel, chat, Message } from "./ollama";
import { searchVault, buildContextPrompt } from "./search";

export const VIEW_TYPE = "gemmera-chat";

export class GemmeraChatView extends ItemView {
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private history: Message[] = [];
  private model = "gemma3:latest";

  constructor(leaf: WorkspaceLeaf) {
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

    // Status bar
    const statusEl = container.createEl("div", { cls: "gemmera-status" });
    this.checkOllamaStatus(statusEl);
    pickGemmaModel().then((m) => { this.model = m; }).catch(() => {});

    // Messages area
    this.messagesEl = container.createEl("div", { cls: "gemmera-messages" });

    // Input area
    const inputArea = container.createEl("div", { cls: "gemmera-input-area" });
    this.inputEl = inputArea.createEl("textarea", {
      cls: "gemmera-input",
      attr: { placeholder: "Skriv ett meddelande...", rows: "3" },
    });
    this.sendBtn = inputArea.createEl("button", {
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
    // cleanup if needed
  }

  private async checkOllamaStatus(el: HTMLElement): Promise<void> {
    el.setText("Kollar Ollama...");
    const status = await detectOllama();
    if (status === "running") {
      el.setText("Ollama: körs");
      el.addClass("gemmera-status--ok");
    } else {
      el.setText("Ollama: hittades inte — starta Ollama för att chatta");
      el.addClass("gemmera-status--error");
    }
  }

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = "";
    this.setInputDisabled(true);

    this.history.push({ role: "user", content: text });
    this.appendMessage("user", text);

    const { el: assistantEl, textEl } = this.appendStreamingMessage();

    try {
      const searchResults = await searchVault(this.app, text);
      const contextPrompt = buildContextPrompt(searchResults);
      const messagesWithContext: Message[] = contextPrompt
        ? [{ role: "user", content: contextPrompt }, { role: "assistant", content: "Förstått, jag har läst anteckningarna." }, ...this.history]
        : this.history;

      const reply = await chat(this.model, messagesWithContext, (token) => {
        textEl.textContent += token;
        this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: "smooth" });
      });
      this.history.push({ role: "assistant", content: reply });
    } catch (err) {
      textEl.textContent = `Fel: ${err instanceof Error ? err.message : "okänt fel"}`;
      assistantEl.addClass("gemmera-message--error");
      this.history.pop();
    } finally {
      this.setInputDisabled(false);
      this.inputEl.focus();
    }
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
