import { App, Modal } from "obsidian";

export class CreateFileModal extends Modal {
  private filename: string;
  private content: string;
  private onConfirm: (filename: string, content: string) => void;

  constructor(
    app: App,
    filename: string,
    content: string,
    onConfirm: (filename: string, content: string) => void,
  ) {
    super(app);
    this.filename = filename;
    this.content = content;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gemmera-modal");

    contentEl.createEl("h2", { text: "Skapa anteckning?" });
    contentEl.createEl("p", { text: `Filnamn: ${this.filename}`, cls: "gemmera-modal__filename" });

    const preview = contentEl.createEl("pre", { cls: "gemmera-modal__preview" });
    preview.textContent = this.content;

    const btnRow = contentEl.createEl("div", { cls: "gemmera-modal__buttons" });
    const confirmBtn = btnRow.createEl("button", { text: "Skapa", cls: "mod-cta" });
    const cancelBtn = btnRow.createEl("button", { text: "Avbryt" });

    confirmBtn.addEventListener("click", () => {
      this.onConfirm(this.filename, this.content);
      this.close();
    });
    cancelBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
