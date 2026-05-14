import { describe, expect, it } from "vitest";
import { buildMessageDecoration } from "./message-decoration";
import type { RouteDecision, ClassifierDecision } from "./contracts/classifier";

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeDecision(overrides: Partial<ClassifierDecision> = {}): ClassifierDecision {
  return {
    source: "llm",
    input: { messageText: "save this", truncated: false, attachments: [], activeFile: null, recentTurns: [] },
    output: { label: "capture", confidence: 0.91, rationale: "User wants to save content." },
    latencyMs: 110,
    promptVersion: "0.1.0",
    skipReason: null,
    needsDisambiguation: false,
    fallbackReason: null,
    ...overrides,
  };
}

function makeRoute(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    turnId: "t-1",
    label: "capture",
    decision: makeDecision(),
    needsDisambiguation: false,
    shortCircuit: false,
    ...overrides,
  };
}

// ── Silent mode (devMode = false) ─────────────────────────────────────────

describe("buildMessageDecoration — silent mode", () => {
  it("snapshot: confident capture, silent saves on", () => {
    const result = buildMessageDecoration(makeRoute(), false, false);
    expect(result).toMatchInlineSnapshot(`
      {
        "badge": null,
        "silentSave": true,
        "tooltip": null,
      }
    `);
  });

  it("snapshot: confident capture, always-preview on", () => {
    const result = buildMessageDecoration(makeRoute(), false, true);
    expect(result).toMatchInlineSnapshot(`
      {
        "badge": null,
        "silentSave": false,
        "tooltip": null,
      }
    `);
  });

  it("snapshot: confident ask — no badge, no silent save", () => {
    const result = buildMessageDecoration(makeRoute({ label: "ask", decision: makeDecision({ output: { label: "ask", confidence: 0.85, rationale: "User is asking." } }) }), false, false);
    expect(result).toMatchInlineSnapshot(`
      {
        "badge": null,
        "silentSave": false,
        "tooltip": null,
      }
    `);
  });

  it("no route → all null", () => {
    expect(buildMessageDecoration(null, false, false)).toMatchInlineSnapshot(`
      {
        "badge": null,
        "silentSave": false,
        "tooltip": null,
      }
    `);
  });

  it("needsDisambiguation suppresses silentSave even for capture", () => {
    const result = buildMessageDecoration(makeRoute({ needsDisambiguation: true }), false, false);
    expect(result.silentSave).toBe(false);
  });
});

// ── Dev mode (devMode = true) ─────────────────────────────────────────────

describe("buildMessageDecoration — dev mode", () => {
  it("snapshot: confident capture in dev mode", () => {
    const result = buildMessageDecoration(makeRoute(), true, false);
    expect(result).toMatchInlineSnapshot(`
      {
        "badge": "capture · 0.91",
        "silentSave": true,
        "tooltip": "User wants to save content.",
      }
    `);
  });

  it("snapshot: confident ask in dev mode", () => {
    const route = makeRoute({
      label: "ask",
      decision: makeDecision({ output: { label: "ask", confidence: 0.85, rationale: "User is asking a question." } }),
    });
    const result = buildMessageDecoration(route, true, false);
    expect(result).toMatchInlineSnapshot(`
      {
        "badge": "ask · 0.85",
        "silentSave": false,
        "tooltip": "User is asking a question.",
      }
    `);
  });

  it("snapshot: skip-path decision in dev mode", () => {
    const route = makeRoute({
      label: "ask",
      decision: makeDecision({
        source: "skip",
        skipReason: "leading-question-mark",
        output: null,
      }),
    });
    const result = buildMessageDecoration(route, true, false);
    expect(result).toMatchInlineSnapshot(`
      {
        "badge": "ask · skip",
        "silentSave": false,
        "tooltip": "leading-question-mark",
      }
    `);
  });

  it("snapshot: LLM fallback (null output) in dev mode", () => {
    const route = makeRoute({
      label: "ask",
      needsDisambiguation: true,
      decision: makeDecision({ output: null, fallbackReason: "timeout" }),
    });
    const result = buildMessageDecoration(route, true, false);
    expect(result).toMatchInlineSnapshot(`
      {
        "badge": "ask · fallback",
        "silentSave": false,
        "tooltip": null,
      }
    `);
  });

  it("badge confidence uses 2 decimal places", () => {
    const route = makeRoute({ decision: makeDecision({ output: { label: "capture", confidence: 0.9, rationale: "" } }) });
    expect(buildMessageDecoration(route, true, false).badge).toBe("capture · 0.90");
  });

  it("null rationale on output produces null tooltip", () => {
    const route = makeRoute({ decision: makeDecision({ output: { label: "capture", confidence: 0.91, rationale: "" } }) });
    expect(buildMessageDecoration(route, true, false).tooltip).toBeNull();
  });
});
