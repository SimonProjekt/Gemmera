import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_DECISION_DDL,
  CLASSIFIER_DISAMBIGUATION_DDL,
  CLASSIFIER_DDL,
  InMemoryClassifierEventWriter,
  toDecisionRow,
  toDisambiguationRow,
} from "./classifier-events";

// ─── DDL validation ────────────────────────────────────────────────────

describe("classifier DDL", () => {
  it("classifier_decision DDL references the expected columns", () => {
    expect(CLASSIFIER_DECISION_DDL).toContain("CREATE TABLE IF NOT EXISTS classifier_decision");
    for (const col of [
      "turn_id",
      "ts",
      "source",
      "skip_reason",
      "prompt_version",
      "input_json",
      "output_json",
      "latency_ms",
      "confidence",
      "label",
    ]) {
      expect(CLASSIFIER_DECISION_DDL).toContain(col);
    }
  });

  it("classifier_disambiguation DDL references the expected columns", () => {
    expect(CLASSIFIER_DISAMBIGUATION_DDL).toContain(
      "CREATE TABLE IF NOT EXISTS classifier_disambiguation",
    );
    for (const col of [
      "turn_id",
      "ts",
      "original_label",
      "original_confidence",
      "chosen_label",
      "cancelled",
    ]) {
      expect(CLASSIFIER_DISAMBIGUATION_DDL).toContain(col);
    }
  });

  it("classifier_disambiguation original_label and original_confidence are nullable", () => {
    // Fallback decisions (no model output) must still be writable with
    // null on the original-side. Asserting via the absence of NOT NULL
    // on those two columns guards against an accidental tightening.
    const lines = CLASSIFIER_DISAMBIGUATION_DDL.split("\n");
    const labelLine = lines.find((l) => /\boriginal_label\b/.test(l));
    const confLine = lines.find((l) => /\boriginal_confidence\b/.test(l));
    expect(labelLine).toBeDefined();
    expect(confLine).toBeDefined();
    expect(labelLine).not.toContain("NOT NULL");
    expect(confLine).not.toContain("NOT NULL");
  });

  it("CLASSIFIER_DDL is ordered (decision before disambiguation)", () => {
    expect(CLASSIFIER_DDL).toHaveLength(2);
    expect(CLASSIFIER_DDL[0]).toContain("classifier_decision");
    expect(CLASSIFIER_DDL[1]).toContain("classifier_disambiguation");
  });
});

// ─── InMemoryClassifierEventWriter ─────────────────────────────────────

describe("InMemoryClassifierEventWriter", () => {
  it("stores a decision row and retrieves it in insertion order", async () => {
    const writer = new InMemoryClassifierEventWriter();
    await writer.writeDecision({
      turn_id: "t1",
      ts: 1000,
      source: "llm",
      skip_reason: null,
      prompt_version: "0.1.0",
      input_json: '{"messageText":"hello"}',
      output_json: '{"label":"ask","confidence":0.9,"rationale":"..."}',
      latency_ms: 42,
      confidence: 0.9,
      label: "ask",
    });

    expect(writer.decisions).toHaveLength(1);
    expect(writer.decisions[0].turn_id).toBe("t1");
    expect(writer.decisions[0].source).toBe("llm");
    expect(writer.decisions[0].label).toBe("ask");
  });

  it("preserves insertion order for multiple decisions", async () => {
    const writer = new InMemoryClassifierEventWriter();
    await writer.writeDecision(makeDecision("t1"));
    await writer.writeDecision(makeDecision("t2"));
    await writer.writeDecision(makeDecision("t3"));

    expect(writer.decisions.map((d) => d.turn_id)).toEqual(["t1", "t2", "t3"]);
  });

  it("stores disambiguation rows with chosen_label", async () => {
    const writer = new InMemoryClassifierEventWriter();
    await writer.writeDisambiguation({
      turn_id: "t1",
      ts: 2000,
      original_label: "ask",
      original_confidence: 0.55,
      chosen_label: "capture",
      cancelled: false,
    });

    expect(writer.disambiguations).toHaveLength(1);
    expect(writer.disambiguations[0].original_label).toBe("ask");
    expect(writer.disambiguations[0].chosen_label).toBe("capture");
    expect(writer.disambiguations[0].cancelled).toBe(false);
  });

  it("stores a cancelled disambiguation", async () => {
    const writer = new InMemoryClassifierEventWriter();
    await writer.writeDisambiguation({
      turn_id: "t1",
      ts: 2000,
      original_label: "mixed",
      original_confidence: 0.45,
      chosen_label: null,
      cancelled: true,
    });

    expect(writer.disambiguations[0].chosen_label).toBeNull();
    expect(writer.disambiguations[0].cancelled).toBe(true);
  });

  it("clear() empties both arrays", async () => {
    const writer = new InMemoryClassifierEventWriter();
    await writer.writeDecision(makeDecision("t1"));
    await writer.writeDisambiguation({
      turn_id: "t1",
      ts: 2000,
      original_label: "ask",
      original_confidence: 0.5,
      chosen_label: "capture",
      cancelled: false,
    });

    writer.clear();
    expect(writer.decisions).toHaveLength(0);
    expect(writer.disambiguations).toHaveLength(0);
  });
});

