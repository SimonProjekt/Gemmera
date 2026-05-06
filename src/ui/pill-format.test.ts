import { describe, expect, it } from "vitest";
import { formatPill } from "./pill-format";

describe("formatPill", () => {
  it("hides when idle", () => {
    const v = formatPill({ phase: "idle", pending: 0, total: undefined, completed: 0 });
    expect(v.visible).toBe(false);
  });

  it("hides for tiny vaults below threshold", () => {
    const v = formatPill(
      { phase: "running", pending: 5, total: 10, completed: 5 },
      50,
    );
    expect(v.visible).toBe(false);
  });

  it("shows X of Y when running on a non-tiny batch", () => {
    const v = formatPill(
      { phase: "running", pending: 200, total: 1000, completed: 800 },
      50,
    );
    expect(v.visible).toBe(true);
    expect(v.text).toBe("Indexing 800 of 1000");
    expect(v.variant).toBe("running");
  });

  it("shows paused state regardless of tiny-vault rule", () => {
    const v = formatPill(
      { phase: "paused", pending: 5, total: 10, completed: 5 },
      50,
    );
    expect(v.visible).toBe(true);
    expect(v.text).toContain("paused");
    expect(v.variant).toBe("paused");
  });

  it("shows generic paused text when total is unknown", () => {
    const v = formatPill({
      phase: "paused",
      pending: 0,
      total: undefined,
      completed: 0,
    });
    expect(v.text).toBe("Indexing paused");
  });
});
