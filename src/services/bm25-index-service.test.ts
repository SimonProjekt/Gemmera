import { describe, expect, it, vi } from "vitest";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import type { Chunk } from "../contracts";
import { BM25IndexService, type BM25IndexEvent } from "./bm25-index-service";
import { InMemoryBM25Index } from "./in-memory-bm25-index";
import type { RunnerEvent } from "./ingestion-runner";

function fakeRunner() {
  let cb: ((e: RunnerEvent) => void) | null = null;
  return {
    onResult(handler: (e: RunnerEvent) => void) {
      cb = handler;
      return () => {
        cb = null;
      };
    },
    emit(e: RunnerEvent) {
      cb?.(e);
    },
    isAttached() {
      return cb !== null;
    },
  };
}

function makeChunks(path: string, n: number, sharedHashes: string[] = []): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < n; i++) {
    const hash = sharedHashes[i] ?? `${path}-h${i}`;
    out.push({
      path,
      ord: i,
      headingPath: ["t"],
      text: `body-${i}`,
      textForEmbed: `t > body-${i} alpha beta`,
      tokenCount: 5,
      contentHash: hash,
    });
  }
  return out;
}

function setup() {
  const index = new InMemoryBM25Index();
  const store = new InMemoryIngestionStore();
  const runner = fakeRunner();
  const service = new BM25IndexService(runner, index, store);
  const events: BM25IndexEvent[] = [];
  service.onEvent((e) => events.push(e));
  service.start();
  return { index, store, runner, service, events };
}

function state(path: string) {
  return { path, contentHash: "c", bodyHash: "b", mtime: 0, frontmatter: null };
}

describe("BM25IndexService", () => {
  it("indexes new chunks on rechunk", async () => {
    const { runner, index, service, events } = setup();
    const chunks = makeChunks("a.md", 3);
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: state("a.md"), chunks, priorChunks: [] },
    });
    await service.flush();
    expect(index.count()).toBe(3);
    for (const c of chunks) expect(index.has(c.contentHash)).toBe(true);
    expect(events).toEqual([{ kind: "added", path: "a.md", count: 3 }]);
  });

  it("dedupes duplicate hashes within one rechunk", async () => {
    const { runner, index, service } = setup();
    const chunks = makeChunks("a.md", 3, ["x", "x", "y"]);
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: state("a.md"), chunks, priorChunks: [] },
    });
    await service.flush();
    expect(index.count()).toBe(2);
  });

  it("skips chunks already in the index without re-adding", async () => {
    const { runner, index, service, events } = setup();
    const chunks = makeChunks("a.md", 2);
    for (const c of chunks) index.addDoc(c.contentHash, c.textForEmbed);
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: state("a.md"), chunks, priorChunks: [] },
    });
    await service.flush();
    expect(index.count()).toBe(2);
    expect(events.at(-1)).toEqual({ kind: "skipped", path: "a.md" });
  });

  it("evicts prior chunks whose hashes are no longer referenced", async () => {
    const { runner, index, store, service, events } = setup();
    const old = makeChunks("a.md", 2, ["old1", "old2"]);
    const next = makeChunks("a.md", 1, ["new1"]);
    await store.upsert(state("a.md"), next); // store reflects post-state
    for (const c of old) index.addDoc(c.contentHash, c.textForEmbed);

    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: state("a.md"), chunks: next, priorChunks: old },
    });
    await service.flush();
    expect(index.has("old1")).toBe(false);
    expect(index.has("old2")).toBe(false);
    expect(index.has("new1")).toBe(true);
    expect(events.find((e) => e.kind === "evicted")).toMatchObject({ count: 2 });
  });

  it("does not evict an orphan hash that is still referenced by another note", async () => {
    const { runner, index, store, service } = setup();
    const sharedHash = "shared";
    const otherChunks = makeChunks("b.md", 1, [sharedHash]);
    await store.upsert(state("b.md"), otherChunks); // b.md still uses `shared`
    await store.upsert(state("a.md"), []); // a.md cleared
    index.addDoc(sharedHash, "shared text");

    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: {
        kind: "rechunk",
        state: state("a.md"),
        chunks: [],
        priorChunks: makeChunks("a.md", 1, [sharedHash]),
      },
    });
    await service.flush();
    expect(index.has(sharedHash)).toBe(true);
  });

  it("ignores non-rechunk decisions and deleted/renamed events", async () => {
    const { runner, index, service } = setup();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "skip", state: state("a.md") },
    });
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "metadata-only", state: state("a.md") },
    });
    runner.emit({ kind: "deleted", path: "a.md" });
    runner.emit({ kind: "renamed", from: "a.md", to: "b.md" });
    await service.flush();
    expect(index.count()).toBe(0);
  });

  it("processes consecutive decisions serially", async () => {
    const { runner, index, service } = setup();
    for (let i = 0; i < 4; i++) {
      runner.emit({
        kind: "decision",
        job: { kind: "index", path: `${i}.md` },
        decision: {
          kind: "rechunk",
          state: state(`${i}.md`),
          chunks: makeChunks(`${i}.md`, 1),
          priorChunks: [],
        },
      });
    }
    await service.flush();
    expect(index.count()).toBe(4);
  });

  it("emits error and continues on store failure", async () => {
    const { runner, store, index, service, events } = setup();
    const old = makeChunks("a.md", 1, ["o"]);
    index.addDoc("o", "stale");
    vi.spyOn(store, "isHashReferenced").mockRejectedValueOnce(new Error("io"));

    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: {
        kind: "rechunk",
        state: state("a.md"),
        chunks: makeChunks("a.md", 1, ["new"]),
        priorChunks: old,
      },
    });
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "b.md" },
      decision: {
        kind: "rechunk",
        state: state("b.md"),
        chunks: makeChunks("b.md", 1, ["b1"]),
        priorChunks: [],
      },
    });
    await service.flush();
    expect(events[0].kind).toBe("error");
    expect(index.has("b1")).toBe(true);
  });

  it("stop() unsubscribes and awaits in-flight", async () => {
    const { runner, index, service } = setup();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: {
        kind: "rechunk",
        state: state("a.md"),
        chunks: makeChunks("a.md", 1, ["x"]),
        priorChunks: [],
      },
    });
    await service.stop();
    expect(index.has("x")).toBe(true);
    expect(runner.isAttached()).toBe(false);
  });
});
