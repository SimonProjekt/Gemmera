import type { RetrievalHit, WinningSignal } from "../contracts";
import type { NoteSpec } from "../contracts/ingest";
import type { IngestPreview, PreviewDecision } from "../services/ingest-orchestrator";
import {
  NOTE_STATUSES,
  NOTE_TYPES,
  validateNotePreview,
} from "./note-preview-modal";

/**
 * One entry in the idle-state "recent captures" list. The view appends
 * to this list after every successful ingest turn (#42 acceptance:
 * "Recent captures pull from the chat history store").
 */
export interface RecentCapture {
  title: string;
  path: string;
  timestamp: number;
}

export type ContextPanelState =
  | { kind: "idle"; recentCaptures: RecentCapture[] }
  | { kind: "query"; query: string; hits: RetrievalHit[]; status?: string }
  | { kind: "ingestion"; status: string }
  | {
      kind: "inline-preview";
      preview: IngestPreview;
      fallbackFolder: string;
      onDecide: (d: PreviewDecision) => void;
    };

/**
 * Right-side context panel content controller (#42).
 *
 * Owns a single root <div> and re-renders its body whenever `setState`
 * is called. The outer `gemmera-context-panel` container — which is
 * hidden via CSS `@container` query in narrow mode (#40) — is managed
 * by the view; this class only owns its own subtree.
 *
 * Why a class with a fixed root rather than a free function: the view
 * mounts the history drawer as a sibling inside the same panel, so we
 * need a stable child element we can `replaceChildren` on instead of
 * blowing away the whole panel each turn.
 */
export class ContextPanel {
  private state: ContextPanelState = { kind: "idle", recentCaptures: [] };

  constructor(private readonly root: HTMLElement) {
    this.root.addClass("gemmera-context-content");
    this.render();
  }

  /** Replace the panel state and re-render. */
  setState(state: ContextPanelState): void {
    this.state = state;
    this.render();
  }

  /** Convenience: switch to idle with the supplied captures. */
  setIdle(recentCaptures: RecentCapture[]): void {
    this.setState({ kind: "idle", recentCaptures });
  }

  /** Convenience: switch to query with no hits yet (status only). */
  setQueryPending(query: string, status: string): void {
    this.setState({ kind: "query", query, hits: [], status });
  }

  /** Update the hits inside a query state. No-op if not in query mode. */
  setQueryHits(hits: RetrievalHit[]): void {
    if (this.state.kind !== "query") return;
    this.setState({ kind: "query", query: this.state.query, hits });
  }

  setIngestion(status: string): void {
    this.setState({ kind: "ingestion", status });
  }

  /**
   * Render the pre-save preview inline (#55). Resolves a single
   * PreviewDecision via the supplied callback. The caller is responsible
   * for advancing the panel to its next state (typically "ingestion" → write).
   */
  setInlinePreview(
    preview: IngestPreview,
    fallbackFolder: string,
    onDecide: (d: PreviewDecision) => void,
  ): void {
    this.setState({ kind: "inline-preview", preview, fallbackFolder, onDecide });
  }

  /**
   * True iff the outer panel is currently visible (i.e. wide layout has
   * activated the CSS container query). Used by the view to decide whether
   * inline preview is available, since the container query is CSS-only.
   */
  isWideLayoutActive(): boolean {
    // offsetParent is null when an ancestor is `display: none`, which is how
    // the narrow-mode rule hides .gemmera-context-panel.
    return this.root.offsetParent !== null;
  }

  /** Exposed for tests so they can assert against the rendered tree. */
  get currentState(): ContextPanelState { return this.state; }

  private render(): void {
    this.root.empty();
    switch (this.state.kind) {
      case "idle":
        renderIdle(this.root, this.state.recentCaptures);
        return;
      case "query":
        renderQuery(this.root, this.state.query, this.state.hits, this.state.status);
        return;
      case "ingestion":
        renderIngestion(this.root, this.state.status);
        return;
      case "inline-preview":
        renderInlinePreview(
          this.root,
          this.state.preview,
          this.state.fallbackFolder,
          this.state.onDecide,
        );
        return;
    }
  }
}

function renderIdle(root: HTMLElement, captures: RecentCapture[]): void {
  root.addClass("gemmera-context-content--idle");
  root.removeClass("gemmera-context-content--query", "gemmera-context-content--ingestion");

  root.createEl("h4", { cls: "gemmera-context__title", text: "Recent captures" });

  if (captures.length === 0) {
    root.createEl("p", {
      cls: "gemmera-context__empty",
      text: "No captures yet. Send a note from the composer.",
    });
    return;
  }

  const list = root.createEl("ul", { cls: "gemmera-context__list" });
  for (const c of captures) {
    const item = list.createEl("li", { cls: "gemmera-context__item" });
    item.createEl("span", { cls: "gemmera-context__item-title", text: c.title });
    item.createEl("span", { cls: "gemmera-context__item-meta", text: c.path });
  }
}

