import { Plugin, WorkspaceLeaf } from "obsidian";
import { GemmeraChatView, VIEW_TYPE } from "./view";
import { createServices, Services } from "./services";
import { DEFAULT_SETTINGS, GemmeraSettings } from "./settings";

export default class GemmeraPlugin extends Plugin {
  private services!: Services;
  settings!: GemmeraSettings;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.services = await createServices(this.app, this.settings);
    this.services.eventBridge.start();
    this.services.ingestionRunner.start();
    this.services.embeddingService.start();
    this.wireDebugLogs();
    // Fire reconcile in the background — hash gate keeps it cheap on warm reloads.
    this.services.reconciler
      .reconcile()
      .catch((err) => console.error("[gemmera] reconcile failed", err));

    this.registerView(VIEW_TYPE, (leaf) => new GemmeraChatView(leaf, this.services));

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
}
