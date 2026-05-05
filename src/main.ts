import { Plugin, WorkspaceLeaf } from "obsidian";
import { GemmeraChatView, VIEW_TYPE } from "./view";

export default class GemmeraPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new GemmeraChatView(leaf));

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
