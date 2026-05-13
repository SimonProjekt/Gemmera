import { App, HoverParent, HoverPopover, TFile } from "obsidian";

export interface CitationChip {
  path: string;
  needsReview: boolean;
}

/**
 * Renders a row of citation chips beneath an assistant answer.
 *
 * - Hover triggers Obsidian's native preview (via HoverParent protocol).
 * - Click opens the note; modifier-click splits (Obsidian default behavior
 *   when we call app.workspace.openLinkText).
 * - Tab/Shift+Tab cycles focus left-to-right across chips.
 * - "Needs review" chips get a warning color and accessible label.
 */
export class CitationChipRow implements HoverParent {
  hoverPopover: HoverPopover | null = null;

  private el: HTMLElement;
  private chips: CitationChip[];
  private app: App;
  private focusedIndex = 0;

  constructor(
    app: App,
    parent: HTMLElement,
    citations: string[],
    needsReview = new Set<string>(),
  ) {
    this.app = app;
    this.chips = citations.map((path) => ({
      path,
      needsReview: needsReview.has(path),
    }));
    this.el = parent.createEl("div", { cls: "gemmera-citation-row" });
    this.render();
  }

  private render(): void {
    this.el.empty();
    this.chips.forEach((chip, i) => {
      const el = this.el.createEl("button", {
        cls: `gemmera-citation-chip${chip.needsReview ? " gemmera-citation-chip--needs-review" : ""}`,
        attr: {
          tabindex: i === 0 ? "0" : "-1",
          "aria-label": chip.needsReview
            ? `${chip.path} — needs review`
            : chip.path,
        },
      });
      el.createEl("span", { cls: "gemmera-citation-chip__icon", text: "[[" });
      el.createEl("span", { cls: "gemmera-citation-chip__path", text: basename(chip.path) });
      el.createEl("span", { cls: "gemmera-citation-chip__icon", text: "]]" });
      if (chip.needsReview) {
        el.createEl("span", { cls: "gemmera-citation-chip__warning", text: "!" });
      }

      el.addEventListener("click", (e) => this.openChip(chip.path, e));
      el.addEventListener("keydown", (e) => this.handleKey(e, i));

      // HoverParent: Obsidian's hover preview works when the element has
      // `data-href` and the parent implements HoverParent.
      el.setAttribute("data-href", chip.path);
      el.setAttribute("data-href-type", "file");
    });
  }

  private openChip(path: string, event: MouseEvent): void {
    const file = this.app.metadataCache.getFirstLinkpathDest(path, "");
    if (!file) return;
    const leaf = this.app.workspace.getLeaf(event.ctrlKey || event.metaKey ? "split" : false);
    leaf.openFile(file).catch(() => {});
  }

  private handleKey(event: KeyboardEvent, index: number): void {
    if (event.key === "Tab") {
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      this.focusedIndex = (this.focusedIndex + direction + this.chips.length) % this.chips.length;
      const buttons = this.el.querySelectorAll<HTMLButtonElement>(".gemmera-citation-chip");
      buttons.forEach((btn, i) => {
        btn.tabIndex = i === this.focusedIndex ? 0 : -1;
        if (i === this.focusedIndex) btn.focus();
      });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chip = this.chips[index];
      this.openChip(chip.path, new MouseEvent("click"));
    }
  }

  /** Remove the chip row from the DOM. */
  remove(): void {
    this.el.remove();
  }
}

function basename(path: string): string {
  const parts = path.split("/");
  const last = parts[parts.length - 1];
  return last.replace(/\.md$/, "");
}
