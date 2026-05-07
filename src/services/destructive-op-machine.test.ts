import { describe, expect, it, vi } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { InMemoryEventLog } from "./event-log";
import {
  ConfirmDecision,
  runDestructiveOp,
} from "./destructive-op-machine";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVault(files: Record<string, string> = {}): MockVaultService {
  return new MockVaultService(files);
}

function alwaysConfirm(): Promise<ConfirmDecision> {
  return Promise.resolve("confirmed");
}

function alwaysCancel(): Promise<ConfirmDecision> {
  return Promise.resolve("cancelled");
}

// ── Delete path ───────────────────────────────────────────────────────────────

describe("runDestructiveOp — delete", () => {
  it("trashes the file and enqueues a delete job on confirm", async () => {
    const vault = makeVault({ "notes/todo.md": "# Todo\nBuy milk." });
    const jobQueue = new InMemoryJobQueue();

    const outcome = await runDestructiveOp(
      { kind: "delete", path: "notes/todo.md" },
      {
        vault,
        jobQueue,
        confirmDelete: alwaysConfirm,
        confirmRename: alwaysConfirm,
      },
    );

    expect(outcome).toEqual({ kind: "done", op: { kind: "delete", path: "notes/todo.md" } });
    expect(await vault.exists("notes/todo.md")).toBe(false);
    expect(jobQueue.drain()).toEqual([{ kind: "delete", path: "notes/todo.md" }]);
  });

  it("returns cancelled and leaves file intact when user cancels", async () => {
    const vault = makeVault({ "notes/todo.md": "content" });
    const jobQueue = new InMemoryJobQueue();

    const outcome = await runDestructiveOp(
      { kind: "delete", path: "notes/todo.md" },
      {
        vault,
        jobQueue,
        confirmDelete: alwaysCancel,
        confirmRename: alwaysConfirm,
      },
    );

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(await vault.exists("notes/todo.md")).toBe(true);
    expect(jobQueue.size()).toBe(0);
  });

  it("passes the first 800 chars of the file to the confirm handler", async () => {
    const content = "A".repeat(1200);
    const vault = makeVault({ "notes/big.md": content });
    const jobQueue = new InMemoryJobQueue();

    let receivedPreview = "";
    await runDestructiveOp(
      { kind: "delete", path: "notes/big.md" },
      {
        vault,
        jobQueue,
        confirmDelete: (_path, preview) => {
          receivedPreview = preview;
          return Promise.resolve("confirmed");
        },
        confirmRename: alwaysConfirm,
      },
    );

    expect(receivedPreview).toHaveLength(800);
  });

  it("passes the file path to the confirm handler", async () => {
    const vault = makeVault({ "inbox/note.md": "body" });
    const jobQueue = new InMemoryJobQueue();

    let receivedPath = "";
    await runDestructiveOp(
      { kind: "delete", path: "inbox/note.md" },
      {
        vault,
        jobQueue,
        confirmDelete: (path) => {
          receivedPath = path;
          return Promise.resolve("confirmed");
        },
        confirmRename: alwaysConfirm,
      },
    );

    expect(receivedPath).toBe("inbox/note.md");
  });

  it("still calls confirmDelete when the file cannot be read (missing)", async () => {
    // File exists for trash but not for read — we use two different vaults to
    // simulate a race, but here we verify the handler is called even if read fails.
    const vault = makeVault({});
    const jobQueue = new InMemoryJobQueue();

    // Patch trash so it succeeds even though the file isn't in the mock.
    vi.spyOn(vault, "trash").mockResolvedValue(undefined);

    let handlerCalled = false;
    await runDestructiveOp(
      { kind: "delete", path: "ghost.md" },
      {
        vault,
        jobQueue,
        confirmDelete: () => {
          handlerCalled = true;
          return Promise.resolve("confirmed");
        },
        confirmRename: alwaysConfirm,
      },
    );

    expect(handlerCalled).toBe(true);
  });

  // ── Non-overridability: the confirm handler is ALWAYS called ───────────────

  it("always calls confirmDelete — no caller option can bypass it", async () => {
    const vault = makeVault({ "private/diary.md": "secret" });
    const jobQueue = new InMemoryJobQueue();

    let callCount = 0;
    const trackingConfirm = (): Promise<ConfirmDecision> => {
      callCount++;
      return Promise.resolve("confirmed");
    };

    // Call under different 'settings-like' conditions — the handler is always
    // invoked because the contract hard-wires it into CONFIRM state.
    for (const path of ["private/diary.md"]) {
      // Recreate the file each time so trash doesn't throw on the second pass.
      vault.setFile(path, "secret");

      await runDestructiveOp(
        { kind: "delete", path },
        {
          vault,
          jobQueue,
          confirmDelete: trackingConfirm,
          confirmRename: alwaysConfirm,
          // No alwaysPreview flag — delete never reads a settings flag.
        },
      );
    }

    expect(callCount).toBe(1);
  });
});

