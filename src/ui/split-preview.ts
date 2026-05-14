import { Component, MarkdownRenderer, Modal, type App } from "obsidian";
import type { NoteSpec } from "../contracts/ingest";
import type { PreviewDecision } from "../services/ingest-orchestrator";
import {
  NOTE_STATUSES,
  NOTE_TYPES,
  validateNotePreview,
  type NotePreviewResult,
} from "./note-preview-modal";

/**
 * Split-mode commit gate for #160 (the remaining AC of #52).
 *
 * Walks the candidates sequentially, opening one modal per candidate with
 * a "i of N" indicator. Three outcomes per modal:
 *   - Save        → push the edited NoteSpec to `confirmed`, advance.
 *   - Skip        → advance without pushing.
 *   - Cancel all  → break the loop; whatever was already confirmed still ships.
 *   - Esc / outside-click → cancel-all (matches NotePreviewModal semantics).
 *
 * If nothing was confirmed by the time the loop ends, the decision collapses
 * to `{ action: "cancel" }` so the orchestrator's split_saved branch doesn't
 * fire an empty "saved 0 notes" notice.
 *
 * Folder is intentionally NOT editable per-candidate: the ingest orchestrator
 * writes every split candidate into `deps.inboxFolder`, so a per-modal Folder
 * input would silently discard the user's edit. If per-candidate placement is
 * needed later, plumb `folder` through `NoteSpec` and the writer first.
 */
export interface SplitPreviewDefaults {
  folder: string;
}

export async function openSplitPreview(
  app: App,
  candidates: NoteSpec[],
  defaults: SplitPreviewDefaults,
): Promise<PreviewDecision> {
  // Collect outcomes then reduce, so the production path goes through the
  // exact same logic the tests exercise.
  const outcomes: OneOutcome[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const outcome = await openOne(app, candidates[i], defaults.folder, i, candidates.length);
    outcomes.push(outcome);
    if (outcome.kind === "cancelled") break;
  }
  return reduceSplitOutcomes(candidates, outcomes);
}

type OneOutcome =
  | { kind: "saved"; result: NotePreviewResult }
  | { kind: "skipped" }
  | { kind: "cancelled" };

function openOne(
  app: App,
  candidate: NoteSpec,
  fallbackFolder: string,
  index: number,
  total: number,
): Promise<OneOutcome> {
  return new Promise((resolve) => {
    const modal = new SplitPreviewModal(app, candidate, fallbackFolder, index, total, (outcome) => {
      modal.close();
      resolve(outcome);
    });
    modal.open();
  });
}

function applyEditsToSpec(base: NoteSpec, edits: NotePreviewResult): NoteSpec {
  return {
    ...base,
    title: edits.title,
    type: edits.type,
    status: edits.status,
    tags: edits.tags,
    aliases: edits.aliases,
    summary: edits.summary,
  };
}

class SplitPreviewModal extends Modal {
  private resolved = false;
  private readonly renderOwner = new Component();