// ─── Row helpers ───────────────────────────────────────────────────────

describe("toDecisionRow", () => {
  it("flattens a ClassifierDecision into a row with JSON-serialised fields", () => {
    const row = toDecisionRow("turn-1", {
      source: "llm",
      skipReason: null,
      promptVersion: "0.1.0",
      latencyMs: 55,
      input: { messageText: "hello", truncated: false, attachments: [], activeFile: null, recentTurns: [] },
      output: { label: "ask", confidence: 0.92, rationale: "question" },
      confidence: 0.92,
      label: "ask",
    });

    expect(row.turn_id).toBe("turn-1");
    expect(typeof row.ts).toBe("number");
    expect(row.source).toBe("llm");
    expect(row.skip_reason).toBeNull();
    expect(row.prompt_version).toBe("0.1.0");
    expect(row.latency_ms).toBe(55);
    expect(row.confidence).toBe(0.92);
    expect(row.label).toBe("ask");

    const parsedInput = JSON.parse(row.input_json);
    expect(parsedInput.messageText).toBe("hello");

    const parsedOutput = JSON.parse(row.output_json!);
    expect(parsedOutput.label).toBe("ask");
  });

  it("handles skip-path decisions with null output", () => {
    const row = toDecisionRow("turn-2", {
      source: "skip",
      skipReason: "command-capture",
      promptVersion: "0.1.0",
      latencyMs: 0,
      input: { messageText: "", truncated: false, attachments: [], activeFile: null, recentTurns: [] },
      output: null,
      confidence: null,
      label: "capture",
    });

    expect(row.source).toBe("skip");
    expect(row.skip_reason).toBe("command-capture");
    expect(row.output_json).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.label).toBe("capture");
  });
});

describe("toDisambiguationRow", () => {
  it("builds a row from a disambiguation event", () => {
    const row = toDisambiguationRow("turn-1", {
      originalLabel: "ask",
      originalConfidence: 0.52,
      chosenLabel: "capture",
      cancelled: false,
    });

    expect(row.turn_id).toBe("turn-1");
    expect(typeof row.ts).toBe("number");
    expect(row.original_label).toBe("ask");
    expect(row.original_confidence).toBe(0.52);
    expect(row.chosen_label).toBe("capture");
    expect(row.cancelled).toBe(false);
  });

  it("preserves null originalLabel and originalConfidence for fallback decisions", () => {
    // The chip fires on classifier fallbacks (timeout / unparseable / etc.)
    // where the model emitted no usable output. Those rows must store null
    // on the original-side so eval queries can distinguish "model said X →
    // user corrected" from "no model output → user picked something".
    const row = toDisambiguationRow("turn-fallback", {
      originalLabel: null,
      originalConfidence: null,
      chosenLabel: "capture",
      cancelled: false,
    });

    expect(row.original_label).toBeNull();
    expect(row.original_confidence).toBeNull();
    expect(row.chosen_label).toBe("capture");
  });
});

// ─── helpers ───────────────────────────────────────────────────────────

function makeDecision(turnId: string) {
  return {
    turn_id: turnId,
    ts: Date.now(),
    source: "llm" as const,
    skip_reason: null,
    prompt_version: "0.1.0",
    input_json: "{}",
    output_json: null,
    latency_ms: 10,
    confidence: null,
    label: null,
  };
}
