import { Notice, PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { DriftReport, IngestionStore } from "../contracts";
import type { RunnerControls } from "../services/runner-controls";
import type { ScheduledReconciler } from "../services/scheduled-reconciler";

/**
 * Plugin settings UI (#15f). Exposes the indexer controls built in #15c–e:
 * pause toggle, rebuild button (with confirm), reconcile button, last-run
 * timestamps, and the most recent drift report.
 *
 * Re-renders on `display()` — Obsidian calls this when the user opens the
 * settings tab, which is enough freshness for an ops surface.
 */
export class GemmeraSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly controls: RunnerControls,
    private readonly scheduled: ScheduledReconciler,
    private readonly store: IngestionStore,
  ) {
    super(app, plugin);
  }

  async display(): Promise<void> {
    const { containerEl } = this as unknown as { containerEl: HTMLElement };
    containerEl.empty();
    containerEl.createEl("h2", { text: "Gemmera — Indexer" });

    const paused = this.controls.isPaused();
    const lastReconciled = (await this.store.getMeta("lastReconciledAt")) ?? 0;
    const lastRebuilt = (await this.store.getMeta("lastRebuiltAt")) ?? 0;
    const drift = (await this.store.getMeta("lastDriftReport")) as
      | DriftReport
      | null;

    new Setting(containerEl)
      .setName("Pause indexer")
      .setDesc(
        "When paused, no notes are chunked, embedded, or indexed. Pause survives plugin reloads.",
      )
      .addToggle((toggle: { setValue: (v: boolean) => unknown; onChange: (cb: (v: boolean) => void) => unknown }) => {
        toggle.setValue(paused);
        toggle.onChange(async (value: boolean) => {
          if (value) await this.controls.pause();
          else await this.controls.resume();
          new Notice(value ? "Gemmera: indexer paused" : "Gemmera: indexer resumed");
        });
      });

    new Setting(containerEl)
      .setName("Rebuild index")
      .setDesc(
        "Re-process every note. Idempotent and resumable — safe to interrupt. Disabled while paused.",
      )
      .addButton((btn: { setButtonText: (t: string) => unknown; setDisabled: (d: boolean) => unknown; onClick: (cb: () => void) => unknown }) => {
        btn.setButtonText("Rebuild");
        btn.setDisabled(paused);
        btn.onClick(async () => {
          const ok = window.confirm(
            "Rebuild the index for every note? This is safe and resumable but may take a while.",
          );
          if (!ok) return;
          const { enqueued } = await this.controls.rebuild();
          new Notice(`Gemmera: rebuild queued ${enqueued} note(s)`);
          await this.display();
        });
      });

    new Setting(containerEl)
      .setName("Reconcile now")
      .setDesc("Walk the vault, hash every file, and report drift against the index.")
      .addButton((btn: { setButtonText: (t: string) => unknown; onClick: (cb: () => void) => unknown }) => {
        btn.setButtonText("Reconcile");
        btn.onClick(async () => {
          const report = await this.scheduled.runNow();
          new Notice(
            `Gemmera: drift — ${report.added.length} added, ${report.removed.length} removed, ${report.hashChanged.length} changed`,
          );
          await this.display();
        });
      });

    containerEl.createEl("h3", { text: "Status" });
    const statusList = containerEl.createEl("ul");
    statusList.createEl("li", {
      text: `Last reconciled: ${formatTimestamp(lastReconciled)}`,
    });
    statusList.createEl("li", {
      text: `Last rebuilt: ${formatTimestamp(lastRebuilt)}`,
    });

    if (drift) {
      containerEl.createEl("h3", { text: "Last drift report" });
      const driftList = containerEl.createEl("ul");
      driftList.createEl("li", { text: `Ran at: ${formatTimestamp(drift.ranAt)}` });
      driftList.createEl("li", { text: `Added: ${drift.added.length}` });
      driftList.createEl("li", { text: `Removed: ${drift.removed.length}` });
      driftList.createEl("li", { text: `Hash changed: ${drift.hashChanged.length}` });
    }
  }
}

function formatTimestamp(ts: number): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}
