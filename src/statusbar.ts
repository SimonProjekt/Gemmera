import type { Plugin } from "obsidian";
import type { LLMReachability } from "./contracts";
import type { Services } from "./services";

type StateKey = "indexing" | "thinking" | "ingesting" | "idle-healthy" | "idle-unhealthy";

const LABELS: Record<StateKey, string> = {
  "indexing":       "Gemmera · Indexing…",
  "thinking":       "Gemmera · Thinking…",
  "ingesting":      "Gemmera · Ingesting…",
  "idle-healthy":   "Gemmera · ready",
  "idle-unhealthy": "Ollama not running",
};

const CSS: Record<StateKey, string> = {
  "indexing":       "gemmera-bar--busy",
  "thinking":       "gemmera-bar--busy",
  "ingesting":      "gemmera-bar--busy",
  "idle-healthy":   "gemmera-bar--ready",
  "idle-unhealthy": "gemmera-bar--error",
};

const ALL_STATE_CLASSES = ["gemmera-bar--busy", "gemmera-bar--ready", "gemmera-bar--error"];

export class GemmeraStatusBar {
  private readonly el: HTMLElement;
  private thinking = false;
  private ingesting = false;
  private indexing = false;
  private healthy = true;
  private indexTotal = 0;
  private indexDone = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(plugin: Plugin, services: Services, openChat: () => void) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass("gemmera-bar", "mod-clickable");
    this.el.addEventListener("click", openChat);
    this.wire(services);
    this.render();
  }

  private wire(services: Services): void {
    this.unsubs.push(
      services.jobQueue.onArrival(() => {
        this.ingesting = true;
        this.render();
      }),
    );

    this.unsubs.push(
      services.ingestionRunner.onResult((e) => {
        if (e.kind === "decision" && e.decision.kind === "rechunk") {
          this.indexing = true;
        }
        if (this.indexTotal > 0) {
          this.indexDone = Math.min(this.indexDone + 1, this.indexTotal);
        }
        if (services.jobQueue.size() === 0) {
          this.ingesting = false;
        }
        this.render();
      }),
    );

    this.unsubs.push(
      services.embeddingService.onEvent(() => {
        if (services.embeddingService.isIdle()) {
          this.indexing = false;
          this.indexTotal = 0;
          this.indexDone = 0;
        }
        this.render();
      }),
    );
  }

  setThinking(active: boolean): void {
    this.thinking = active;
    this.render();
  }

  setHealth(reachability: LLMReachability): void {
    this.healthy = reachability === "running";
    this.render();
  }

  /** Call with the total job count returned by reconciler.reconcile() to enable live progress. */
  setIndexingTotal(total: number): void {
    if (total <= 0) return;
    this.indexTotal = total;
    this.indexDone = 0;
    this.render();
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }

  private activeState(): StateKey {
    if (this.indexing) return "indexing";
    if (this.thinking) return "thinking";
    if (this.ingesting) return "ingesting";
    return this.healthy ? "idle-healthy" : "idle-unhealthy";
  }

  private render(): void {
    const s = this.activeState();
    for (const cls of ALL_STATE_CLASSES) this.el.removeClass(cls);
    this.el.addClass(CSS[s]);
    this.el.setText(s === "indexing" && this.indexTotal > 0
      ? `Gemmera · Indexing ${this.indexDone} / ${this.indexTotal}`
      : LABELS[s]);
  }
}
