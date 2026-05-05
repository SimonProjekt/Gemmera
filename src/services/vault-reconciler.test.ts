import { describe, expect, it } from "vitest";
import type { NoteState } from "../contracts";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { DefaultPathFilter } from "./path-filter";
import { VaultReconciler } from "./vault-reconciler";

const seedState = (path: string): NoteState => ({
  path,
  contentHash: "c",
  bodyHash: "b",
  mtime: 0,
  frontmatter: null,
});

function setup(opts: {
  vault: Record<string, string>;
  storedPaths?: string[];
  userIgnore?: (p: string) => boolean;
}) {
  const vault = new MockVaultService(opts.vault);
  const store = new InMemoryIngestionStore();
  const queue = new InMemoryJobQueue();
  const filter = new DefaultPathFilter({ matches: opts.userIgnore ?? (() => false) });
  for (const path of opts.storedPaths ?? []) {
    // upsert with empty chunks; reconciler only cares about path enumeration.
    void store.upsert(seedState(path), []);
  }
  return { vault, store, queue, filter };
}

describe("VaultReconciler", () => {
  it("enqueues an index job for every indexable vault file", async () => {
    const { vault, store, queue, filter } = setup({
      vault: { "Notes/a.md": "x", "Notes/b.md": "y" },
    });
    const r = new VaultReconciler(vault, store, queue, filter);
    const result = await r.reconcile();
    expect(result.enqueuedIndex).toBe(2);
    expect(queue.drain()).toEqual([
      { kind: "index", path: "Notes/a.md" },
      { kind: "index", path: "Notes/b.md" },
    ]);
  });

  it("enqueues a delete job for every store entry no longer in the vault", async () => {
    const { vault, store, queue, filter } = setup({
      vault: { "Notes/keep.md": "x" },
      storedPaths: ["Notes/keep.md", "Notes/gone.md"],
    });
    const r = new VaultReconciler(vault, store, queue, filter);
    const result = await r.reconcile();
    expect(result.enqueuedIndex).toBe(1);
    expect(result.enqueuedDelete).toBe(1);
    expect(queue.drain()).toContainEqual({ kind: "delete", path: "Notes/gone.md" });
  });

  it("treats files newly out of scope as orphans", async () => {
    const { vault, store, queue, filter } = setup({
      vault: { "Notes/keep.md": "x", "Drafts/wip.md": "y" },
      storedPaths: ["Notes/keep.md", "Drafts/wip.md"],
      userIgnore: (p) => p.startsWith("Drafts/"),
    });
    const r = new VaultReconciler(vault, store, queue, filter);
    const result = await r.reconcile();
    expect(result.enqueuedDelete).toBe(1);
    expect(queue.drain()).toContainEqual({ kind: "delete", path: "Drafts/wip.md" });
  });

  it("returns zero counts on an empty vault and empty store", async () => {
    const { vault, store, queue, filter } = setup({ vault: {} });
    const r = new VaultReconciler(vault, store, queue, filter);
    expect(await r.reconcile()).toEqual({ enqueuedIndex: 0, enqueuedDelete: 0 });
    expect(queue.size()).toBe(0);
  });

  it("ignores non-markdown vault files and dotfile directories", async () => {
    const { vault, store, queue, filter } = setup({
      vault: {
        "Notes/a.md": "x",
        ".obsidian/workspace.json": "skip",
        "Attachments/img.png": "skip",
      },
    });
    const r = new VaultReconciler(vault, store, queue, filter);
    const result = await r.reconcile();
    expect(result.enqueuedIndex).toBe(1);
  });
});
