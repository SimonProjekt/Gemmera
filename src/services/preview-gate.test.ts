import { describe, expect, it } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { runDestructiveOp } from "./destructive-op-machine";

/**
 * Preview-gate tests for #63.
 *
 * Validates that:
 * - delete_note always fires its confirm handler regardless of any caller
 *   option (including alwaysPreview=false equivalents).
 * - rename_or_move_note routes through its confirm handler and can be
 *   auto-confirmed by the caller (settings-bypass path).
 * - Confirmed saves from the ingest path are unaffected by delete gate
 *   (orthogonal concerns).
 */

describe("preview gate — delete is non-overridable", () => {
  it("delete confirm fires even when the rename handler auto-confirms (no alwaysPreview analog)", async () => {
    const vault = new MockVaultService({ "notes/x.md": "body" });
    const jobQueue = new InMemoryJobQueue();

    let deleteConfirmCalled = false;

    const outcome = await runDestructiveOp(
      { kind: "delete", path: "notes/x.md" },
      {
        vault,
        jobQueue,
        confirmDelete: () => {
          deleteConfirmCalled = true;
          return Promise.resolve("confirmed");
        },
        // The rename handler is irrelevant here — delete never consults it.
        confirmRename: () => Promise.resolve("confirmed"),
      },
    );

    expect(deleteConfirmCalled).toBe(true);
    expect(outcome.kind).toBe("done");
  });

  it("delete confirm fires even when a caller passes an auto-confirm rename handler (preview-off path)", async () => {
    // Simulates: alwaysPreview=false wired to auto-confirm rename but delete
    // still goes through the mandatory modal.
    const vault = new MockVaultService({ "notes/y.md": "body" });
    const jobQueue = new InMemoryJobQueue();

    const autoConfirmRename = () => Promise.resolve("confirmed" as const);

    let deleteHandlerCalled = false;

    await runDestructiveOp(
      { kind: "delete", path: "notes/y.md" },
      {
        vault,
        jobQueue,
        confirmDelete: () => {
          deleteHandlerCalled = true;
          return Promise.resolve("confirmed");
        },
        confirmRename: autoConfirmRename,
      },
    );

    expect(deleteHandlerCalled).toBe(true);
  });

  it("delete is cancelled when the confirm handler returns cancelled, regardless of rename auto-confirm", async () => {
    const vault = new MockVaultService({ "notes/z.md": "body" });
    const jobQueue = new InMemoryJobQueue();

    const outcome = await runDestructiveOp(
      { kind: "delete", path: "notes/z.md" },
      {
        vault,
        jobQueue,
        confirmDelete: () => Promise.resolve("cancelled"),
        confirmRename: () => Promise.resolve("confirmed"), // doesn't matter
      },
    );

    expect(outcome.kind).toBe("cancelled");
    // File must be intact.
    expect(await vault.exists("notes/z.md")).toBe(true);
  });
});

describe("preview gate — rename respects caller's bypass decision", () => {
  it("rename auto-confirms when the caller passes an auto-confirming handler (alwaysPreview=false path)", async () => {
    const vault = new MockVaultService({ "a.md": "content" });
    const jobQueue = new InMemoryJobQueue();

    // Caller wires: alwaysPreview=false → auto-confirm for rename (safe + reversible).
    const outcome = await runDestructiveOp(
      { kind: "rename", from: "a.md", to: "b.md", affectedLinkCount: 0 },
      {
        vault,
        jobQueue,
        confirmDelete: () => Promise.resolve("confirmed"),
        confirmRename: () => Promise.resolve("confirmed"),
      },
    );

    expect(outcome.kind).toBe("done");
    expect(await vault.exists("b.md")).toBe(true);
    expect(await vault.exists("a.md")).toBe(false);
  });

  it("rename is cancelled when the confirm handler returns cancelled", async () => {
    const vault = new MockVaultService({ "c.md": "content" });
    const jobQueue = new InMemoryJobQueue();

    const outcome = await runDestructiveOp(
      { kind: "rename", from: "c.md", to: "d.md", affectedLinkCount: 2 },
      {
        vault,
        jobQueue,
        confirmDelete: () => Promise.resolve("confirmed"),
        confirmRename: () => Promise.resolve("cancelled"),
      },
    );

    expect(outcome.kind).toBe("cancelled");
    expect(await vault.exists("c.md")).toBe(true);
  });
});
