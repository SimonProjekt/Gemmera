import { Menu, Plugin } from "obsidian";
import { readFileSync, existsSync } from "fs";
import { GemmeraChatView, VIEW_TYPE } from "./view";
import { createServices, Services } from "./services";
import { DEFAULT_SETTINGS, GemmeraSettings, GemmeraSettingTab } from "./settings";
import { GemmeraStatusBar } from "./statusbar";
import { showIngestionFailedNotice, showBatteryPauseNotice } from "./notices";

export default class GemmeraPlugin extends Plugin {
  private services!: Services;
  private statusBar!: GemmeraStatusBar;
  private batteryTimer: ReturnType<typeof setInterval> | null = null;
  private batteryPaused = false;
  settings!: GemmeraSettings;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.services = await createServices(this.app, this.settings);
    this.services.eventBridge.start();
    this.services.ingestionRunner.start();
    this.services.embeddingService.start();
    this.wireDebugLogs();

    this.statusBar = new GemmeraStatusBar(this, this.services, () => this.openChatView());
    this.services.llm.isReachable().then((r) => this.statusBar.setHealth(r)).catch(() => {});

    // Fire reconcile in the background — hash gate keeps it cheap on warm reloads.
    this.services.reconciler
      .reconcile()
      .then(({ enqueuedIndex }) => this.statusBar.setIndexingTotal(enqueuedIndex))
      .catch((err) => console.error("[gemmera] reconcile failed", err));

    this.registerView(VIEW_TYPE, (leaf) => new GemmeraChatView(leaf, this.services, this.statusBar, this.settings));

    const ribbonEl = this.addRibbonIcon("message-square", "Gemmera", () => {
      this.openChatView();
    });
    ribbonEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      new Menu()
        .addItem((item) =>
          item.setTitle("Open in sidebar").setIcon("sidebar-right").onClick(() => this.openChatView()),
        )
        .addItem((item) =>
          item.setTitle("Open in tab").setIcon("file").onClick(() => this.openChatTab()),
        )
        .addItem((item) =>
          item.setTitle("Open in new window").setIcon("popup-open").onClick(() => this.openChatWindow()),
        )
        .addSeparator()
        .addItem((item) =>
          item.setTitle("Settings").setIcon("settings").onClick(() => this.openSettings()),
        )
        .showAtMouseEvent(e);
    });

    this.addCommand({
      id: "open-chat",
      name: "Öppna chatt",
      callback: () => this.openChatView(),
    });

    this.addSettingTab(new GemmeraSettingTab(this.app, this));

    this.startBatteryMonitor();
  }

  async onunload(): Promise<void> {
    this.stopBatteryMonitor();
    this.statusBar?.destroy();
    this.services?.eventBridge.stop();
    if (this.services) {
      await this.services.ingestionRunner.stop();
      await this.services.embeddingService.stop();
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  private wireDebugLogs(): void {
    this.services.ingestionRunner.onResult((e) => {
      if (e.kind === "error") {
        console.error("[gemmera] runner error", e.job, e.error);
        const reason = e.error instanceof Error ? e.error.message : String(e.error);
        showIngestionFailedNotice(reason, () => this.openChatView());
        return;
      }
      if (e.kind === "decision") {
        console.debug(
          `[gemmera] ${e.decision.kind} ${e.job.kind === "rename" ? `${e.job.from}→${e.job.to}` : e.job.path}`,
        );
        return;
      }
      console.debug(`[gemmera] ${e.kind}`, e);
    });
    this.services.embeddingService.onEvent((e) => {
      if (e.kind === "error") {
        console.error("[gemmera] embed error", e);
        return;
      }
      console.debug(`[gemmera] embed:${e.kind} ${e.path} (${e.count})`);
    });
  }

  private async openChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async openChatTab(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async openChatWindow(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("window");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private openSettings(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.app as any).setting.open();
  }

  private startBatteryMonitor(): void {
    const BAT_PATH = "/sys/class/power_supply/BAT0";
    if (!existsSync(BAT_PATH)) return;

    this.batteryTimer = setInterval(() => {
      try {
        const capRaw = readFileSync(`${BAT_PATH}/capacity`, "utf-8").trim();
        const capacity = parseInt(capRaw, 10);
        const status = readFileSync(`${BAT_PATH}/status`, "utf-8").trim();

        if (status === "Discharging" && capacity < 20 && !this.batteryPaused) {
          this.batteryPaused = true;
          this.services.ingestionRunner.stop();
          showBatteryPauseNotice(() => {
            // Resume cannot be stopped — force start anyway
            this.batteryPaused = false;
            this.services.ingestionRunner.start();
          });
        } else if (status !== "Discharging" && this.batteryPaused) {
          this.batteryPaused = false;
          this.services.ingestionRunner.start();
        }
      } catch {
        // Battery info unavailable — ignore
      }
    }, 60_000);
  }

  private stopBatteryMonitor(): void {
    if (this.batteryTimer !== null) {
      clearInterval(this.batteryTimer);
      this.batteryTimer = null;
    }
  }
}
