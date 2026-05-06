import { Notice, PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { DriftReport, IngestionStore } from "../contracts";
import type { RunnerControls } from "../services/runner-controls";
import type { ScheduledReconciler } from "../services/scheduled-reconciler";
import type { GemmeraSettings } from "../settings";

interface IndexerStateSnapshot {
  paused: boolean;
  lastReconciledAt: number;
  lastRebuiltAt: number;
  drift: DriftReport | null;
}

const EMPTY_SNAPSHOT: IndexerStateSnapshot = {
  paused: false,
  lastReconciledAt: 0,
  lastRebuiltAt: 0,
  drift: null,
};

/**
 * Plugin settings UI (#15f). Exposes the indexer controls built in #15c–e:
 * pause toggle, rebuild button (with confirm), reconcile button, last-run
 * timestamps, and the most recent drift report. Also exposes the ingest
 * settings (inboxFolder, dedupThreshold, alwaysPreview).
 *
 * Obsidian's `display()` is synchronous, so meta is loaded into a cached
 * snapshot first. `refresh()` reloads then re-renders; the UI calls it
 * after any action that mutates persisted state.
 */
export class GemmeraSettingsTab extends PluginSettingTab {
  private snapshot: IndexerStateSnapshot = EMPTY_SNAPSHOT;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly controls: RunnerControls,
    private readonly scheduled: ScheduledReconciler,
    private readonly store: IngestionStore,
    private readonly settings: GemmeraSettings,
    private readonly saveSettings: () => Promise<void>,
  ) {
    super(app, plugin);
  }

  async refresh(): Promise<void> {
    this.snapshot = {
      paused: this.controls.isPaused(),
      lastReconciledAt: (await this.store.getMeta("lastReconciledAt")) ?? 0,
      lastRebuiltAt: (await this.store.getMeta("lastRebuiltAt")) ?? 0,
      drift: (await this.store.getMeta("lastDriftReport")) ?? null,
    };
    this.display();
  }

  display(): void {
    const { containerEl } = this as unknown as { containerEl: HTMLElement };
    containerEl.empty();
    containerEl.createEl("h2", { text: "Gemmera — Indexer" });

    const { paused, lastReconciled, lastRebuilt, drift } = {
      paused: this.snapshot.paused,
      lastReconciled: this.snapshot.lastReconciledAt,
      lastRebuilt: this.snapshot.lastRebuiltAt,
      drift: this.snapshot.drift,
    };

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
          await this.refresh();
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
          await this.refresh();
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
          await this.refresh();
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

    containerEl.createEl("h2", { text: "Gemmera — Capture" });

    new Setting(containerEl)
      .setName("Inbox folder")
      .setDesc("Folder where new notes from the chat capture go. Trailing slash optional.")
      .addText((text: { setValue: (v: string) => unknown; onChange: (cb: (v: string) => void) => unknown; setPlaceholder?: (s: string) => unknown }) => {
        text.setPlaceholder?.("Inbox/");
        text.setValue(this.settings.inboxFolder);
        text.onChange(async (value: string) => {
          this.settings.inboxFolder = value || "Inbox/";
          await this.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Dedup threshold")
      .setDesc(
        "Cosine score above which a similar note is treated as a near-duplicate (0–1). Default 0.85.",
      )
      .addText((text: { setValue: (v: string) => unknown; onChange: (cb: (v: string) => void) => unknown; setPlaceholder?: (s: string) => unknown }) => {
        text.setPlaceholder?.("0.85");
        text.setValue(String(this.settings.dedupThreshold));
        text.onChange(async (value: string) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return;
          this.settings.dedupThreshold = parsed;
          await this.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Always preview before save")
      .setDesc(
        "When off, high-confidence creates skip the preview modal. Append and dedup-ask always preview.",
      )
      .addToggle((toggle: { setValue: (v: boolean) => unknown; onChange: (cb: (v: boolean) => void) => unknown }) => {
        toggle.setValue(this.settings.alwaysPreview);
        toggle.onChange(async (value: boolean) => {
          this.settings.alwaysPreview = value;
          await this.saveSettings();
        });
      });
  }
}

function formatTimestamp(ts: number): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}
