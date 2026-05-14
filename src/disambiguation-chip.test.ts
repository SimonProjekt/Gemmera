import { describe, expect, it } from "vitest";
import { DisambiguationChip } from "./disambiguation-chip";
import type { ClassifierDecision } from "./contracts/classifier";

function makeDecision(overrides: Partial<ClassifierDecision> = {}): ClassifierDecision {
  return {
    source: "llm",
    input: { messageText: "save this", truncated: false, attachments: [], activeFile: null, recentTurns: [] },
    output: { label: "capture", confidence: 0.6, rationale: "User wants to save content." },
    latencyMs: 120,
    promptVersion: "0.1.0",
    skipReason: null,
    needsDisambiguation: true,
    fallbackReason: null,
    ...overrides,
  };
}

describe("DisambiguationChip", () => {
  // ── Initial state ────────────────────────────────────────────────────

  it("starts not showing", () => {
    const chip = new DisambiguationChip();
    expect(chip.isShowing()).toBe(false);
  });

  it("drainQueue returns empty array when nothing queued", () => {
    const chip = new DisambiguationChip();
    expect(chip.drainQueue()).toEqual([]);
  });

  // ── hold ─────────────────────────────────────────────────────────────

  it("hold transitions to showing", () => {
    const chip = new DisambiguationChip();
    const ok = chip.hold("save this", "t-1", makeDecision());
    expect(ok).toBe(true);
    expect(chip.isShowing()).toBe(true);
  });

  it("hold exposes rationale from decision output", () => {
    const chip = new DisambiguationChip();
    chip.hold("save this", "t-1", makeDecision({ output: { label: "capture", confidence: 0.6, rationale: "My rationale" } }));
    expect(chip.rationale).toBe("My rationale");
  });

  it("hold exposes pendingTurnId", () => {
    const chip = new DisambiguationChip();
    chip.hold("save this", "t-42", makeDecision());
    expect(chip.pendingTurnId).toBe("t-42");
  });

  it("hold returns false if a message is already held", () => {
    const chip = new DisambiguationChip();
    chip.hold("first", "t-1", makeDecision());
    const second = chip.hold("second", "t-2", makeDecision());
    expect(second).toBe(false);
    expect(chip.pendingTurnId).toBe("t-1");
  });

  // ── resolve ──────────────────────────────────────────────────────────

  it('resolve("save") clears pending and returns resolution', () => {
    const chip = new DisambiguationChip();
    const decision = makeDecision();
    chip.hold("save this", "t-1", decision);
    const res = chip.resolve("save");
    expect(res).not.toBeNull();
    expect(res!.action).toBe("save");
    expect(res!.text).toBe("save this");
    expect(res!.turnId).toBe("t-1");
    expect(res!.originalDecision).toBe(decision);
    expect(chip.isShowing()).toBe(false);
  });

  it('resolve("ask") clears pending and returns resolution', () => {
    const chip = new DisambiguationChip();
    chip.hold("what is this?", "t-2", makeDecision());
    const res = chip.resolve("ask");
    expect(res!.action).toBe("ask");
    expect(chip.isShowing()).toBe(false);
  });

  it("resolve returns null when not showing", () => {
    const chip = new DisambiguationChip();
    expect(chip.resolve("save")).toBeNull();
    expect(chip.resolve("ask")).toBeNull();
  });

  // ── cancel ───────────────────────────────────────────────────────────

  it("cancel clears pending and returns cancellation metadata", () => {
    const chip = new DisambiguationChip();
    const decision = makeDecision();
    chip.hold("save this", "t-3", decision);
    const cancelled = chip.cancel();
    expect(cancelled).not.toBeNull();
    expect(cancelled!.turnId).toBe("t-3");
    expect(cancelled!.originalDecision).toBe(decision);
    expect(chip.isShowing()).toBe(false);
  });

  it("cancel returns null when not showing", () => {
    const chip = new DisambiguationChip();
    expect(chip.cancel()).toBeNull();
  });

  // ── enqueue / drainQueue ──────────────────────────────────────────────

  it("enqueue stores messages submitted while chip is showing", () => {
    const chip = new DisambiguationChip();
    chip.hold("first", "t-1", makeDecision());
    chip.enqueue("second");
    chip.enqueue("third");
    expect(chip.drainQueue()).toEqual(["second", "third"]);
  });

  it("drainQueue empties the queue", () => {
    const chip = new DisambiguationChip();
    chip.enqueue("msg");
    chip.drainQueue();
    expect(chip.drainQueue()).toEqual([]);
  });

  it("queued messages survive resolve", () => {
    const chip = new DisambiguationChip();
    chip.hold("first", "t-1", makeDecision());
    chip.enqueue("queued");
    chip.resolve("save");
    expect(chip.drainQueue()).toEqual(["queued"]);
  });

  it("queued messages survive cancel", () => {
    const chip = new DisambiguationChip();
    chip.hold("first", "t-1", makeDecision());
    chip.enqueue("queued");
    chip.cancel();
    expect(chip.drainQueue()).toEqual(["queued"]);
  });

  // ── Accessors when not showing ────────────────────────────────────────

  it("rationale returns empty string when not showing", () => {
    expect(new DisambiguationChip().rationale).toBe("");
  });

  it("pendingTurnId returns null when not showing", () => {
    expect(new DisambiguationChip().pendingTurnId).toBeNull();
  });

  it("originalLabel returns null when not showing", () => {
    expect(new DisambiguationChip().originalLabel).toBeNull();
  });

  it("originalConfidence returns 0 when not showing", () => {
    expect(new DisambiguationChip().originalConfidence).toBe(0);
  });

  // ── rationale falls back when output is null ──────────────────────────

  it("rationale returns empty string when decision has no output", () => {
    const chip = new DisambiguationChip();
    chip.hold("msg", "t-1", makeDecision({ output: null }));
    expect(chip.rationale).toBe("");
  });
});
