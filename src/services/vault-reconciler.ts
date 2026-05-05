import type {
  IngestionStore,
  JobQueue,
  PathFilter,
  Reconciler,
  VaultService,
} from "../contracts";

/**
 * Cold-start reconciliation. Compares the live vault to what the store knows
 * and enqueues catch-up jobs:
 *
 *   - Every indexable vault file → enqueue an `index` job. The hash gate in
 *     the ingestion pipeline (#5) makes the warm path nearly free.
 *   - Every store entry whose path is no longer indexable (deleted, moved
 *     out of scope, or newly user-ignored) → enqueue a `delete` job.
 */
export class VaultReconciler implements Reconciler {
  constructor(
    private readonly vault: VaultService,
    private readonly store: IngestionStore,
    private readonly queue: JobQueue,
    private readonly filter: PathFilter,
  ) {}

  async reconcile(): Promise<{ enqueuedIndex: number; enqueuedDelete: number }> {
    const indexable = (await this.vault.listMarkdownFiles())
      .map((f) => f.path)
      .filter((p) => this.filter.shouldIndex(p));
    const indexableSet = new Set(indexable);

    let enqueuedIndex = 0;
    for (const path of indexable) {
      this.queue.enqueue({ kind: "index", path });
      enqueuedIndex++;
    }

    let enqueuedDelete = 0;
    const known = await this.store.list();
    for (const path of known) {
      if (!indexableSet.has(path)) {
        this.queue.enqueue({ kind: "delete", path });
        enqueuedDelete++;
      }
    }

    return { enqueuedIndex, enqueuedDelete };
  }
}
