import { describe, expect, it } from "vitest";
import {
  STATE_LABELS,
  formatInspectorEntries,
  labelForState,
} from "./turn-status";

describe("STATE_LABELS", () => {
  it("covers all ingest states", () => {
    const ingestStates = [
      "PARSE_CONTENT",
      "SEARCH_SIMILAR",
      "DECIDE_STRATEGY",
      "PREVIEW",
      "WRITE",
      "UPDATE_INDEX",
    ];
    for (const s of ingestStates) {
      expect(STATE_LABELS).toHaveProperty(s);
      expect(typeof STATE_LABELS[s]).toBe("string");
    }
  });

  it("covers all query states", () => {
    const queryStates = [
      "PLAN_RETRIEVAL",
      "RETRIEVE",
      "RERANK",
      "ASSEMBLE_CONTEXT",
      "GENERATE",
      "VALIDATE_CITATIONS",
      "RETRY_WITH_CONSTRAINED_CITATIONS",
      "PRESENT",
    ];
    for (const s of queryStates) {
      expect(STATE_LABELS).toHaveProperty(s);
      expect(typeof STATE_LABELS[s]).toBe("string");
    }
  });

  it("covers shared and terminal states", () => {
    const shared = ["CLASSIFY_INTENT"];
    const terminal = [
      "DONE",
      "CANCELLED",
      "TIMED_OUT",
      "MODEL_INVALID_OUTPUT",
      "TOOL_FAILED",
      "VALIDATION_FAILED",
    ];
    for (const s of [...shared, ...terminal]) {
      expect(STATE_LABELS).toHaveProperty(s);
    }
  });

  it("all labels are non-empty strings", () => {
    for (const [state, label] of Object.entries(STATE_LABELS)) {
      expect(label, `label for ${state} must be non-empty`).not.toBe("");
    }
  });
});

describe("labelForState", () => {
  it("returns the mapped label for a known state", () => {
    expect(labelForState("GENERATE")).toBe("Generating answer…");
    expect(labelForState("DONE")).toBe("Done");
  });

  it("falls back to the raw state name for unknown states", () => {
    expect(labelForState("SOME_FUTURE_STATE")).toBe("SOME_FUTURE_STATE");
    expect(labelForState("")).toBe("");
  });
});

describe("formatInspectorEntries", () => {
  const base = {
    state: "GENERATE",
    fromState: "ASSEMBLE_CONTEXT" as string | null,
    timestamp: 1_700_000_000_000,
    triggeringEvent: null as { payload?: unknown } | null,
  };

  it("keeps only enter entries", () => {
    const entries = [
      { kind: "enter", ...base },
      { kind: "exit", ...base },
      { kind: "enter", ...base, state: "PRESENT" },
    ];
    const result = formatInspectorEntries(entries);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.state !== undefined)).toBe(true);
  });

  it("maps state to label", () => {
    const result = formatInspectorEntries([{ kind: "enter", ...base }]);
    expect(result[0].label).toBe("Generating answer…");
  });

  it("preserves fromState and timestamp", () => {
    const result = formatInspectorEntries([{ kind: "enter", ...base }]);
    expect(result[0].fromState).toBe("ASSEMBLE_CONTEXT");
    expect(result[0].timestamp).toBe(1_700_000_000_000);
  });

  it("formats timestamp as ISO string", () => {
    const result = formatInspectorEntries([{ kind: "enter", ...base }]);
    expect(result[0].time).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("sets payloadPreview to null when no payload", () => {
    const result = formatInspectorEntries([{ kind: "enter", ...base }]);
    expect(result[0].payloadPreview).toBeNull();
  });

  it("sets payloadPreview to null when triggeringEvent is null", () => {
    const result = formatInspectorEntries([
      { kind: "enter", ...base, triggeringEvent: null },
    ]);
    expect(result[0].payloadPreview).toBeNull();
  });

  it("serialises small payloads verbatim", () => {
    const result = formatInspectorEntries([
      {
        kind: "enter",
        ...base,
        triggeringEvent: { payload: { answer: 42 } },
      },
    ]);
    expect(result[0].payloadPreview).toBe('{"answer":42}');
  });

  it("truncates large payloads to 120 chars with ellipsis", () => {
    const big = { x: "a".repeat(200) };
    const result = formatInspectorEntries([
      { kind: "enter", ...base, triggeringEvent: { payload: big } },
    ]);
    expect(result[0].payloadPreview).toHaveLength(120);
    expect(result[0].payloadPreview?.endsWith("…")).toBe(true);
  });

  it("returns an empty array for an empty input", () => {
    expect(formatInspectorEntries([])).toEqual([]);
  });

  it("returns empty for input with only exit entries", () => {
    expect(
      formatInspectorEntries([{ kind: "exit", ...base }]),
    ).toEqual([]);
  });
});
