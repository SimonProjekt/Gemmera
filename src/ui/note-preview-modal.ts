import { MarkdownRenderer, Modal, type App } from "obsidian";

export const NOTE_TYPES = ["source", "evergreen", "project", "meeting", "person", "concept"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const NOTE_STATUSES = ["inbox", "processed", "linked", "archived"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export interface NotePreviewOpts {
  title: string;
  body: string;
  folder: string;
  tags: string[];
  aliases?: string[];
  type?: NoteType;
  status?: NoteStatus;
  summary?: string;
}

export interface NotePreviewResult {
  confirmed: true;
  title: string;
  folder: string;
  tags: string[];
  aliases: string[];
  type: NoteType;
  status: NoteStatus;
  summary: string;
}

const MAX_TITLE_LEN = 120;
const MAX_SUMMARY_LEN = 600;

/**
 * Pre-save commit gate for save_note(mode=create) (#52, #53).
 *
 * Shows editable title, folder, frontmatter form (type, status, tags,
 * aliases, summary) over the rag.md contract, and a Markdown body preview.
 * The modal resolves a Promise the dispatcher awaits. Closing via Esc or
 * outside-click resolves to null (cancelled). Cmd/Ctrl+Enter confirms.
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

  constructor(
    app: App,
    private readonly opts: NotePreviewOpts,
    private readonly onDone: (result: NotePreviewResult | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gemmera-note-preview");

    contentEl.createEl("h2", { text: "Save new note" });

    const titleInput = this.makeInput(contentEl, "Title", this.opts.title);
    const folderInput = this.makeInput(contentEl, "Folder", this.opts.folder);

    const typeSelect = this.makeSelect(contentEl, "Type", NOTE_TYPES, this.opts.type ?? "source");
    const statusSelect = this.makeSelect(contentEl, "Status", NOTE_STATUSES, this.opts.status ?? "inbox");

    const tagsInput = this.makeInput(
      contentEl,
      "Tags (comma-separated)",
      this.opts.tags.join(", "),
    );
    const aliasesInput = this.makeInput(
      contentEl,
      "Aliases (comma-separated)",
      (this.opts.aliases ?? []).join(", "),
    );
    const summaryInput = this.makeTextarea(
      contentEl,
      `Summary (1–${MAX_SUMMARY_LEN} chars, required)`,
      this.opts.summary ?? "",
    );

    contentEl.createEl("p", { text: "Preview", cls: "gemmera-note-preview__label" });
    const previewEl = contentEl.createEl("div", { cls: "gemmera-note-preview__body" });
    MarkdownRenderer.render(this.app, this.opts.body, previewEl, "", this).catch(() => {
      previewEl.textContent = this.opts.body;
    });

    const errorEl = contentEl.createEl("p", { cls: "gemmera-note-preview__error" });
    errorEl.style.display = "none";

    const actions = contentEl.createEl("div", { cls: "gemmera-note-preview__actions" });

    const saveBtn = actions.createEl("button", {
      text: "Save",
      cls: "gemmera-note-preview__btn gemmera-note-preview__btn--primary",
    });

    const collectRaw = () => ({
      title: titleInput.value,
      folder: folderInput.value,
      type: typeSelect.value,
      status: statusSelect.value,
      tags: tagsInput.value,
      aliases: aliasesInput.value,
      summary: summaryInput.value,
    });

    const doSave = (): void => {
      const result = validateNotePreview(collectRaw(), this.opts.folder);
      if ("error" in result) {
        errorEl.textContent = result.error;
        errorEl.style.display = "block";
        return;
      }
      this.decide(result.value);
    };

    // Run the full validator so the gate stays correct even if the type/status
    // <select> elements are ever replaced with free-text inputs.
    const updateSaveEnabled = (): void => {
      const result = validateNotePreview(collectRaw(), this.opts.folder);
      saveBtn.disabled = "error" in result;
      // Clear any stale error once the form becomes valid again.
      if (!("error" in result) && errorEl.style.display !== "none") {
        errorEl.style.display = "none";
      }
    };
    for (const el of [titleInput, folderInput, tagsInput, aliasesInput, summaryInput]) {
      el.addEventListener("input", updateSaveEnabled);
    }
    for (const sel of [typeSelect, statusSelect]) {
      sel.addEventListener("change", updateSaveEnabled);
    }
    updateSaveEnabled();

    saveBtn.addEventListener("click", doSave);

    // Cmd/Ctrl+Enter from anywhere in the modal confirms.
    this.scope.register(["Mod"], "Enter", (e) => {
      e.preventDefault();
      doSave();
    });

    // Enter inside a single-line input also confirms (Obsidian convention).
    // The summary textarea is excluded so multiline summaries stay editable.
    for (const input of [titleInput, folderInput, tagsInput, aliasesInput]) {
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

  private makeInput(parent: HTMLElement, label: string, value: string): HTMLInputElement {
    parent.createEl("label", { text: label, cls: "gemmera-note-preview__label" });
    const input = parent.createEl("input", { cls: "gemmera-note-preview__input" });
    input.type = "text";
    input.value = value;
    return input;
  }

  private makeTextarea(parent: HTMLElement, label: string, value: string): HTMLTextAreaElement {
    parent.createEl("label", { text: label, cls: "gemmera-note-preview__label" });
    const ta = parent.createEl("textarea", { cls: "gemmera-note-preview__input gemmera-note-preview__textarea" });
    ta.rows = 3;
    ta.value = value;
    return ta;
  }

  private makeSelect<T extends string>(
    parent: HTMLElement,
    label: string,
    options: readonly T[],
    value: T,
  ): HTMLSelectElement {
    parent.createEl("label", { text: label, cls: "gemmera-note-preview__label" });
    const select = parent.createEl("select", { cls: "gemmera-note-preview__input" });
    for (const opt of options) {
      const o = select.createEl("option", { text: opt });
      o.value = opt;
    }
    select.value = value;
    return select;
  }
}

export function validateNotePreview(
  raw: {
    title: string;
    folder: string;
    type: string;
    status: string;
    tags: string;
    aliases: string;
    summary: string;
  },
  fallbackFolder: string,
): { value: NotePreviewResult } | { error: string } {
  const title = raw.title.trim();
  if (!title) return { error: "Title is required." };
  if (title.length > MAX_TITLE_LEN) {
    return { error: `Title must be ≤ ${MAX_TITLE_LEN} characters.` };
  }
  if (!(NOTE_TYPES as readonly string[]).includes(raw.type)) {
    return { error: `Type must be one of: ${NOTE_TYPES.join(", ")}.` };
  }
  if (!(NOTE_STATUSES as readonly string[]).includes(raw.status)) {
    return { error: `Status must be one of: ${NOTE_STATUSES.join(", ")}.` };
  }
  const summary = raw.summary.trim();
  if (!summary) return { error: "Summary is required." };
  if (summary.length > MAX_SUMMARY_LEN) {
    return { error: `Summary must be ≤ ${MAX_SUMMARY_LEN} characters.` };
  }
  return {
    value: {
      confirmed: true,
      title,
      folder: raw.folder.trim() || fallbackFolder,
      type: raw.type as NoteType,
      status: raw.status as NoteStatus,
      tags: splitCsv(raw.tags),
      aliases: splitCsv(raw.aliases),
      summary,
    },
  };
}

function splitCsv(value: string): string[] {
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}
