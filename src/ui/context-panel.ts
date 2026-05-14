import type { RetrievalHit, WinningSignal } from "../contracts";

/**
 * One entry in the idle-state "recent captures" list. The view appends
 * to this list after every successful ingest turn (#42 acceptance:
 * "Recent captures pull from the chat history store").
 */
export interface RecentCapture {
  title: string;
  path: string;
  timestamp: number;
}

export type ContextPanelState =
  | { kind: "idle"; recentCaptures: RecentCapture[] }
  | { kind: "query"; query: string; hits: RetrievalHit[]; status?: string }
  | { kind: "ingestion"; status: string };

/**
 * Right-side context panel content controller (#42).
 *
 * Owns a single root <div> and re-renders its body whenever `setState`
 * is called. The outer `gemmera-context-panel` container — which is
 * hidden via CSS `@container` query in narrow mode (#40) — is managed
 * by the view; this class only owns its own subtree.
 *
 * Why a class with a fixed root rather than a free function: the view
 * mounts the history drawer as a sibling inside the same panel, so we
 * need a stable child element we can `replaceChildren` on instead of
 * blowing away the whole panel each turn.
 */
export class ContextPanel {
  private state: ContextPanelState = { kind: "idle", recentCaptures: [] };

  constructor(private readonly root: HTMLElement) {
    this.root.addClass("gemmera-context-content");
    this.render();
  }

  /** Replace the panel state and re-render. */
  setState(state: ContextPanelState): void {
    this.state = state;
    this.render();
  }

  /** Convenience: switch to idle with the supplied captures. */
  setIdle(recentCaptures: RecentCapture[]): void {
    this.setState({ kind: "idle", recentCaptures });
  }

  /** Convenience: switch to query with no hits yet (status only). */
  setQueryPending(query: string, status: string): void {
    this.setState({ kind: "query", query, hits: [], status });
  }

  /** Update the hits inside a query state. No-op if not in query mode. */
  setQueryHits(hits: RetrievalHit[]): void {
    if (this.state.kind !== "query") return;
    this.setState({ kind: "query", query: this.state.query, hits });
  }

  setIngestion(status: string): void {
    this.setState({ kind: "ingestion", status });
  }

  /** Exposed for tests so they can assert against the rendered tree. */
  get currentState(): ContextPanelState { return this.state; }

  private render(): void {
    this.root.empty();
    switch (this.state.kind) {
      case "idle":
        renderIdle(this.root, this.state.recentCaptures);
        return;
      case "query":
        renderQuery(this.root, this.state.query, this.state.hits, this.state.status);
        return;
      case "ingestion":
        renderIngestion(this.root, this.state.status);
        return;
    }
  }
}

function renderIdle(root: HTMLElement, captures: RecentCapture[]): void {
  root.addClass("gemmera-context-content--idle");
  root.removeClass("gemmera-context-content--query", "gemmera-context-content--ingestion");

  root.createEl("h4", { cls: "gemmera-context__title", text: "Recent captures" });

  if (captures.length === 0) {
    root.createEl("p", {
      cls: "gemmera-context__empty",
      text: "No captures yet. Send a note from the composer.",
    });
    return;
  }

  const list = root.createEl("ul", { cls: "gemmera-context__list" });
  for (const c of captures) {
    const item = list.createEl("li", { cls: "gemmera-context__item" });
    item.createEl("span", { cls: "gemmera-context__item-title", text: c.title });
    item.createEl("span", { cls: "gemmera-context__item-meta", text: c.path });
  }
}

function renderQuery(
  root: HTMLElement,
  query: string,
  hits: RetrievalHit[],
  status: string | undefined,
): void {
  root.addClass("gemmera-context-content--query");
  root.removeClass("gemmera-context-content--idle", "gemmera-context-content--ingestion");

  root.createEl("h4", { cls: "gemmera-context__title", text: "Retrieved sources" });
  root.createEl("p", { cls: "gemmera-context__query", text: `“${query}”` });

  if (hits.length === 0) {
    root.createEl("p", {
      cls: "gemmera-context__empty",
      text: status ?? "Searching…",
    });
    return;
  }

  for (const hit of hits) {
    const card = root.createEl("div", { cls: "gemmera-context__chunk" });
    const head = card.createEl("div", { cls: "gemmera-context__chunk-head" });
    head.createEl("span", { cls: "gemmera-context__chunk-title", text: hit.title });
    head.createEl("span", {
      cls: `gemmera-context__chunk-why gemmera-context__chunk-why--${hit.winningSignal}`,
      text: whyLabel(hit.winningSignal),
    });
    head.createEl("span", {
      cls: "gemmera-context__chunk-score",
      text: hit.score.toFixed(2),
    });
    if (hit.headingPath.length > 0) {
      card.createEl("div", {
        cls: "gemmera-context__chunk-path",
        text: hit.headingPath.join(" › "),
      });
    }
    card.createEl("p", {
      cls: "gemmera-context__chunk-text",
      text: snippet(hit.text),
    });
  }
}

function renderIngestion(root: HTMLElement, status: string): void {
  root.addClass("gemmera-context-content--ingestion");
  root.removeClass("gemmera-context-content--idle", "gemmera-context-content--query");

  root.createEl("h4", { cls: "gemmera-context__title", text: "Ingesting" });
  root.createEl("p", { cls: "gemmera-context__status", text: status });
}

export function whyLabel(signal: WinningSignal): string {
  switch (signal) {
    case "semantic": return "semantic";
    case "lexical": return "keyword";
    case "backlink": return "linked";
    case "tag": return "tag";
    case "recency": return "recent";
  }
}

export const MAX_SNIPPET_CHARS = 220;
export function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SNIPPET_CHARS ? flat.slice(0, MAX_SNIPPET_CHARS) + "…" : flat;
}