function renderQuery(
  root: HTMLElement,
  query: string,
  hits: RetrievalHit[],
  status: string | undefined,
): void {
  root.addClass("gemmera-context-content--query");
  root.removeClass("gemmera-context-content--idle", "gemmera-context-content--ingestion");

  root.createEl("h4", { cls: "gemmera-context__title", text: "Retrieved sources" });
  root.createEl("p", { cls: "gemmera-context__query", text: `“${query}”` });

  if (hits.length === 0) {
    root.createEl("p", {
      cls: "gemmera-context__empty",
      text: status ?? "Searching…",
    });
    return;
  }

  for (const hit of hits) {
    const card = root.createEl("div", { cls: "gemmera-context__chunk" });
    const head = card.createEl("div", { cls: "gemmera-context__chunk-head" });
    head.createEl("span", { cls: "gemmera-context__chunk-title", text: hit.title });
    head.createEl("span", {
      cls: `gemmera-context__chunk-why gemmera-context__chunk-why--${hit.winningSignal}`,
      text: whyLabel(hit.winningSignal),
    });
    head.createEl("span", {
      cls: "gemmera-context__chunk-score",
      text: hit.score.toFixed(2),
    });
    if (hit.headingPath.length > 0) {
      card.createEl("div", {
        cls: "gemmera-context__chunk-path",
        text: hit.headingPath.join(" › "),
      });
    }
    card.createEl("p", {
      cls: "gemmera-context__chunk-text",
      text: snippet(hit.text),
    });
  }
}

function renderIngestion(root: HTMLElement, status: string): void {
  root.addClass("gemmera-context-content--ingestion");
  root.removeClass("gemmera-context-content--idle", "gemmera-context-content--query");

  root.createEl("h4", { cls: "gemmera-context__title", text: "Ingesting" });
  root.createEl("p", { cls: "gemmera-context__status", text: status });
}

function renderInlinePreview(
  root: HTMLElement,
  preview: IngestPreview,
  fallbackFolder: string,
  onDecide: (d: PreviewDecision) => void,
): void {
  root.removeClass(
    "gemmera-context-content--idle",
    "gemmera-context-content--query",
    "gemmera-context-content--ingestion",
  );
  root.addClass("gemmera-context-content--inline-preview");

  // Append and dedup-ask are simple confirm/cancel dialogs without an
  // editable form — leaving them in the modal keeps this surface focused
  // on the create-with-edits flow the issue actually targets.
  if (preview.kind !== "save") {
    root.createEl("h4", { cls: "gemmera-context__title", text: "Preview" });
    root.createEl("p", {
      cls: "gemmera-context__empty",
      text: "Append and dedup decisions open in a modal.",
    });
    onDecide({ action: "cancel" });
    return;
  }

  const spec = preview.spec;
  let resolved = false;
  const decide = (d: PreviewDecision): void => {
    if (resolved) return;
    resolved = true;
    onDecide(d);
  };

  root.createEl("h4", { cls: "gemmera-context__title", text: "Save new note" });

  const form = root.createEl("div", { cls: "gemmera-note-preview gemmera-inline-preview" });

  const titleInput = makeInput(form, "Title", spec.title);
  const folderInput = makeInput(form, "Folder", fallbackFolder);
  const typeSelect = makeSelect(form, "Type", NOTE_TYPES, spec.type);
  const statusSelect = makeSelect(form, "Status", NOTE_STATUSES, spec.status);
  const tagsInput = makeInput(form, "Tags (comma-separated)", spec.tags.join(", "));
  const aliasesInput = makeInput(form, "Aliases (comma-separated)", spec.aliases.join(", "));
  const summaryInput = makeTextarea(form, "Summary (1–600 chars, required)", spec.summary);

  const errorEl = form.createEl("p", { cls: "gemmera-note-preview__error" });
  errorEl.style.display = "none";

  const actions = form.createEl("div", { cls: "gemmera-note-preview__actions" });
  const saveBtn = actions.createEl("button", {
    text: "Save",
    cls: "gemmera-note-preview__btn gemmera-note-preview__btn--primary",
  });
  const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "gemmera-note-preview__btn" });

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
    const result = validateNotePreview(collectRaw(), fallbackFolder);
    if ("error" in result) {
      errorEl.textContent = result.error;
      errorEl.style.display = "block";
      return;
    }
    // Loop back to the orchestrator with the edited spec. The view's router
    // auto-confirms on the next preview call so this counts as one user
    // gesture, not two.
    decide({ action: "edit", spec: mergeEditsIntoSpec(spec, result.value) });
  };

  const updateSaveEnabled = (): void => {
    const result = validateNotePreview(collectRaw(), fallbackFolder);
    saveBtn.disabled = "error" in result;
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
  cancelBtn.addEventListener("click", () => decide({ action: "cancel" }));
}

export function mergeEditsIntoSpec(
  base: NoteSpec,
  edits: { title: string; type: NoteSpec["type"]; status: NoteSpec["status"]; tags: string[]; aliases: string[]; summary: string },
): NoteSpec {
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

function makeInput(parent: HTMLElement, label: string, value: string): HTMLInputElement {
  parent.createEl("label", { text: label, cls: "gemmera-note-preview__label" });
  const input = parent.createEl("input", { cls: "gemmera-note-preview__input" });
  input.type = "text";
  input.value = value;
  return input;
}

function makeTextarea(parent: HTMLElement, label: string, value: string): HTMLTextAreaElement {
  parent.createEl("label", { text: label, cls: "gemmera-note-preview__label" });
  const ta = parent.createEl("textarea", {
    cls: "gemmera-note-preview__input gemmera-note-preview__textarea",
  });
  ta.rows = 3;
  ta.value = value;
  return ta;
}

function makeSelect<T extends string>(
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

export function whyLabel(signal: WinningSignal): string {
  switch (signal) {
    case "semantic": return "semantic";
    case "lexical": return "keyword";
    case "backlink": return "linked";
    case "tag": return "tag";
    case "recency": return "recent";
  }
}

export const MAX_SNIPPET_CHARS = 220;
export function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SNIPPET_CHARS ? flat.slice(0, MAX_SNIPPET_CHARS) + "…" : flat;
}
