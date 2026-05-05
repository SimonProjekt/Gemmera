import { Plugin, WorkspaceLeaf } from "obsidian";
import { GemmeraChatView, VIEW_TYPE } from "./view";
import { createServices, Services } from "./services";

export default class GemmeraPlugin extends Plugin {
  private services!: Services;

  async onload(): Promise<void> {
    this.services = createServices(this.app);
    this.services.eventBridge.start();
    this.services.ingestionRunner.start();
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
    if (this.services) await this.services.ingestionRunner.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
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
