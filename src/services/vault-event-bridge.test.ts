import { describe, expect, it } from "vitest";
import { MockVaultEventSource } from "../contracts/mocks/mock-vault-events";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { DefaultPathFilter } from "./path-filter";
import { VaultEventBridge } from "./vault-event-bridge";

function setup(userIgnore: (p: string) => boolean = () => false) {
  const source = new MockVaultEventSource();
  const queue = new InMemoryJobQueue();
  const filter = new DefaultPathFilter({ matches: userIgnore });
  const bridge = new VaultEventBridge(source, queue, filter);
  bridge.start();
  return { source, queue, bridge };
}

describe("VaultEventBridge", () => {
  it("translates create + modify into index jobs", () => {
    const { source, queue } = setup();
    source.emitCreate("Notes/a.md");
    source.emitModify("Notes/a.md");
    // create + modify on the same path coalesce in the queue (consecutive dupes).
    expect(queue.drain()).toEqual([{ kind: "index", path: "Notes/a.md" }]);
  });

  it("collapses modify + metadata-change on the same path to one job", () => {
    const { source, queue } = setup();
    source.emitModify("Notes/a.md");
    source.emitMetadataChange("Notes/a.md");
    // Both translate to {kind:"index"} so the queue coalesces consecutive dupes.
    expect(queue.drain()).toEqual([{ kind: "index", path: "Notes/a.md" }]);
  });

  it("emits delete jobs for removed .md files", () => {
    const { source, queue } = setup();
    source.emitDelete("Notes/a.md");
    expect(queue.drain()).toEqual([{ kind: "delete", path: "Notes/a.md" }]);
  });

  it("ignores delete events for non-markdown files", () => {
    const { source, queue } = setup();
    source.emitDelete("Attachments/img.png");
    expect(queue.size()).toBe(0);
  });

  it("emits a rename job (no re-index) when both ends are indexable", () => {
    const { source, queue } = setup();
    source.emitRename("Notes/a.md", "Notes/b.md");
    expect(queue.drain()).toEqual([
      { kind: "rename", from: "Notes/a.md", to: "Notes/b.md" },
    ]);
  });

  it("converts a rename out-of-scope into a delete", () => {
    const { source, queue } = setup((p) => p.startsWith("Drafts/"));
    source.emitRename("Notes/a.md", "Drafts/a.md");
    expect(queue.drain()).toEqual([{ kind: "delete", path: "Notes/a.md" }]);
  });

  it("converts a rename into-scope into an index", () => {
    const { source, queue } = setup((p) => p.startsWith("Drafts/"));
    source.emitRename("Drafts/a.md", "Notes/a.md");
    expect(queue.drain()).toEqual([{ kind: "index", path: "Notes/a.md" }]);
  });

  it("drops events for hard-ignored paths", () => {
    const { source, queue } = setup();
    source.emitCreate(".obsidian/workspace.json");
    source.emitModify(".git/HEAD");
    source.emitMetadataChange(".coworkmd/snapshot.md");
    expect(queue.size()).toBe(0);
  });

  it("drops events for user-ignored paths", () => {
    const { source, queue } = setup((p) => p.startsWith("Drafts/"));
    source.emitCreate("Drafts/wip.md");
    source.emitModify("Drafts/wip.md");
    expect(queue.size()).toBe(0);
  });

  it("stop() unsubscribes all listeners and is idempotent", () => {
    const { source, bridge, queue } = setup();
    expect(source.listenerCount()).toBeGreaterThan(0);
    bridge.stop();
    expect(source.listenerCount()).toBe(0);
    bridge.stop(); // safe to call again
    source.emitCreate("Notes/a.md");
    expect(queue.size()).toBe(0);
  });

  it("start() is idempotent", () => {
    const { source, bridge } = setup();
    const before = source.listenerCount();
    bridge.start();
    expect(source.listenerCount()).toBe(before);
  });
});
