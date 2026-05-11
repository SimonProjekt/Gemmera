import { App, Notice } from "obsidian";

/** Show "Note saved to Inbox/<title>.md" with an Undo action that trashes the file. */
export function showSaveUndoNotice(app: App, path: string): void {
  const frag = new DocumentFragment();
  frag.createEl("span", { text: `Note saved to ${path}  ` });
  const undoBtn = frag.createEl("button", { text: "Undo" });
  undoBtn.addEventListener("click", async () => {
    try {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) {
        await app.vault.trash(file, false);
        new Notice(`Undo: ${path} moved to trash.`);
      } else {
        new Notice(`Undo: ${path} no longer exists.`);
      }
    } catch (err) {
      new Notice(`Undo failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  });
  new Notice(frag);
}

/** Show "Ingestion failed: <reason>" with a Details action. Calls onDetails when clicked. */
export function showIngestionFailedNotice(reason: string, onDetails: () => void): void {
  const frag = new DocumentFragment();
  frag.createEl("span", { text: `Ingestion failed: ${reason}  ` });
  const detailsBtn = frag.createEl("button", { text: "Details" });
  detailsBtn.addEventListener("click", () => onDetails());
  new Notice(frag);
}

/** Show "Ollama not running — start it?" with a Start action. */
export function showOllamaDownNotice(onStart: () => void): void {
  const frag = new DocumentFragment();
  frag.createEl("span", { text: "Ollama not running — start it?  " });
  const startBtn = frag.createEl("button", { text: "Start" });
  startBtn.addEventListener("click", () => onStart());
  new Notice(frag);
}

/** Show "Indexing paused automatically (low battery)" with a Resume action. */
export function showBatteryPauseNotice(onResume: () => void): void {
  const frag = new DocumentFragment();
  frag.createEl("span", { text: "Indexing paused automatically (low battery)  " });
  const resumeBtn = frag.createEl("button", { text: "Resume" });
  resumeBtn.addEventListener("click", () => onResume());
  new Notice(frag);
}
