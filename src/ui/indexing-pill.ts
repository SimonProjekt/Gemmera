import type { RunnerStatus, RunnerStatusSnapshot } from "../services/runner-status";
import { formatPill } from "./pill-format";

/**
 * Chat-header pill showing indexing progress (#15b). Subscribes to
 * RunnerStatus and re-renders on every snapshot. Auto-hides on idle and
 * for tiny vaults to avoid flicker.
 *
 * The pill is mounted by the chat view (`view.ts`) and unmounted on close.
 */
export class IndexingPill {
  private el: HTMLElement | null = null;
  private off: (() => void) | null = null;
  private onPauseToggle: (() => void) | null = null;

  constructor(private readonly status: RunnerStatus) {}

  mount(parent: HTMLElement, onPauseToggle?: () => void): void {
    if (this.el) return;
    this.onPauseToggle = onPauseToggle ?? null;
    const pill = parent.createEl("div", { cls: "gemmera-indexing-pill" });
    pill.style.display = "none";
    this.el = pill;
    this.off = this.status.subscribe((snap) => this.render(snap));
  }

  unmount(): void {
    this.off?.();
    this.off = null;
    this.el?.remove();
    this.el = null;
  }

  private render(snap: RunnerStatusSnapshot): void {
    if (!this.el) return;
    const view = formatPill(snap);
    if (!view.visible) {
      this.el.style.display = "none";
      return;
    }
    this.el.style.display = "";
    this.el.empty();
    this.el.removeClass("gemmera-indexing-pill--running");
    this.el.removeClass("gemmera-indexing-pill--paused");
    this.el.addClass(`gemmera-indexing-pill--${view.variant}`);

    this.el.createEl("span", {
      cls: "gemmera-indexing-pill__text",
      text: view.text,
    });

    if (this.onPauseToggle) {
      const btn = this.el.createEl("button", {
        cls: "gemmera-indexing-pill__btn",
        text: snap.phase === "paused" ? "Resume" : "Pause",
      });
      btn.addEventListener("click", () => this.onPauseToggle?.());
    }
  }
}
