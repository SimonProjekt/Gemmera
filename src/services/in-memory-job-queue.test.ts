import { describe, expect, it, vi } from "vitest";
import { InMemoryJobQueue } from "./in-memory-job-queue";

describe("InMemoryJobQueue", () => {
  it("enqueues and drains in FIFO order", () => {
    const q = new InMemoryJobQueue();
    q.enqueue({ kind: "index", path: "a.md" });
    q.enqueue({ kind: "delete", path: "b.md" });
    expect(q.size()).toBe(2);
    expect(q.drain()).toEqual([
      { kind: "index", path: "a.md" },
      { kind: "delete", path: "b.md" },
    ]);
    expect(q.size()).toBe(0);
  });

  it("coalesces consecutive duplicate index jobs", () => {
    const q = new InMemoryJobQueue();
    q.enqueue({ kind: "index", path: "a.md" });
    q.enqueue({ kind: "index", path: "a.md" });
    q.enqueue({ kind: "index", path: "a.md" });
    expect(q.drain()).toEqual([{ kind: "index", path: "a.md" }]);
  });

  it("does NOT coalesce different paths or different kinds", () => {
    const q = new InMemoryJobQueue();
    q.enqueue({ kind: "index", path: "a.md" });
    q.enqueue({ kind: "index", path: "b.md" });
    q.enqueue({ kind: "delete", path: "b.md" });
    expect(q.drain()).toHaveLength(3);
  });

  it("coalesces consecutive duplicate rename jobs", () => {
    const q = new InMemoryJobQueue();
    q.enqueue({ kind: "rename", from: "a.md", to: "b.md" });
    q.enqueue({ kind: "rename", from: "a.md", to: "b.md" });
    expect(q.drain()).toHaveLength(1);
  });

  it("fires arrival listener only on transition from empty", () => {
    const q = new InMemoryJobQueue();
    const cb = vi.fn();
    q.onArrival(cb);
    q.enqueue({ kind: "index", path: "a.md" });
    q.enqueue({ kind: "index", path: "b.md" });
    expect(cb).toHaveBeenCalledTimes(1);
    q.drain();
    q.enqueue({ kind: "index", path: "c.md" });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes arrival listener cleanly", () => {
    const q = new InMemoryJobQueue();
    const cb = vi.fn();
    const off = q.onArrival(cb);
    off();
    q.enqueue({ kind: "index", path: "a.md" });
    expect(cb).not.toHaveBeenCalled();
  });
});
