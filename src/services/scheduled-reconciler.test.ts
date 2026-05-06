import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { DefaultPathFilter } from "./path-filter";
import { VaultReconciler } from "./vault-reconciler";
import { ScheduledReconciler } from "./scheduled-reconciler";
import type { NoteState } from "../contracts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function makeNoteState(path: string, content: string): NoteState {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return {
    path,
    contentHash: hash,
    bodyHash: hash,
    mtime: 0,
    frontmatter: null,
  };
}

function setup(now: number, files: Record<string, string> = {}) {
  const vault = new MockVaultService(files);
  const store = new InMemoryIngestionStore();
  const queue = new InMemoryJobQueue();
  const reconciler = new VaultReconciler(vault, store, queue, new DefaultPathFilter());
  const setTimer = vi.fn(() => "TIMER" as unknown);
  const clearTimer = vi.fn();
  const sched = new ScheduledReconciler({
    vault,
    store,
    reconciler,
    now: () => now,
    setTimer,
    clearTimer,
  });
  return { vault, store, queue, sched, setTimer, clearTimer };
}

describe("ScheduledReconciler", () => {
  it("runs immediately when overdue and schedules next week", async () => {
    const now = 100 * WEEK_MS;
    const { store, sched, setTimer } = setup(now, { "a.md": "hello" });
    await store.setMeta("lastReconciledAt", now - WEEK_MS - 1);

    await sched.start();

    expect(await store.getMeta("lastReconciledAt")).toBe(now);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), WEEK_MS);
  });

  it("schedules a delta when not yet due", async () => {
    const now = 100 * WEEK_MS;
    const { store, sched, setTimer } = setup(now);
    await store.setMeta("lastReconciledAt", now - 1000);

    await sched.start();

    // Should not have run (lastReconciledAt unchanged).
    expect(await store.getMeta("lastReconciledAt")).toBe(now - 1000);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), WEEK_MS - 1000);
  });

  it("produces a drift report with adds, removes, and hash changes", async () => {
    const now = 100 * WEEK_MS;
    const { vault, store, sched } = setup(now, {
      "a.md": "alpha",
      "b.md": "bravo-new",
      "c.md": "charlie",
    });
    // Seed store: a.md known with same hash, b.md known with stale hash,
    // d.md known but no longer in vault.
    await store.upsert(makeNoteState("a.md", "alpha"), []);
    await store.upsert(makeNoteState("b.md", "bravo-old"), []);
    await store.upsert(makeNoteState("d.md", "delta"), []);

    const report = await sched.runNow();

    expect(report.added).toEqual(["c.md"]);
    expect(report.removed).toEqual(["d.md"]);
    expect(report.hashChanged).toEqual(["b.md"]);
    expect(report.ranAt).toBe(now);

    expect(await store.getMeta("lastDriftReport")).toEqual(report);

    // vault unused-warn silencer
    expect(vault).toBeDefined();
  });

  it("stop() clears the timer", async () => {
    const now = 100 * WEEK_MS;
    const { sched, clearTimer, store } = setup(now);
    await store.setMeta("lastReconciledAt", now);
    await sched.start();
    sched.stop();
    expect(clearTimer).toHaveBeenCalled();
  });
});