  constructor(
    app: App,
    private readonly candidate: NoteSpec,
    private readonly fallbackFolder: string,
    private readonly index: number,
    private readonly total: number,
    private readonly onDone: (outcome: OneOutcome) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.renderOwner.load();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gemmera-note-preview");

    contentEl.createEl("h2", {
      text: `Save split note (${this.index + 1} of ${this.total})`,
    });

    const titleInput = this.makeInput(contentEl, "Title", this.candidate.title);
    const typeSelect = this.makeSelect(contentEl, "Type", NOTE_TYPES, this.candidate.type);
    const statusSelect = this.makeSelect(contentEl, "Status", NOTE_STATUSES, this.candidate.status);
    const tagsInput = this.makeInput(contentEl, "Tags (comma-separated)", this.candidate.tags.join(", "));
    const aliasesInput = this.makeInput(
      contentEl,
      "Aliases (comma-separated)",
      this.candidate.aliases.join(", "),
    );
    const summaryInput = this.makeTextarea(
      contentEl,
      "Summary (1–600 chars, required)",
      this.candidate.summary,
      "Required: 1–2 sentences summarizing this section",
    );

    contentEl.createEl("p", { text: "Preview", cls: "gemmera-note-preview__label" });
    const previewEl = contentEl.createEl("div", { cls: "gemmera-note-preview__body" });
    MarkdownRenderer.render(this.app, this.candidate.body_markdown, previewEl, "", this.renderOwner).catch(() => {
      previewEl.textContent = this.candidate.body_markdown;
    });

    const errorEl = contentEl.createEl("p", { cls: "gemmera-note-preview__error" });
    errorEl.style.display = "none";

    const actions = contentEl.createEl("div", { cls: "gemmera-note-preview__actions" });
    const saveBtn = actions.createEl("button", {
      text: "Save",
      cls: "gemmera-note-preview__btn gemmera-note-preview__btn--primary",
    });
    const skipBtn = actions.createEl("button", { text: "Skip", cls: "gemmera-note-preview__btn" });
    const cancelBtn = actions.createEl("button", { text: "Cancel all", cls: "gemmera-note-preview__btn" });

    const collectRaw = () => ({
      title: titleInput.value,
      folder: this.fallbackFolder,
      type: typeSelect.value,
      status: statusSelect.value,
      tags: tagsInput.value,
      aliases: aliasesInput.value,
      summary: summaryInput.value,
    });

    const doSave = (): void => {
      const result = validateNotePreview(collectRaw(), this.fallbackFolder);
      if ("error" in result) {
        errorEl.textContent = result.error;
        errorEl.style.display = "block";
        return;
      }
      this.decide({ kind: "saved", result: result.value });
    };

    const updateSaveEnabled = (): void => {
      const result = validateNotePreview(collectRaw(), this.fallbackFolder);
      saveBtn.disabled = "error" in result;
      if (!("error" in result) && errorEl.style.display !== "none") {
        errorEl.style.display = "none";
      }
    };
    for (const el of [titleInput, tagsInput, aliasesInput, summaryInput]) {
      el.addEventListener("input", updateSaveEnabled);
    }
    for (const sel of [typeSelect, statusSelect]) {
      sel.addEventListener("change", updateSaveEnabled);
    }
    updateSaveEnabled();

    saveBtn.addEventListener("click", doSave);
    skipBtn.addEventListener("click", () => this.decide({ kind: "skipped" }));
    cancelBtn.addEventListener("click", () => this.decide({ kind: "cancelled" }));

    this.scope.register(["Mod"], "Enter", (e) => {
      e.preventDefault();
      doSave();
    });
    for (const input of [titleInput, tagsInput, aliasesInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doSave(); }
      });
    }

    titleInput.focus();
    titleInput.select();
  }

  onClose(): void {
    this.renderOwner.unload();
    if (!this.resolved) {
      this.resolved = true;
      // Esc / outside-click cancels the whole sequence — matches the single
      // NotePreviewModal so users don't have to remember two different
      // dismissal semantics. Use the Skip button to skip just this candidate.
      this.onDone({ kind: "cancelled" });
    }
  }

  private decide(outcome: OneOutcome): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onDone(outcome);
  }

  private makeInput(parent: HTMLElement, label: string, value: string): HTMLInputElement {
    parent.createEl("label", { text: label, cls: "gemmera-note-preview__label" });
    const input = parent.createEl("input", { cls: "gemmera-note-preview__input" });
    input.type = "text";
    input.value = value;
    return input;
  }

  private makeTextarea(
    parent: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
  ): HTMLTextAreaElement {
    parent.createEl("label", { text: label, cls: "gemmera-note-preview__label" });
    const ta = parent.createEl("textarea", { cls: "gemmera-note-preview__input gemmera-note-preview__textarea" });
    ta.rows = 3;
    ta.value = value;
    ta.placeholder = placeholder;
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

/**
 * Pure helper exported for tests: derives the final PreviewDecision from a
 * sequence of per-candidate outcomes. `openSplitPreview` calls this directly,
 * so the tests exercise the exact code path production uses.
 */
export function reduceSplitOutcomes(
  candidates: NoteSpec[],
  outcomes: ReadonlyArray<OneOutcome>,
): PreviewDecision {
  const confirmed: NoteSpec[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.kind === "saved") {
      confirmed.push(applyEditsToSpec(candidates[i], o.result));
    } else if (o.kind === "cancelled") {
      break;
    }
  }
  if (confirmed.length === 0) return { action: "cancel" };
  return { action: "split_confirm", confirmed };
}

export type { OneOutcome };
