import { Modal, type App } from "obsidian";
import type { InspectorEntry } from "../services/turn-status";

/**
 * Developer-facing modal that shows every state entered during a turn (#66).
 *
 * Open it via `openTurnInspector(app, entries)` after a turn completes.
 * Only surface this in dev mode — production users should not see raw state
 * names and timestamps.
 */
export function openTurnInspector(app: App, entries: InspectorEntry[]): void {
  const modal = new TurnInspectorModal(app, entries);
  modal.open();
}

class TurnInspectorModal extends Modal {
  constructor(
    app: App,
    private readonly entries: InspectorEntry[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Turn Inspector" });

    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: "No state entries recorded for this turn." });
      return;
    }

    const table = contentEl.createEl("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.fontSize = "12px";

    const head = table.createEl("thead");
    const headRow = head.createEl("tr");
    for (const col of ["State", "Label", "From", "Time", "Payload"]) {
      const th = headRow.createEl("th", { text: col });
      th.style.textAlign = "left";
      th.style.padding = "4px 8px";
      th.style.borderBottom = "1px solid var(--background-modifier-border)";
    }

    const body = table.createEl("tbody");
    for (const entry of this.entries) {
      const row = body.createEl("tr");
      row.style.verticalAlign = "top";

      const cells = [
        entry.state,
        entry.label,
        entry.fromState ?? "—",
        entry.time.replace("T", " ").replace("Z", ""),
        entry.payloadPreview ?? "",
      ];
      for (const text of cells) {
        const td = row.createEl("td", { text });
        td.style.padding = "4px 8px";
        td.style.borderBottom = "1px solid var(--background-modifier-border)";
        td.style.fontFamily = "var(--font-monospace)";
        td.style.whiteSpace = "pre-wrap";
        td.style.wordBreak = "break-all";
      }
    }

    const closeBtn = contentEl.createEl("button", { text: "Close" });
    closeBtn.style.marginTop = "12px";
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
