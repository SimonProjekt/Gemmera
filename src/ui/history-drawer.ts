import type { ChatHistoryStore, ChatSession } from "../services/chat-history";

function formatSessionMeta(updatedAt: number, turnCount: number): string {
  const date = new Date(updatedAt).toLocaleDateString("sv-SE", { month: "short", day: "numeric" });
  return `${date} · ${turnCount} meddelande${turnCount === 1 ? "" : "n"}`;
}

export class HistoryDrawer {
  private currentSessionId: string | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly store: ChatHistoryStore,
    private readonly onSelect: (session: ChatSession) => void,
    private readonly onNew: () => void,
  ) {}

  async render(currentSessionId: string | null): Promise<void> {
    this.currentSessionId = currentSessionId;
    const el = this.el;
    el.empty();

    const headEl = el.createEl("div", { cls: "gemmera-history__head" });
    headEl.createEl("span", { cls: "gemmera-history__title", text: "Chats" });
    const newBtn = headEl.createEl("button", {
      cls: "gemmera-history__new-btn",
      text: "+ Ny chatt",
      attr: { "aria-label": "Start a new chat" },
    });
    newBtn.addEventListener("click", () => this.onNew());

    const sessions = await this.store.listSessions();
    if (sessions.length === 0) {
      el.createEl("p", { cls: "gemmera-history__empty", text: "Inga sparade chattar." });
      return;
    }

    const listEl = el.createEl("ul", { cls: "gemmera-history__list" });
    for (const session of sessions) {
      const isActive = session.id === this.currentSessionId;
      const item = listEl.createEl("li", {
        cls: `gemmera-history__item${isActive ? " gemmera-history__item--active" : ""}`,
        attr: { tabindex: "0", role: "button", "aria-pressed": String(isActive) },
      });
      const titleEl = item.createEl("span", {
        cls: "gemmera-history__item-title",
        text: session.title,
        attr: { title: "Double-click to rename" },
      });
      const userTurns = session.turns.filter((t) => t.role === "user").length;
      item.createEl("span", { cls: "gemmera-history__item-meta", text: formatSessionMeta(session.updatedAt, userTurns) });

      item.addEventListener("click", () => this.onSelect(session));
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.onSelect(session);
        }
      });

      // Inline rename: double-click title → contenteditable, blur/Enter saves,
      // Escape reverts. Stops propagation so the item-level click handler
      // doesn't swap the session out from under the edit. #43.
      titleEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.beginInlineRename(titleEl, session.id, session.title);
      });
    }
  }

  private beginInlineRename(titleEl: HTMLElement, sessionId: string, original: string): void {
    titleEl.setAttribute("contenteditable", "true");
    titleEl.addClass("gemmera-history__item-title--editing");
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const commit = async () => {
      titleEl.removeAttribute("contenteditable");
      titleEl.removeClass("gemmera-history__item-title--editing");
      const next = (titleEl.textContent ?? "").trim();
      if (next.length === 0 || next === original) {
        titleEl.setText(original);
        return;
      }
      try {
        const updated = await this.store.renameSession(sessionId, next);
        if (updated) {
          titleEl.setText(updated.title);
          // Re-render so the meta line picks up the bumped updatedAt and the
          // renamed chat surfaces at the top.
          await this.render(this.currentSessionId);
        } else {
          titleEl.setText(original);
        }
      } catch (err) {
        console.error("[gemmera] renameSession:", err);
        titleEl.setText(original);
      }
    };

    const cancel = () => {
      titleEl.removeAttribute("contenteditable");
      titleEl.removeClass("gemmera-history__item-title--editing");
      titleEl.setText(original);
    };

    // Tie both listeners to one AbortController so commit/cancel guarantees
    // the keydown handler is removed too. Without this, dblclick → Escape →
    // dblclick on the same node would stack a second keydown handler since
    // the node isn't rebuilt until render runs. #152 review.
    const ac = new AbortController();
    titleEl.addEventListener("blur", () => { ac.abort(); void commit(); }, { once: true });
    titleEl.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          titleEl.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
          titleEl.blur();
        }
      },
      { signal: ac.signal },
    );
  }
}
