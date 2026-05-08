import { FileSystemAdapter, Plugin, WorkspaceLeaf } from "obsidian";
import { GemmeraChatView, VIEW_TYPE } from "./view";
import { createServices, Services } from "./services";
import { OllamaLifecycle, type OllamaStatus } from "./services/ollama-lifecycle";
import { DEFAULT_SETTINGS, GemmeraSettings } from "./settings";
import { GemmeraSettingsTab } from "./ui/settings-tab";

export default class GemmeraPlugin extends Plugin {
  private services!: Services;
  settings!: GemmeraSettings;
  private lifecycle!: OllamaLifecycle;
  private statusBarEl!: HTMLElement;

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

    this.addRibbonIcon("message-square", "Gemmera", () => {
      this.openChatView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Öppna chatt",
      callback: () => this.openChatView(),
    });
  }

  async onunload(): Promise<void> {
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
