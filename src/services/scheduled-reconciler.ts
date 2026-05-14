import { createHash } from "node:crypto";
import type {
  DriftReport,
  IngestionStore,
  Reconciler,
  VaultService,
} from "../contracts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScheduledReconcilerDeps {
  vault: VaultService;
  store: IngestionStore;
  reconciler: Reconciler;
  /** Override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Override for tests. Defaults to `setTimeout`. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Wraps the existing one-shot Reconciler in a weekly schedule (#15e).
 *
 * - On `start()`, reads `meta.lastReconciledAt`. If overdue (>7d), runs
 *   immediately. Otherwise schedules a timer for the remaining delta.
 * - `runNow()` is the user-triggered "Reconcile now" path. It walks the
 *   vault, hashes every file, compares against `notes.contentHash`, and
 *   produces a `DriftReport` with adds/removes/changes. The hash gate in
 *   the pipeline already deduplicates the actual reprocessing; the report
 *   is purely diagnostic.
 *
 * The drift report is informational — divergence does not auto-enqueue
 * jobs (that would silently un-pause work). Surfacing the report to the
 * user is the settings panel's job.
 */
export class ScheduledReconciler {
  private timer: unknown = null;
  private now: () => number;
  private setTimer: (cb: () => void, ms: number) => unknown;
  private clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: ScheduledReconcilerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      deps.clearTimer ??
      ((handle) => {
        if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
  }

  async start(): Promise<void> {
    const last = (await this.deps.store.getMeta("lastReconciledAt")) ?? 0;
    const elapsed = this.now() - last;
    if (elapsed >= WEEK_MS) {
      await this.runNow();
      this.scheduleNext(WEEK_MS);
    } else {
      this.scheduleNext(WEEK_MS - elapsed);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run reconciliation now. Walks the vault, recomputes content hashes,
   * compares to the store, writes a `DriftReport`, and triggers a regular
   * `Reconciler.reconcile()` to enqueue catch-up jobs for genuine adds /
   * removes (the hash gate handles changes).
   */
  async runNow(): Promise<DriftReport> {
    const ranAt = this.now();
    const files = await this.deps.vault.listMarkdownFiles();
    const livePaths = new Set(files.map((f) => f.path));
    const knownPaths = new Set(await this.deps.store.list());

    const added: string[] = [];
    const removed: string[] = [];
    const hashChanged: string[] = [];

    for (const path of livePaths) {
      if (!knownPaths.has(path)) {
        added.push(path);
        continue;
      }
      const prior = await this.deps.store.get(path);
      if (!prior) continue;
      // Fast path: if mtime matches, skip the read+hash. On a 5k-vault this
      // turns minutes of work into a no-op for clean drift checks. Falls
      // through to the slow path when mtime differs OR is unavailable
      // (mtime===0 in the mock means "not set").
      const stat = await this.deps.vault.stat(path).catch(() => null);
      if (stat && stat.mtime > 0 && stat.mtime === prior.mtime) continue;
      const raw = await this.deps.vault.read(path);
      const hash = sha256(raw);
      if (hash !== prior.contentHash) hashChanged.push(path);
    }

    for (const path of knownPaths) {
      if (!livePaths.has(path)) removed.push(path);
    }

    const report: DriftReport = {
      ranAt,
      added: added.sort(),
      removed: removed.sort(),
      hashChanged: hashChanged.sort(),
    };

    await this.deps.store.setMeta("lastDriftReport", report);
    await this.deps.store.setMeta("lastReconciledAt", ranAt);

    // Re-run reconcile so additions/removals get enqueued. Hash-changed
    // paths will be re-enqueued too, and the pipeline's hash gate decides
    // whether to actually re-chunk.
    await this.deps.reconciler.reconcile();

    return report;
  }

  private scheduleNext(ms: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      void this.runNow().then(() => this.scheduleNext(WEEK_MS));
    }, ms);
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
