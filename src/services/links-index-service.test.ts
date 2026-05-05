import { describe, expect, it, vi } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { InMemoryLinksIndex } from "./in-memory-links-index";
import { LinksIndexService, type LinksIndexEvent } from "./links-index-service";
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

function setup(files: Record<string, string> = {}) {
  const vault = new MockVaultService(files);
  const index = new InMemoryLinksIndex();
  const runner = fakeRunner();
  const service = new LinksIndexService(runner, vault, index);
  const events: LinksIndexEvent[] = [];
  service.onEvent((e) => events.push(e));
  service.start();
  return { vault, index, runner, service, events };
}

function state(path: string) {
  return { path, contentHash: "c", bodyHash: "b", mtime: 0, frontmatter: null };
}

describe("LinksIndexService", () => {
  it("on rechunk: reads the body, parses links, upserts the index", async () => {
    const { runner, index, service, events } = setup({
      "a.md": "see [[B]] and [[C]]",
      "b.md": "",
    });
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: state("a.md"), chunks: [], priorChunks: [] },
    });
    await service.flush();
    expect(index.outgoing("a.md").map((l) => l.raw)).toEqual(["B", "C"]);
    expect(events).toEqual([{ kind: "indexed", path: "a.md", linkCount: 2 }]);
  });

  it("skips metadata-only and skip decisions", async () => {
    const { runner, vault, service, events } = setup({ "a.md": "[[B]]" });
    const readSpy = vi.spyOn(vault, "read");
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
    await service.flush();
    expect(readSpy).not.toHaveBeenCalled();
    expect(events.map((e) => e.kind)).toEqual(["skipped", "skipped"]);
  });

  it("propagates deleted to index.remove and emits a removed event", async () => {
    const { runner, index, service, events } = setup({ "a.md": "" });
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: state("a.md"), chunks: [], priorChunks: [] },
    });
    await service.flush();
    expect(index.size()).toBe(1);

    runner.emit({ kind: "deleted", path: "a.md" });
    await service.flush();
    expect(index.size()).toBe(0);
    expect(events.at(-1)).toEqual({ kind: "removed", path: "a.md" });
  });

  it("propagates renamed to index.rename and emits a renamed event", async () => {
    const { runner, index, service, events } = setup({ "a.md": "[[B]]" });
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: state("a.md"), chunks: [], priorChunks: [] },
    });
    await service.flush();

    runner.emit({ kind: "renamed", from: "a.md", to: "moved.md" });
    await service.flush();
    expect(index.outgoing("moved.md").map((l) => l.raw)).toEqual(["B"]);
    expect(events.at(-1)).toEqual({ kind: "renamed", from: "a.md", to: "moved.md" });
  });

  it("ignores runner error events (already reported by the runner)", async () => {
    const { runner, service, events } = setup();
    runner.emit({
      kind: "error",
      job: { kind: "index", path: "a.md" },
      error: new Error("boom"),
    });
    await service.flush();
    expect(events).toEqual([]);
  });

  it("emits an error event when vault.read throws but keeps processing later events", async () => {
    const { runner, vault, index, service, events } = setup({ "b.md": "[[A]]" });
    vi.spyOn(vault, "read").mockImplementationOnce(async () => {
      throw new Error("io");
    });

    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "missing.md" },
      decision: { kind: "rechunk", state: state("missing.md"), chunks: [], priorChunks: [] },
    });
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "b.md" },
      decision: { kind: "rechunk", state: state("b.md"), chunks: [], priorChunks: [] },
    });
    await service.flush();

    expect(events[0].kind).toBe("error");
    expect(events[1]).toEqual({ kind: "indexed", path: "b.md", linkCount: 1 });
    expect(index.outgoing("b.md").map((l) => l.raw)).toEqual(["A"]);
  });

  it("processes consecutive events serially", async () => {
    const { runner, vault, service } = setup({
      "a.md": "[[X]]",
      "b.md": "[[Y]]",
      "c.md": "[[Z]]",
    });
    let inFlight = 0;
    let maxParallel = 0;
    vi.spyOn(vault, "read").mockImplementation(async (p) => {
      inFlight++;
      maxParallel = Math.max(maxParallel, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return p === "a.md" ? "[[X]]" : p === "b.md" ? "[[Y]]" : "[[Z]]";
    });
    for (const path of ["a.md", "b.md", "c.md"]) {
      runner.emit({
        kind: "decision",
        job: { kind: "index", path },
        decision: { kind: "rechunk", state: state(path), chunks: [], priorChunks: [] },
      });
    }
    await service.flush();
    expect(maxParallel).toBe(1);
  });

  it("stop() unsubscribes and awaits in-flight work", async () => {
    const { runner, service, index } = setup();
    let resolveRead!: (value: string) => void;
    const readPromise = new Promise<string>((r) => {
      resolveRead = r;
    });
    const slowVault = { read: () => readPromise };
    const slowIndex = new InMemoryLinksIndex();
    const slowSvc = new LinksIndexService(runner, slowVault, slowIndex);
    slowSvc.start();
    runner.emit({
      kind: "decision",
      job: { kind: "index", path: "a.md" },
      decision: { kind: "rechunk", state: state("a.md"), chunks: [], priorChunks: [] },
    });
    const stopped = slowSvc.stop();
    resolveRead("[[Z]]");
    await stopped;
    expect(slowIndex.outgoing("a.md").map((l) => l.raw)).toEqual(["Z"]);
    expect(runner.isAttached()).toBe(false);
    void service;
    void index;
  });
});
