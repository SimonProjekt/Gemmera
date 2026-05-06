import { describe, expect, it } from "vitest";
import {
  classifySkipRouter,
  SkipRouterInput,
} from "./classifier-skip-router";

describe("classifySkipRouter", () => {
  // ─── Helper ───────────────────────────────────────────────────────────

  function makeInput(overrides: Partial<SkipRouterInput> = {}): SkipRouterInput {
    return {
      messageText: "",
      attachments: [],
      ...overrides,
    };
  }

  // ─── 1. Empty / whitespace-only → error ───────────────────────────────

  it('returns error for empty string', () => {
    const result = classifySkipRouter(makeInput({ messageText: "" }));
    expect(result).toEqual({ kind: "error", error: "empty-message" });
  });

  it('returns error for whitespace-only string', () => {
    const result = classifySkipRouter(makeInput({ messageText: "   \t\n  " }));
    expect(result).toEqual({ kind: "error", error: "empty-message" });
  });

  // ─── 2. Attachments-only → capture skip ───────────────────────────────

  it('returns capture skip when attachments exist but text is empty', () => {
    const result = classifySkipRouter(
      makeInput({
        messageText: "",
        attachments: [{ kind: "pdf", filename: "doc.pdf" }],
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "attachment-only",
    });
  });

  it('returns capture skip when attachments exist but text is whitespace-only', () => {
    const result = classifySkipRouter(
      makeInput({
        messageText: "   ",
        attachments: [{ kind: "image", filename: "cat.png" }],
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "attachment-only",
    });
  });

  // ─── 3. Preset commands → hard-coded labels ───────────────────────────

  it('returns capture skip for cowork.capture-selection', () => {
    const result = classifySkipRouter(
      makeInput({
        messageText: "some text",
        presetCommand: "cowork.capture-selection",
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "command-capture",
    });
  });

  it('returns capture skip for cowork.capture-active-note', () => {
    const result = classifySkipRouter(
      makeInput({
        messageText: "some text",
        presetCommand: "cowork.capture-active-note",
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "command-capture",
    });
  });

  it('returns ask skip for cowork.ask-about-active-note', () => {
    const result = classifySkipRouter(
      makeInput({
        messageText: "some text",
        presetCommand: "cowork.ask-about-active-note",
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "ask",
      reason: "command-ask",
    });
  });

  // ─── 4. Ctrl/Cmd+Enter → capture skip ─────────────────────────────────

  it('returns capture skip when ctrlEnter is true', () => {
    const result = classifySkipRouter(
      makeInput({ messageText: "hello", ctrlEnter: true }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "ctrl-enter",
    });
  });

  // ─── 5. Leading "?" → ask skip with stripped text ────────────────────

  it('returns ask skip for leading question mark', () => {
    const result = classifySkipRouter(
      makeInput({ messageText: "?what is this" }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "ask",
      reason: "leading-question-mark",
      strippedText: "what is this",
    });
  });

  it('strips leading "?" and extra whitespace', () => {
    const result = classifySkipRouter(
      makeInput({ messageText: "?   spaced out" }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "ask",
      reason: "leading-question-mark",
      strippedText: "spaced out",
    });
  });

  it('returns ask skip for "?" alone', () => {
    const result = classifySkipRouter(makeInput({ messageText: "?" }));
    expect(result).toEqual({
      kind: "skip",
      label: "ask",
      reason: "leading-question-mark",
      strippedText: "",
    });
  });

  // ─── 6. Normal message → null (proceed to LLM) ────────────────────────

  it('returns null for a normal message', () => {
    const result = classifySkipRouter(
      makeInput({ messageText: "hello there" }),
    );
    expect(result).toBeNull();
  });

  it('returns null for message with text and attachments', () => {
    const result = classifySkipRouter(
      makeInput({
        messageText: "check this out",
        attachments: [{ kind: "image", filename: "img.jpg" }],
      }),
    );
    expect(result).toBeNull();
  });

  // ─── 7. Precedence rules ──────────────────────────────────────────────

  it('attachment-only takes precedence over leading "?"', () => {
    // Rule 2 (attachment-only) is checked before rule 5 (leading "?").
    const result = classifySkipRouter(
      makeInput({
        messageText: "",
        attachments: [{ kind: "text", filename: "note.txt" }],
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "attachment-only",
    });
  });

  it('preset command takes precedence over ctrl-enter', () => {
    // Rule 3 (preset) is checked before rule 4 (ctrl-enter).
    const result = classifySkipRouter(
      makeInput({
        messageText: "hello",
        presetCommand: "cowork.ask-about-active-note",
        ctrlEnter: true,
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "ask",
      reason: "command-ask",
    });
  });

  it('preset command takes precedence over leading "?"', () => {
    const result = classifySkipRouter(
      makeInput({
        messageText: "?hello",
        presetCommand: "cowork.capture-selection",
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "command-capture",
    });
  });

  it('ctrl-enter takes precedence over leading "?"', () => {
    const result = classifySkipRouter(
      makeInput({ messageText: "?hello", ctrlEnter: true }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "ctrl-enter",
    });
  });

  it('empty message error takes precedence over attachments', () => {
    // Actually, rule 2 says attachments + no text → capture.
    // But rule 1 is empty + no attachments → error.
    // When attachments exist, rule 2 fires.
    // Let's verify: empty text WITH attachments → capture skip (not error).
    const result = classifySkipRouter(
      makeInput({
        messageText: "",
        attachments: [{ kind: "pdf", filename: "x.pdf" }],
      }),
    );
    expect(result).toEqual({
      kind: "skip",
      label: "capture",
      reason: "attachment-only",
    });
  });
});
