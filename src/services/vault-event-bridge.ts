import type {
  IndexJob,
  JobQueue,
  PathFilter,
  VaultEventSource,
} from "../contracts";

/**
 * Bridges raw vault events to the job queue, applying the path filter and
 * the rename special case. Events are translated to jobs only — the bridge
 * never touches the vault or runs work inline. (#4)
 */
export class VaultEventBridge {
  private unsubs: Array<() => void> = [];

  constructor(
    private readonly source: VaultEventSource,
    private readonly queue: JobQueue,
    private readonly filter: PathFilter,
  ) {}

  start(): void {
    if (this.unsubs.length > 0) return; // idempotent
    this.unsubs.push(this.source.onCreate((p) => this.handleIndex(p)));
    this.unsubs.push(this.source.onModify((p) => this.handleIndex(p)));
    this.unsubs.push(this.source.onMetadataChange((p) => this.handleIndex(p)));
    this.unsubs.push(this.source.onDelete((p) => this.handleDelete(p)));
    this.unsubs.push(this.source.onRename((from, to) => this.handleRename(from, to)));
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private handleIndex(path: string): void {
    if (!this.filter.shouldIndex(path)) return;
    this.enqueue({ kind: "index", path });
  }

  private handleDelete(path: string): void {
    // Always propagate deletes for .md files even if filter would now reject
    // (the file may have been indexed before user-ignore changed).
    if (!path.toLowerCase().endsWith(".md")) return;
    this.enqueue({ kind: "delete", path });
  }

  private handleRename(from: string, to: string): void {
    const fromIndexed = this.filter.shouldIndex(from);
    const toIndexed = this.filter.shouldIndex(to);
    if (!fromIndexed && !toIndexed) return;
    if (fromIndexed && !toIndexed) {
      this.enqueue({ kind: "delete", path: from });
      return;
    }
    if (!fromIndexed && toIndexed) {
      this.enqueue({ kind: "index", path: to });
      return;
    }
    this.enqueue({ kind: "rename", from, to });
  }

  private enqueue(job: IndexJob): void {
    this.queue.enqueue(job);
  }
}
