import { Modal, type App } from "obsidian";
import type {
  IngestPreview,
  PreviewDecision,
} from "../services/ingest-orchestrator";

/**
 * Preview gate for the ingest tool loop (#13). Three flavors share one
 * modal subclass:
 *   - `save`  : new note. Buttons: Save, Edit title/tags, Cancel.
 *   - `append`: append-to-existing. Buttons: Append, Cancel.
 *   - `dedup` : near-duplicate found. Buttons: Append, Save anyway, Cancel.
 *
 * The modal resolves a single Promise the orchestrator awaits. Resolving
 * happens in the click handlers; closing without a click resolves to
 * cancel so a stray Esc never strands the orchestrator.
 */
export function openIngestPreview(
  app: App,
  preview: IngestPreview,
): Promise<PreviewDecision> {
  return new Promise((resolve) => {
    const modal = new IngestPreviewModal(app, preview, (decision) => {
      modal.close();
      resolve(decision);
    });
    modal.open();
  });
}

class IngestPreviewModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private readonly preview: IngestPreview,
    private readonly onDecide: (d: PreviewDecision) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this as unknown as { contentEl: HTMLElement };
    contentEl.empty();

    const title = this.preview.kind === "dedup"
      ? "Near-duplicate found"
      : this.preview.kind === "append"
        ? "Append to existing note"
        : "Save new note";
    contentEl.createEl("h2", { text: title });

    if (this.preview.kind === "dedup" && this.preview.strategy.kind === "dedup_ask") {
      const sim = Math.round(this.preview.strategy.similarity * 100);
      contentEl.createEl("p", {
        text: `${this.preview.strategy.target} (${sim}% match). Append to it, save as a new note anyway, or cancel.`,
      });
    } else if (this.preview.kind === "append" && this.preview.strategy.kind === "append") {
      contentEl.createEl("p", {
        text: `Will append under today's heading in ${this.preview.strategy.target}.`,
      });
    } else {
      const folder = "Inbox/";
      contentEl.createEl("p", {
        text: `Will save as a new note in ${folder} with title: ${this.preview.spec.title}`,
      });
    }

    contentEl.createEl("h3", { text: "Title" });
    contentEl.createEl("p", { text: this.preview.spec.title });
    if (this.preview.spec.tags.length > 0) {
      contentEl.createEl("h3", { text: "Tags" });
      contentEl.createEl("p", { text: this.preview.spec.tags.join(", ") });
    }
    contentEl.createEl("h3", { text: "Body" });
    const bodyPre = contentEl.createEl("pre");
    bodyPre.setText(this.preview.spec.body_markdown.slice(0, 1200));

    const actions = contentEl.createEl("div", { cls: "gemmera-ingest-actions" });
    if (this.preview.kind === "dedup") {
      this.addBtn(actions, "Append", () => this.onDecide({ action: "dedup_choice", choice: "append" }));
      this.addBtn(actions, "Save anyway", () => this.onDecide({ action: "dedup_choice", choice: "save_anyway" }));
    } else if (this.preview.kind === "append") {
      this.addBtn(actions, "Append", () => this.onDecide({ action: "confirm" }));
    } else {
      this.addBtn(actions, "Save", () => this.onDecide({ action: "confirm" }));
    }
    this.addBtn(actions, "Cancel", () => this.onDecide({ action: "cancel" }));
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.onDecide({ action: "cancel" });
    }
  }

  private addBtn(parent: HTMLElement, text: string, cb: () => void): void {
    const btn = parent.createEl("button", { text, cls: "gemmera-ingest-btn" });
    btn.addEventListener("click", () => {
      this.resolved = true;
      cb();
    });
  }
}