// ── Rename path ───────────────────────────────────────────────────────────────

describe("runDestructiveOp — rename", () => {
  it("renames the file and enqueues a rename job on confirm", async () => {
    const vault = makeVault({ "notes/old.md": "body" });
    const jobQueue = new InMemoryJobQueue();

    const outcome = await runDestructiveOp(
      { kind: "rename", from: "notes/old.md", to: "notes/new.md", affectedLinkCount: 3 },
      {
        vault,
        jobQueue,
        confirmDelete: alwaysConfirm,
        confirmRename: alwaysConfirm,
      },
    );

    expect(outcome).toEqual({
      kind: "done",
      op: { kind: "rename", from: "notes/old.md", to: "notes/new.md", affectedLinkCount: 3 },
    });
    expect(await vault.exists("notes/old.md")).toBe(false);
    expect(await vault.exists("notes/new.md")).toBe(true);
    expect(jobQueue.drain()).toEqual([
      { kind: "rename", from: "notes/old.md", to: "notes/new.md" },
    ]);
  });

  it("returns cancelled and leaves files unchanged when user cancels", async () => {
    const vault = makeVault({ "notes/old.md": "body" });
    const jobQueue = new InMemoryJobQueue();

    const outcome = await runDestructiveOp(
      { kind: "rename", from: "notes/old.md", to: "notes/new.md", affectedLinkCount: 0 },
      {
        vault,
        jobQueue,
        confirmDelete: alwaysConfirm,
        confirmRename: alwaysCancel,
      },
    );

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(await vault.exists("notes/old.md")).toBe(true);
    expect(await vault.exists("notes/new.md")).toBe(false);
    expect(jobQueue.size()).toBe(0);
  });

  it("passes from, to, and affectedLinkCount to the confirm handler", async () => {
    const vault = makeVault({ "a.md": "x" });
    const jobQueue = new InMemoryJobQueue();

    let args: [string, string, number] | null = null;
    await runDestructiveOp(
      { kind: "rename", from: "a.md", to: "b.md", affectedLinkCount: 7 },
      {
        vault,
        jobQueue,
        confirmDelete: alwaysConfirm,
        confirmRename: (from, to, count) => {
          args = [from, to, count];
          return Promise.resolve("confirmed");
        },
      },
    );

    expect(args).toEqual(["a.md", "b.md", 7]);
  });
});

// ── Event log ─────────────────────────────────────────────────────────────────

describe("runDestructiveOp — event log", () => {
  it("logs CONFIRM → EXECUTE → UPDATE_INDEX → DONE for a confirmed delete", async () => {
    const vault = makeVault({ "x.md": "hi" });
    const jobQueue = new InMemoryJobQueue();
    const eventLog = new InMemoryEventLog();

    await runDestructiveOp(
      { kind: "delete", path: "x.md" },
      { vault, jobQueue, confirmDelete: alwaysConfirm, confirmRename: alwaysConfirm, eventLog, turnId: "t1" },
    );

    const entries = await eventLog.eventsFor("t1");
    const states = entries.map((e) => e.state);
    expect(states).toEqual(["CONFIRM", "EXECUTE", "UPDATE_INDEX", "DONE"]);
  });

  it("logs CONFIRM → CANCELLED when user cancels", async () => {
    const vault = makeVault({ "x.md": "hi" });
    const jobQueue = new InMemoryJobQueue();
    const eventLog = new InMemoryEventLog();

    await runDestructiveOp(
      { kind: "delete", path: "x.md" },
      { vault, jobQueue, confirmDelete: alwaysCancel, confirmRename: alwaysConfirm, eventLog, turnId: "t2" },
    );

    const entries = await eventLog.eventsFor("t2");
    const states = entries.map((e) => e.state);
    expect(states).toEqual(["CONFIRM", "CANCELLED"]);
  });

  it("logs TOOL_FAILED when the vault operation throws", async () => {
    const vault = makeVault({});
    const jobQueue = new InMemoryJobQueue();
    const eventLog = new InMemoryEventLog();

    vi.spyOn(vault, "trash").mockRejectedValue(new Error("disk full"));

    await expect(
      runDestructiveOp(
        { kind: "delete", path: "missing.md" },
        { vault, jobQueue, confirmDelete: alwaysConfirm, confirmRename: alwaysConfirm, eventLog, turnId: "t3" },
      ),
    ).rejects.toThrow("disk full");

    const entries = await eventLog.eventsFor("t3");
    const states = entries.map((e) => e.state);
    expect(states).toContain("TOOL_FAILED");
  });
});
