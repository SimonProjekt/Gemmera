import { Modal, type App } from "obsidian";
import type { ConfirmDecision } from "../services/destructive-op-machine";

/**
 * Standard preview gate for rename_or_move_note (#63).
 *
 * Shows the from/to paths and the number of notes whose links will be
 * updated. Respects the "Always preview" setting — the caller may
 * auto-confirm when the user has disabled it, since rename is safe and
 * reversible (Obsidian maintains link integrity via FileManager.renameFile).
 *
 * Unlike DeleteConfirmModal this modal can be bypassed by settings.
 */
export function openRenamePreview(
  app: App,
  from: string,
  to: string,
  affectedLinkCount: number,
): Promise<ConfirmDecision> {
  return new Promise((resolve) => {
    const modal = new RenamePreviewModal(app, from, to, affectedLinkCount, (decision) => {
      modal.close();
      resolve(decision);
    });
    modal.open();
  });
}

class RenamePreviewModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly from: string,
    private readonly to: string,
    private readonly affectedLinkCount: number,
    private readonly onDecide: (d: ConfirmDecision) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this as unknown as { contentEl: HTMLElement };
    contentEl.empty();

    contentEl.createEl("h2", { text: "Rename / move note?" });

    const table = contentEl.createEl("table", { cls: "gemmera-rename-table" });
    const fromRow = table.createEl("tr");
    fromRow.createEl("th", { text: "From" });
    fromRow.createEl("td", { text: this.from, cls: "gemmera-rename-path" });
    const toRow = table.createEl("tr");
    toRow.createEl("th", { text: "To" });
    toRow.createEl("td", { text: this.to, cls: "gemmera-rename-path" });

    if (this.affectedLinkCount > 0) {
      const s = this.affectedLinkCount === 1 ? "link" : "links";
      contentEl.createEl("p", {
        text: `${this.affectedLinkCount} ${s} in your vault will be updated automatically.`,
        cls: "gemmera-rename-hint",
      });
    } else {
      contentEl.createEl("p", {
        text: "No other notes link to this file.",
        cls: "gemmera-rename-hint",
      });
    }

    const actions = contentEl.createEl("div", { cls: "gemmera-rename-actions" });

    const renameBtn = actions.createEl("button", {
      text: "Rename",
      cls: "gemmera-rename-btn gemmera-rename-btn--primary",
    });
    renameBtn.addEventListener("click", () => this.decide("confirmed"));

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      cls: "gemmera-rename-btn",
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
