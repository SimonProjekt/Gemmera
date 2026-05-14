import { Modal, type App } from "obsidian";
import type { EventLogEntry } from "../contracts/state-machine";
import { formatInspectorEntries, type InspectorEntry } from "../services/turn-status";

/**
 * Developer-facing modal that shows every state entered during a turn (#74).
 * Hidden behind the devMode setting — surface only via the registered command.
 */
export function openTurnInspector(app: App, rawEntries: readonly EventLogEntry[]): void {
  new TurnInspectorModal(app, rawEntries).open();
}

class TurnInspectorModal extends Modal {
  private readonly entries: InspectorEntry[];
  private readonly rawEntries: readonly EventLogEntry[];

  constructor(app: App, rawEntries: readonly EventLogEntry[]) {
    super(app);
    this.rawEntries = rawEntries;
    this.entries = formatInspectorEntries(rawEntries);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.style.maxWidth = "min(860px, 95vw)";

    contentEl.createEl("h2", { text: "Turn Inspector" });

    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: "No state entries found. The event log is cleared on plugin reload — send a message first." });
      this.addCloseButton(contentEl);
      return;
    }

    // ── State trace table ─────────────────────────────────────────────────
    const table = contentEl.createEl("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";
    table.style.fontSize = "12px";
    table.style.marginBottom = "12px";

    const head = table.createEl("thead");
    const headRow = head.createEl("tr");
    for (const col of ["State", "Label", "From", "Elapsed", "Payload"]) {
      const th = headRow.createEl("th", { text: col });
      th.style.textAlign = "left";
      th.style.padding = "4px 8px";
      th.style.borderBottom = "1px solid var(--background-modifier-border)";
      th.style.whiteSpace = "nowrap";
    }

    const body = table.createEl("tbody");
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const prev = this.entries[i - 1];
      const elapsedMs = prev ? e.timestamp - prev.timestamp : 0;
      const elapsedStr = i === 0 ? "—" : `${elapsedMs} ms`;

      const row = body.createEl("tr");
      row.style.verticalAlign = "top";

      const cells = [
        e.state,
        e.label,
        e.fromState ?? "—",
        elapsedStr,
        e.payloadPreview ?? "",
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

    // ── Action buttons ────────────────────────────────────────────────────
    const buttonRow = contentEl.createEl("div");
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";
    buttonRow.style.marginTop = "4px";

    const copyBtn = buttonRow.createEl("button", { text: "Copy JSON" });
    copyBtn.addEventListener("click", () => {
      const json = JSON.stringify(this.rawEntries, null, 2);
      navigator.clipboard.writeText(json).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy JSON"; }, 1500);
      }).catch(() => {
        copyBtn.textContent = "Copy failed";
        setTimeout(() => { copyBtn.textContent = "Copy JSON"; }, 1500);
      });
    });

    this.addCloseButton(buttonRow);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addCloseButton(parent: HTMLElement): void {
    const btn = parent.createEl("button", { text: "Close" });
    btn.addEventListener("click", () => this.close());
  }
}
