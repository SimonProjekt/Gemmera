import { describe, expect, it } from "vitest";
import {
  lastRecentTurns,
  prepareClassifierInput,
  truncateMessage,
} from "./classifier-utils";

// ─── truncateMessage ──────────────────────────────────────────────────

describe("truncateMessage", () => {
  it("returns the original text and truncated=false when under the limit", () => {
    const result = truncateMessage("hello", 8192);
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  it("truncates at the exact byte limit and appends the marker", () => {
    const text = "a".repeat(9000);
    const result = truncateMessage(text, 8192);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.text).toContain("[message truncated]");
  });

  it("respects UTF-8 multibyte character boundaries", () => {
    // "é" is 2 bytes in UTF-8. Place one right at the boundary.
    const prefix = "a".repeat(8190); // 8190 bytes
    const text = prefix + "é" + "bbbb"; // 8190 + 2 + 4 = 8196 bytes
    const result = truncateMessage(text, 8192);

    expect(result.truncated).toBe(true);
    const encoded = new TextEncoder().encode(result.text);
    // The "é" at position 8190-8191 would push 8193, so it should be cut
    // and the truncation marker should fit within 8192.
    expect(encoded.byteLength).toBeLessThanOrEqual(8192);
  });

  it("delivers only the marker when the limit is smaller than the marker itself", () => {
    // Text (30 chars) exceeds limit (10 bytes), and the marker (~23 bytes)
    // leaves no room for content — contentLimit becomes negative.
    const result = truncateMessage("this text is way too long for 10 bytes", 10);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain("message truncated");
  });

  it("handles exactly-at-limit text as no-op", () => {
    const text = "a".repeat(8192);
    const result = truncateMessage(text, 8192);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  it("handles one byte over the limit", () => {
    const text = "a".repeat(8193);
    const result = truncateMessage(text, 8192);
    expect(result.truncated).toBe(true);
  });

  it("truncates empty string correctly", () => {
    const result = truncateMessage("", 8192);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("");
  });

  it("preserves leading/trailing content before the marker", () => {
    const text = "start " + "x".repeat(9000) + " end";
    const result = truncateMessage(text, 8192);
    expect(result.text.startsWith("start ")).toBe(true);
    expect(result.text).toContain("[message truncated]");
  });
});

// ─── lastRecentTurns ──────────────────────────────────────────────────

describe("lastRecentTurns", () => {
  const turn = (text: string) => ({ text, intent: "ask" as const });

  it("returns all turns when fewer than 3", () => {
    const turns = [turn("a"), turn("b")];
    expect(lastRecentTurns(turns)).toHaveLength(2);
    expect(lastRecentTurns(turns)[0].text).toBe("a");
  });

  it("returns the last 3 when more than 3", () => {
    const turns = [turn("1"), turn("2"), turn("3"), turn("4"), turn("5")];
    const result = lastRecentTurns(turns);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.text)).toEqual(["3", "4", "5"]);
  });

  it("returns all 3 exactly when precisely 3", () => {
    const turns = [turn("x"), turn("y"), turn("z")];
    expect(lastRecentTurns(turns)).toHaveLength(3);
  });

  it("returns an empty array for empty input", () => {
    expect(lastRecentTurns([])).toEqual([]);
  });

  it("does not mutate the original array", () => {
    const turns = [turn("1"), turn("2"), turn("3"), turn("4")];
    const copy = [...turns];
    lastRecentTurns(turns);
    expect(turns).toEqual(copy);
  });
});

// ─── prepareClassifierInput ───────────────────────────────────────────

describe("prepareClassifierInput", () => {
  it("composes truncation + recent-turns slice into a ClassifierInput", () => {
    const input = prepareClassifierInput({
      messageText: "hello world",
      attachments: [{ kind: "pdf", filename: "doc.pdf" }],
      activeFile: { filename: "note.md", title: "my note" },
      recentTurns: [
        { text: "t1", intent: "ask" },
        { text: "t2", intent: "capture" },
        { text: "t3", intent: "ask" },
        { text: "t4", intent: "meta" },
      ],
    });

    expect(input.messageText).toBe("hello world");
    expect(input.truncated).toBe(false);
    expect(input.attachments).toHaveLength(1);
    expect(input.activeFile?.title).toBe("my note");
    expect(input.recentTurns).toHaveLength(3);
    expect(input.recentTurns[0].text).toBe("t2");
  });

  it("flags truncated when the message exceeds 8 KB", () => {
    const longText = "x".repeat(9000);
    const input = prepareClassifierInput({
      messageText: longText,
      attachments: [],
      activeFile: null,
      recentTurns: [],
    });

    expect(input.truncated).toBe(true);
    expect(input.messageText).toContain("[message truncated]");
  });
});
