import { Component, MarkdownRenderer, Modal, type App } from "obsidian";

export interface NotePreviewOpts {
  title: string;
  body: string;
  folder: string;
  tags: string[];
}

export interface NotePreviewResult {
  confirmed: true;
  title: string;
  folder: string;
  tags: string[];
}

/**
 * Preview gate for LLM-driven save_note(mode=create) tool calls (#53).
 *
 * Shows editable title, folder path, and tags, plus a rendered Markdown
 * body preview. The modal resolves a Promise the tool dispatcher awaits.
 * Closing via Esc or outside click resolves to null (cancelled).
 */
export function openNotePreview(
  app: App,
  opts: NotePreviewOpts,
): Promise<NotePreviewResult | null> {
  return new Promise((resolve) => {
    const modal = new NotePreviewModal(app, opts, (result) => {
      modal.close();
      resolve(result);
    });
    modal.open();
  });
}

class NotePreviewModal extends Modal {
  private resolved = false;
  private readonly renderOwner = new Component();

  constructor(
    app: App,
    private readonly opts: NotePreviewOpts,
    private readonly onDone: (result: NotePreviewResult | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.renderOwner.load();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gemmera-note-preview");

    contentEl.createEl("h2", { text: "Save new note" });

    // Title
    contentEl.createEl("label", { text: "Title", cls: "gemmera-note-preview__label" });
    const titleInput = contentEl.createEl("input", { cls: "gemmera-note-preview__input" });
    titleInput.type = "text";
    titleInput.value = this.opts.title;

    // Folder
    contentEl.createEl("label", { text: "Folder", cls: "gemmera-note-preview__label" });
    const folderInput = contentEl.createEl("input", { cls: "gemmera-note-preview__input" });
    folderInput.type = "text";
    folderInput.value = this.opts.folder;

    // Tags
    contentEl.createEl("label", { text: "Tags (comma-separated)", cls: "gemmera-note-preview__label" });
    const tagsInput = contentEl.createEl("input", { cls: "gemmera-note-preview__input" });
    tagsInput.type = "text";
    tagsInput.value = this.opts.tags.join(", ");

    // Body preview
    contentEl.createEl("p", { text: "Preview", cls: "gemmera-note-preview__label" });
    const previewEl = contentEl.createEl("div", { cls: "gemmera-note-preview__body" });
    MarkdownRenderer.render(this.app, this.opts.body, previewEl, "", this.renderOwner).catch(() => {
      previewEl.textContent = this.opts.body;
    });

    // Buttons
    const actions = contentEl.createEl("div", { cls: "gemmera-note-preview__actions" });

    const saveBtn = actions.createEl("button", {
      text: "Save",
      cls: "gemmera-note-preview__btn gemmera-note-preview__btn--primary",
    });

    const doSave = (): void => {
      const title = titleInput.value.trim();
      if (!title) return;
      this.decide({
        confirmed: true,
        title,
        folder: folderInput.value.trim() || this.opts.folder,
        tags: tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean),
      });
    };

    // Disable Save when title is empty.
    const updateSaveEnabled = (): void => {
      saveBtn.disabled = titleInput.value.trim().length === 0;
    };
    titleInput.addEventListener("input", updateSaveEnabled);
    updateSaveEnabled();

    saveBtn.addEventListener("click", doSave);

    // Enter in any input field triggers Save (Obsidian convention).
    for (const input of [titleInput, folderInput, tagsInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doSave(); }
      });
    }

    const cancelBtn = actions.createEl("button", {
      text: "Cancel",
      cls: "gemmera-note-preview__btn",
    });
    cancelBtn.addEventListener("click", () => this.decide(null));

    titleInput.focus();
    titleInput.select();
  }

  onClose(): void {
    this.renderOwner.unload();
    if (!this.resolved) {
      this.resolved = true;
      this.onDone(null);
    }
  }

  private decide(result: NotePreviewResult | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onDone(result);
  }
}
