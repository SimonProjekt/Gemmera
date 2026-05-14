import { Modal, type App } from "obsidian";
import type { ConfirmDecision } from "../services/destructive-op-machine";

/**
 * Mandatory, non-overridable delete confirmation modal (#44).
 *
 * Shows the target file path and a content preview. The user must click
 * "Delete" to proceed; closing the modal by any other means (Esc, clicking
 * outside) resolves to "cancelled". No setting can bypass this modal.
 */
export function openDeleteConfirm(
  app: App,
  path: string,
  contentPreview: string,
): Promise<ConfirmDecision> {
  return new Promise((resolve) => {
    const modal = new DeleteConfirmModal(app, path, contentPreview, (decision) => {
      modal.close();
      resolve(decision);
    });
    modal.open();
  });
}

class DeleteConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly path: string,
    private readonly contentPreview: string,
    private readonly onDecide: (d: ConfirmDecision) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this as unknown as { contentEl: HTMLElement };
    contentEl.empty();

    contentEl.createEl("h2", { text: "Delete note?" });
    contentEl.createEl("p", { text: this.path, cls: "gemmera-delete-path" });

    if (this.contentPreview) {
      contentEl.createEl("h3", { text: "Preview" });
      const pre = contentEl.createEl("pre", { cls: "gemmera-delete-preview" });
      pre.setText(this.contentPreview);
    }

    contentEl.createEl("p", {
      text: "This will move the note to your system trash (Finder Trash / Recycle Bin). You can restore it from there.",
      cls: "gemmera-delete-hint",
    });

    const actions = contentEl.createEl("div", { cls: "gemmera-delete-actions" });

    const deleteBtn = actions.createEl("button", {
      text: "Delete",
      cls: "gemmera-delete-btn gemmera-delete-btn--destructive",
    });
    deleteBtn.addEventListener("click", () => this.decide("confirmed"));

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      cls: "gemmera-delete-btn",
    });
    cancelBtn.addEventListener("click", () => this.decide("cancelled"));
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.onDecide("cancelled");
    }
  }

  private decide(d: ConfirmDecision): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onDecide(d);
  }
}
