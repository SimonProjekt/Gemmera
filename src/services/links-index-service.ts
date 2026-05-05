import type { MutableLinksIndex, VaultService } from "../contracts";
import type { IngestionRunner, RunnerEvent } from "./ingestion-runner";
import { parseLinks } from "./in-memory-links-index";

export type LinksIndexEvent =
  | { kind: "indexed"; path: string; linkCount: number }
  | { kind: "removed"; path: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "skipped"; path: string }
  | { kind: "error"; path: string | null; error: unknown };

/**
 * Bridges runner decisions to the LinksIndex.
 *
 * Subscribes to `IngestionRunner.onResult` and keeps the index in sync:
 *  - `rechunk` decisions: re-read the body, parse links, upsert.
 *  - `metadata-only` and `skip` decisions: no-op (frontmatter and unchanged
 *    content cannot have changed body links).
 *  - `deleted`: remove the path.
 *  - `renamed`: rewrite resolved targets via `index.rename`.
 *
 * All work is serialized through a single `inFlight` promise so the index
 * sees mutations in event order — same pattern as `EmbeddingService`.
 *
 * Re-reading the body (rather than reusing the chunked text) is intentional:
 * the chunker only emits chunk text, and inline-code spans + fenced blocks
 * are stripped from `textForEmbed`, so chunk text is not a faithful source
 * for link extraction. The cost is one extra `vault.read` per `rechunk`.
 */
export class LinksIndexService {
  private unsubscribe: (() => void) | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private listeners = new Set<(e: LinksIndexEvent) => void>();

  constructor(
    private readonly runner: Pick<IngestionRunner, "onResult">,
    private readonly vault: Pick<VaultService, "read">,
    private readonly index: MutableLinksIndex,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.runner.onResult((event) => this.schedule(event));
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await this.inFlight;
  }

  onEvent(cb: (e: LinksIndexEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Wait for any pending work to finish. Test/cold-start affordance. */
  flush(): Promise<void> {
    return this.inFlight;
  }

  private schedule(event: RunnerEvent): void {
    const next = this.inFlight.then(() => this.process(event));
    this.inFlight = next.catch(() => undefined);
  }

  private async process(event: RunnerEvent): Promise<void> {
    try {
      if (event.kind === "deleted") {
        this.index.remove(event.path);
        this.emit({ kind: "removed", path: event.path });
        return;
      }
      if (event.kind === "renamed") {
        this.index.rename(event.from, event.to);
        this.emit({ kind: "renamed", from: event.from, to: event.to });
        return;
      }
      if (event.kind === "error") {
        // The runner already reported it. Don't double-emit.
        return;
      }
      // decision
      const { decision, job } = event;
      const path = job.kind === "rename" ? job.to : job.path;
      if (decision.kind !== "rechunk") {
        this.emit({ kind: "skipped", path });
        return;
      }
      const content = await this.vault.read(decision.state.path);
      const links = parseLinks(content);
      this.index.upsert(decision.state.path, links);
      this.emit({ kind: "indexed", path: decision.state.path, linkCount: links.length });
    } catch (error) {
      const path = pathOf(event);
      this.emit({ kind: "error", path, error });
    }
  }

  private emit(event: LinksIndexEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // listener errors must not break the loop
      }
    }
  }
}

function pathOf(event: RunnerEvent): string | null {
  if (event.kind === "decision") return event.job.kind === "rename" ? event.job.to : event.job.path;
  if (event.kind === "deleted") return event.path;
  if (event.kind === "renamed") return event.to;
  return null;
}
