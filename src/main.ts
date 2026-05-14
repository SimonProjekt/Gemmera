import { FileSystemAdapter, Menu, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { readFileSync, existsSync } from "fs";
import { GemmeraChatView, VIEW_TYPE } from "./view";
import { createServices, Services } from "./services";
import { OllamaLifecycle, type OllamaStatus } from "./services/ollama-lifecycle";
import { DEFAULT_SETTINGS, GemmeraSettings } from "./settings";
import { GemmeraSettingsTab } from "./ui/settings-tab";
import { showIngestionFailedNotice, showBatteryPauseNotice } from "./notices";

export default class GemmeraPlugin extends Plugin {
  private services!: Services;
  settings!: GemmeraSettings;
  private lifecycle!: OllamaLifecycle;
  private statusBarEl!: HTMLElement;
  private batteryTimer: ReturnType<typeof setInterval> | null = null;
  private batteryPaused = false;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText("Gemmera: detecting…");
    this.lifecycle = new OllamaLifecycle({
      ollamaCmd: this.settings.ollamaPathMode === "manual" && this.settings.ollamaPath
        ? this.settings.ollamaPath
        : "ollama",
      onStatusChange: (status: OllamaStatus) => {
        this.statusBarEl.setText(ollamaStatusLabel(status));
      },
      log: (line) => console.log(line),
    });
    this.statusBarEl.onClickEvent(() => {
      if (this.lifecycle.status === "not_responding") {
        this.lifecycle.restart().catch((err) => console.error("[gemmera] restart failed", err));
      }
    });
    // Start Ollama lifecycle in the background — chat is usable if Ollama was already running.
    this.lifecycle.start().catch((err) => console.error("[gemmera] lifecycle start failed", err));
    const pluginDir = (this.app.vault.adapter as FileSystemAdapter).getFullPath(this.manifest.dir ?? ".obsidian/plugins/gemmera");
    this.services = await createServices(this.app, this.settings, pluginDir);
    // Apply persisted pause flag BEFORE any service can claim work — otherwise
    // a vault event firing between subscribe and applyPersistedState could
    // process jobs the user expected to stay paused.
    await this.services.runnerControls.applyPersistedState();
    this.services.eventBridge.start();
    this.services.ingestionRunner.start();
    this.services.embeddingService.start();
    this.services.bm25IndexService.start();
    this.services.linksIndexService.start();
    this.services.runnerStatus.start();
    this.wireDebugLogs();
    // Fire reconcile in the background — hash gate keeps it cheap on warm reloads.
    this.services.reconciler
      .reconcile()
      .then(() => this.services.runnerStatus.recompute())
      .catch((err) => console.error("[gemmera] reconcile failed", err));
    // Schedule the weekly drift check (#15e). Runs immediately if overdue.
    this.services.scheduledReconciler
      .start()
      .catch((err) => console.error("[gemmera] scheduled reconcile failed", err));

    const settingsTab = new GemmeraSettingsTab(
      this.app,
      this,
      this.services.runnerControls,
      this.services.scheduledReconciler,
      this.services.ingestionStore,
      this.settings,
      () => this.saveData(this.settings),
      this.lifecycle,
    );
    // Pre-load the snapshot so the first paint of the tab is sync.
    void settingsTab.refresh();
    this.addSettingTab(settingsTab);

    this.registerView(
      VIEW_TYPE,
      (leaf) => new GemmeraChatView(leaf, this.services, this.settings),
    );

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

    this.addCommand({
      id: "capture-selection",
      name: "Gemmera: Fånga markering",
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "C" }],
      editorCallback: (editor) => {
        const text = editor.getSelection().trim();
        if (text) this.openChatWithText(text);
        else new Notice("Gemmera: Ingen text markerad.");
      },
    });

    this.addCommand({
      id: "capture-active-note",
      name: "Gemmera: Fånga aktiv anteckning",
      editorCallback: (editor) => {
        const text = editor.getValue().trim();
        if (text) this.openChatWithText(text);
      },
    });

    this.addCommand({
      id: "ask-about-active-note",
      name: "Gemmera: Fråga om aktiv anteckning",
      editorCallback: (editor, ctx) => {
        const noteName = ctx.file?.basename ?? "this note";
        this.openChatWithText(`Tell me about [[${noteName}]]`);
      },
    });

    // ── Editor context menu ──────────────────────────────────────────────
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, ctx) => {
        const selection = editor.getSelection().trim();
        if (selection) {
          menu.addItem((item) =>
            item
              .setTitle("Gemmera: Capture selection")
              .setIcon("sticky-note")
              .onClick(() => this.openChatWithText(selection)),
          );
          menu.addItem((item) =>
            item
              .setTitle("Gemmera: Ask about selection")
              .setIcon("search")
              .onClick(() => this.openChatWithText(`Tell me about this: ${selection}`)),
          );
        }
        const noteName = ctx.file?.basename;
        if (noteName) {
          menu.addItem((item) =>
            item
              .setTitle("Gemmera: Ask about note")
              .setIcon("file-question")
              .onClick(() => this.openChatWithText(`Tell me about [[${noteName}]]`)),
          );
        }
      }),
    );

    // ── File context menu (single file) ──────────────────────────────────
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.path.endsWith(".md")) {
          menu.addSeparator();
          menu.addItem((item) =>
            item
              .setTitle("Gemmera: Ask about this note")
              .setIcon("file-question")
              .onClick(() => this.openChatWithText(`Tell me about [[${file.basename}]]`)),
          );
          menu.addItem((item) =>
            item
              .setTitle("Gemmera: Reindex this note")
              .setIcon("refresh-cw")
              .onClick(() => this.reindexNote(file)),
          );
        }
      }),
    );

    // ── Files context menu (multi-file) ──────────────────────────────────
    this.registerEvent(
      this.app.workspace.on("files-menu", (menu, files) => {
        const mdFiles = files.filter((f) => f instanceof TFile && f.path.endsWith(".md")) as TFile[];
        if (mdFiles.length === 0) return;
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Gemmera: Ask across these notes")
            .setIcon("files")
            .onClick(() => {
              const links = mdFiles.map((f) => `[[${f.basename}]]`).join(", ");
              this.openChatWithText(`Tell me about these notes together: ${links}`);
            }),
        );
      }),
    );

    this.startBatteryMonitor();
  }

  async onunload(): Promise<void> {
    this.stopBatteryMonitor();
    await this.lifecycle?.stop();
    this.services?.eventBridge.stop();
    this.services?.runnerStatus.stop();
    this.services?.scheduledReconciler.stop();
    if (this.services) {
      await this.services.ingestionRunner.stop();
      await this.services.embeddingService.stop();
      await this.services.bm25IndexService.stop();
      await this.services.linksIndexService.stop();
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
    this.services.bm25IndexService.onEvent((e) => {
      if (e.kind === "error") {
        console.error("[gemmera] bm25 error", e);
        return;
      }
      const count = "count" in e ? e.count : 0;
      console.debug(`[gemmera] bm25:${e.kind} ${e.path} (${count})`);
    });
    this.services.linksIndexService.onEvent((e) => {
      if (e.kind === "error") {
        console.error("[gemmera] links error", e);
        return;
      }
      if (e.kind === "renamed") {
        console.debug(`[gemmera] links:renamed ${e.from}→${e.to}`);
        return;
      }
      const count = "linkCount" in e ? e.linkCount : 0;
      console.debug(`[gemmera] links:${e.kind} ${e.path} (${count})`);
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

  private async openChatWithText(text: string): Promise<void> {
    await this.openChatView();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const view = leaves[0]?.view as GemmeraChatView | undefined;
    view?.setComposerText(text);
  }

  private async reindexNote(file: TFile): Promise<void> {
    const path = file.path;
    const exists = await this.services.ingestionStore.get(path);
    if (exists) await this.services.ingestionStore.delete(path);
    this.services.jobQueue.enqueue({ kind: "index", path });
    new Notice(`Gemmera: Reindexing ${path}`);
  }

  private startBatteryMonitor(): void {
    const BAT_PATH = "/sys/class/power_supply/BAT0";
    if (!existsSync(BAT_PATH)) return;

    this.batteryTimer = setInterval(async () => {
      try {
        const capRaw = readFileSync(`${BAT_PATH}/capacity`, "utf-8").trim();
        const capacity = parseInt(capRaw, 10);
        const status = readFileSync(`${BAT_PATH}/status`, "utf-8").trim();

        if (status === "Discharging" && capacity < 20 && !this.batteryPaused) {
          this.batteryPaused = true;
          await this.services.runnerControls.pause();
          showBatteryPauseNotice(async () => {
            this.batteryPaused = false;
            await this.services.runnerControls.resume();
          });
        } else if (status !== "Discharging" && this.batteryPaused) {
          this.batteryPaused = false;
          await this.services.runnerControls.resume();
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

function ollamaStatusLabel(status: OllamaStatus): string {
  switch (status) {
    case "detecting":     return "Gemmera: detecting…";
    case "starting":      return "Gemmera: starting…";
    case "ready":         return "Gemmera: ready";
    case "not_responding": return "Gemmera: Ollama not responding — click to restart";
    case "restarting":    return "Gemmera: restarting…";
    case "not_installed": return "Gemmera: Ollama not found";
  }
}
