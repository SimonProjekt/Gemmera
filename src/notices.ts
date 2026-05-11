import { App, Notice } from "obsidian";

/** Show "Note saved to <path>" with an Undo action that trashes the file. */
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

/** Show "Ingestion failed: <reason>" with a Details action that opens the chat view. */
export function showIngestionFailedNotice(reason: string, onDetails: () => void): void {
  const frag = new DocumentFragment();
  frag.createEl("span", { text: `Ingestion failed: ${reason}  ` });
  const detailsBtn = frag.createEl("button", { text: "Details" });
  detailsBtn.addEventListener("click", () => onDetails());
  new Notice(frag);
}

/** Show "Indexing paused (low battery)" with a Resume action. */
export function showBatteryPauseNotice(onResume: () => void): void {
  const frag = new DocumentFragment();
  frag.createEl("span", { text: "Indexing paused automatically (low battery)  " });
  const resumeBtn = frag.createEl("button", { text: "Resume" });
  resumeBtn.addEventListener("click", () => onResume());
  new Notice(frag);
}
