import { ItemView, WorkspaceLeaf } from "obsidian";
import { detectOllama } from "./ollama";

export const VIEW_TYPE = "gemmera-chat";

export class GemmeraChatView extends ItemView {
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;

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

    // Messages area
    this.messagesEl = container.createEl("div", { cls: "gemmera-messages" });

    // Input area
    const inputArea = container.createEl("div", { cls: "gemmera-input-area" });
    this.inputEl = inputArea.createEl("textarea", {
      cls: "gemmera-input",
      attr: { placeholder: "Skriv ett meddelande...", rows: "3" },
    });
    const sendBtn = inputArea.createEl("button", {
      cls: "gemmera-send",
      text: "Skicka",
    });
    sendBtn.addEventListener("click", () => this.handleSend());
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

  private handleSend(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.appendMessage("user", text);
    this.inputEl.value = "";
    // LLM call will be wired in a later issue
    this.appendMessage("assistant", "(Ollama-integration kommer i nästa steg)");
  }

  private appendMessage(role: "user" | "assistant", text: string): void {
    const msg = this.messagesEl.createEl("div", { cls: `gemmera-message gemmera-message--${role}` });
    msg.createEl("span", { cls: "gemmera-message__role", text: role === "user" ? "Du" : "Gemma" });
    msg.createEl("p", { cls: "gemmera-message__text", text });
    this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: "smooth" });
  }
}
