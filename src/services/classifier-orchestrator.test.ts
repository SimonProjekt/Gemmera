import { describe, expect, it } from "vitest";
import { classifyTurn, ClassifyTurnInput, ClassifyTurnDeps } from "./classifier-orchestrator";
import { ClassifierInput, ClassifierThresholds, DEFAULT_CLASSIFIER_THRESHOLDS, RouteDecision, IntentLabel } from "../contracts/classifier";
import { LLMService, LLMResponse } from "../contracts/llm";
import { LoadedPrompt, PromptLoader } from "../contracts/prompts";
import { InMemoryClassifierEventWriter } from "./classifier-events";
import { ClassifierError } from "./classifier-llm";
import { META_HELP_RESPONSE } from "./help-content";

// ─── Test helpers ──────────────────────────────────────────────────────

const TEST_PROMPT: LoadedPrompt = {
  id: "intent-classifier",
  version: "0.1.0",
  body: `{{messageText}}\n{{attachmentList}}\n{{activeFileLine}}\n{{recentTurnList}}`,
};

function makePromptLoader(prompt: LoadedPrompt = TEST_PROMPT): PromptLoader {
  return { load: async () => prompt, invalidate: () => {} };
}

function makeInput(overrides: Partial<ClassifyTurnInput> = {}): ClassifyTurnInput {
  return {
    messageText: "Save this note about project alpha",
    attachments: [],
    activeFile: null,
    recentTurns: [],
    ...overrides,
  };
}

function validJson(label = "capture", confidence = 0.9, rationale = "Test rationale.") {
  return JSON.stringify({ label, confidence, rationale });
}

function makeJsonLLM(content: string, throwErr?: Error): LLMService {
  return {
    chat: async (opts) => {
      expect(opts.format).toBe("json");
      expect(opts.stream).toBe(false);
      if (throwErr) throw throwErr;
      return { content } as LLMResponse;
    },
    isReachable: async () => "running",
    listModels: async () => ["gemma3:latest"],
    pickDefaultModel: async () => "gemma3:latest",
  };
}

function makeDeps(
  overrides: Partial<ClassifyTurnDeps> = {},
): ClassifyTurnDeps {
  return {
    llm: makeJsonLLM(validJson()),
    promptLoader: makePromptLoader(),
    eventWriter: new InMemoryClassifierEventWriter(),
    ...overrides,
  };
}

// ─── Skip router path ──────────────────────────────────────────────────

describe("classifyTurn — skip router", () => {
  it("returns error for empty message with no attachments", async () => {
    const deps = makeDeps();
    const result = await classifyTurn(
      { messageText: "", attachments: [], activeFile: null, recentTurns: [] },
      deps,
      "turn-1",
    );
    expect(result.label).toBeNull();
    expect(result.decision.source).toBe("skip");
    expect(result.needsDisambiguation).toBe(false);
    expect(result.shortCircuit).toBe(false);
  });

  it("skips to capture for attachment-only messages", async () => {
    const deps = makeDeps();
    const result = await classifyTurn(
      { messageText: "", attachments: [{ kind: "image", filename: "photo.png" }], activeFile: null, recentTurns: [] },
      deps,
      "turn-2",
    );
    expect(result.label).toBe("capture");
    expect(result.decision.source).toBe("skip");
    expect(result.decision.skipReason).toBe("attachment-only");
    expect(result.decision.output?.confidence).toBe(1.0);
    expect(result.needsDisambiguation).toBe(false);
    expect(result.shortCircuit).toBe(false);
  });

  it("skips to capture for capture-selection command", async () => {
    const deps = makeDeps();
    const result = await classifyTurn(
      { messageText: "selected text", attachments: [], activeFile: null, recentTurns: [], presetCommand: "cowork.capture-selection" },
      deps,
      "turn-3",
    );
    expect(result.label).toBe("capture");
    expect(result.decision.source).toBe("skip");
    expect(result.decision.skipReason).toBe("command-capture");
  });

  it("skips to capture for capture-active-note command", async () => {
    const deps = makeDeps();
    const result = await classifyTurn(
      { messageText: "active note", attachments: [], activeFile: null, recentTurns: [], presetCommand: "cowork.capture-active-note" },
      deps,
      "turn-4",
    );
    expect(result.label).toBe("capture");
    expect(result.decision.skipReason).toBe("command-capture");
  });

  it("skips to ask for ask-about-active-note command", async () => {
    const deps = makeDeps();
    const result = await classifyTurn(
      { messageText: "summarize this", attachments: [], activeFile: null, recentTurns: [], presetCommand: "cowork.ask-about-active-note" },
      deps,
      "turn-5",
    );
    expect(result.label).toBe("ask");
    expect(result.decision.source).toBe("skip");
    expect(result.decision.skipReason).toBe("command-ask");
  });

  it("skips to capture for Ctrl+Enter", async () => {
    const deps = makeDeps();
    const result = await classifyTurn(
      { messageText: "some content", attachments: [], activeFile: null, recentTurns: [], ctrlEnter: true },
      deps,
      "turn-6",
    );
    expect(result.label).toBe("capture");
    expect(result.decision.skipReason).toBe("ctrl-enter");
  });

  it("skips to ask for leading ? and strips the marker", async () => {
    const deps = makeDeps();
    const result = await classifyTurn(
      { messageText: "?what is the project status", attachments: [], activeFile: null, recentTurns: [] },
      deps,
      "turn-7",
    );
    expect(result.label).toBe("ask");
    expect(result.decision.skipReason).toBe("leading-question-mark");
    // Input should have the stripped text (no leading ?)
    expect(result.decision.input.messageText).toBe("what is the project status");
  });

  it("writes a decision event for skip paths", async () => {
    const writer = new InMemoryClassifierEventWriter();
    const deps = makeDeps({ eventWriter: writer });
    await classifyTurn(
      { messageText: "", attachments: [{ kind: "pdf", filename: "doc.pdf" }], activeFile: null, recentTurns: [] },
      deps,
      "turn-write",
    );
    expect(writer.decisions).toHaveLength(1);
    expect(writer.decisions[0].source).toBe("skip");
    expect(writer.decisions[0].turn_id).toBe("turn-write");
    expect(writer.decisions[0].skip_reason).toBe("attachment-only");
  });
});

// ─── LLM path — happy ──────────────────────────────────────────────────

describe("classifyTurn — LLM happy path", () => {
  it("classifies capture with high confidence", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("capture", 0.9)) });
    const result = await classifyTurn(makeInput({ messageText: "Save this note" }), deps, "turn-10");
    expect(result.label).toBe("capture");
    expect(result.decision.source).toBe("llm");
    expect(result.decision.output?.label).toBe("capture");
    expect(result.decision.output?.confidence).toBe(0.9);
    expect(result.needsDisambiguation).toBe(false);
    expect(result.shortCircuit).toBe(false);
  });

  it("classifies ask with high confidence", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("ask", 0.95)) });
    const result = await classifyTurn(makeInput({ messageText: "What are the key points?" }), deps, "turn-11");
    expect(result.label).toBe("ask");
    expect(result.decision.source).toBe("llm");
    expect(result.needsDisambiguation).toBe(false);
  });

  it("classifies mixed with high confidence", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("mixed", 0.88)) });
    const result = await classifyTurn(makeInput({ messageText: "Save this and tell me about related notes" }), deps, "turn-12");
    expect(result.label).toBe("mixed");
    expect(result.needsDisambiguation).toBe(false);
  });

  it("classifies meta with high confidence and short-circuits with help", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("meta", 0.85)) });
    const result = await classifyTurn(makeInput({ messageText: "help" }), deps, "turn-13");
    expect(result.label).toBe("meta");
    expect(result.shortCircuit).toBe(true);
    expect(result.helpResponse).toBe(META_HELP_RESPONSE);
    expect(result.needsDisambiguation).toBe(false);
  });

  it("sets needsDisambiguation when confidence is below threshold", async () => {
    // capture threshold is 0.85, confidence 0.84 should trigger
    const deps = makeDeps({ llm: makeJsonLLM(validJson("capture", 0.84)) });
    const result = await classifyTurn(makeInput(), deps, "turn-14");
    expect(result.label).toBe("capture");
    expect(result.needsDisambiguation).toBe(true);
    expect(result.decision.needsDisambiguation).toBe(true);
  });

  it("ask threshold is lower than capture (0.70 vs 0.85)", async () => {
    // ask threshold is 0.70, confidence 0.75 should be confident
    const deps = makeDeps({ llm: makeJsonLLM(validJson("ask", 0.75)) });
    const result = await classifyTurn(makeInput(), deps, "turn-15");
    expect(result.label).toBe("ask");
    expect(result.needsDisambiguation).toBe(false);
  });

  it("capture at exactly threshold is confident", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("capture", 0.85)) });
    const result = await classifyTurn(makeInput(), deps, "turn-16");
    expect(result.needsDisambiguation).toBe(false);
  });

  it("uses custom thresholds when provided", async () => {
    const customThresholds: ClassifierThresholds = { capture: 0.95, ask: 0.80, mixed: 0.85, meta: 0.80 };
    const deps = makeDeps({
      llm: makeJsonLLM(validJson("capture", 0.94)),
      thresholds: customThresholds,
    });
    const result = await classifyTurn(makeInput(), deps, "turn-17");
    expect(result.needsDisambiguation).toBe(true); // 0.94 < 0.95
  });

  it("tags the decision with the prompt version", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson()) });
    const result = await classifyTurn(makeInput(), deps, "turn-18");
    expect(result.decision.promptVersion).toBe("0.1.0");
  });

  it("writes a decision event for LLM paths", async () => {
    const writer = new InMemoryClassifierEventWriter();
    const deps = makeDeps({ llm: makeJsonLLM(validJson("ask", 0.9)), eventWriter: writer });
    await classifyTurn(makeInput(), deps, "turn-19");
    expect(writer.decisions).toHaveLength(1);
    expect(writer.decisions[0].source).toBe("llm");
    expect(writer.decisions[0].turn_id).toBe("turn-19");
    expect(writer.decisions[0].label).toBe("ask");
    expect(writer.decisions[0].confidence).toBe(0.9);
  });
});

// ─── LLM path — fallback ───────────────────────────────────────────────

describe("classifyTurn — LLM fallback", () => {
  it("routes to ask on timeout fallback", async () => {
    const error = new ClassifierError("timed out", "timeout", undefined, "0.1.0");
    const deps = makeDeps({ llm: makeJsonLLM("", error) });
    const result = await classifyTurn(makeInput(), deps, "turn-20");
    expect(result.label).toBe("ask");
    expect(result.decision.fallbackReason).toBe("timeout");
    expect(result.needsDisambiguation).toBe(true);
  });

  it("routes to ask on unparseable fallback", async () => {
    const error = new ClassifierError("invalid json", "unparseable", "{bad", "0.1.0");
    const deps = makeDeps({ llm: makeJsonLLM("", error) });
    const result = await classifyTurn(makeInput(), deps, "turn-21");
    expect(result.label).toBe("ask");
    expect(result.decision.fallbackReason).toBe("unparseable");
    expect(result.needsDisambiguation).toBe(true);
  });

  it("routes to ask on invalid-label fallback", async () => {
    const error = new ClassifierError("bad label", "invalid-label", '{"label":"unknown"}', "0.1.0");
    const deps = makeDeps({ llm: makeJsonLLM("", error) });
    const result = await classifyTurn(makeInput(), deps, "turn-22");
    expect(result.label).toBe("ask");
    expect(result.decision.fallbackReason).toBe("invalid-label");
  });

  it("routes to ask on invalid-confidence fallback", async () => {
    const error = new ClassifierError("bad range", "invalid-confidence", '{"label":"capture","confidence":2}', "0.1.0");
    const deps = makeDeps({ llm: makeJsonLLM("", error) });
    const result = await classifyTurn(makeInput(), deps, "turn-23");
    expect(result.label).toBe("ask");
    expect(result.decision.fallbackReason).toBe("invalid-confidence");
  });

  it("re-throws transport errors", async () => {
    const error = new ClassifierError("connection refused", "transport", undefined, "0.1.0");
    const deps = makeDeps({ llm: makeJsonLLM("", error) });
    await expect(
      classifyTurn(makeInput(), deps, "turn-24"),
    ).rejects.toThrow("connection refused");
  });

  it("writes a decision event on fallback", async () => {
    const writer = new InMemoryClassifierEventWriter();
    const error = new ClassifierError("timed out", "timeout", undefined, "0.1.0");
    const deps = makeDeps({ llm: makeJsonLLM("", error), eventWriter: writer });
    await classifyTurn(makeInput(), deps, "turn-fallback");
    expect(writer.decisions).toHaveLength(1);
    expect(writer.decisions[0].source).toBe("llm");
    expect(writer.decisions[0].label).toBeNull();
    expect(writer.decisions[0].confidence).toBeNull();
  });
});

// ─── Mixed intent (acceptance criterion) ───────────────────────────────

describe("classifyTurn — mixed intent", () => {
  it("returns mixed label for mixed intent (caller dispatches ingest→query)", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("mixed", 0.88)) });
    const result = await classifyTurn(
      makeInput({ messageText: "Log this idea and find similar notes" }),
      deps,
      "turn-30",
    );
    expect(result.label).toBe("mixed");
    // The orchestrator returns the mixed label; the turn router / tool
    // loop is responsible for running ingest then query in sequence.
    expect(result.shortCircuit).toBe(false);
    expect(result.needsDisambiguation).toBe(false);
  });
});

// ─── Meta short-circuit (acceptance criterion) ──────────────────────────

describe("classifyTurn — meta short-circuit", () => {
  it("short-circuits with help response for meta intent", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("meta", 0.90)) });
    const result = await classifyTurn(makeInput({ messageText: "what can you do" }), deps, "turn-40");
    expect(result.label).toBe("meta");
    expect(result.shortCircuit).toBe(true);
    expect(result.helpResponse).toBeDefined();
    expect(result.helpResponse!.length).toBeGreaterThan(0);
  });

  it("does not short-circuit for non-meta labels", async () => {
    const labels: IntentLabel[] = ["capture", "ask", "mixed"];
    for (const label of labels) {
      const deps = makeDeps({ llm: makeJsonLLM(validJson(label, 0.95)) });
      const result = await classifyTurn(makeInput(), deps, `turn-meta-${label}`);
      expect(result.shortCircuit).toBe(false);
      expect(result.helpResponse).toBeUndefined();
    }
  });
});

// ─── Turn record attachment (acceptance criterion) ─────────────────────

describe("classifyTurn — turn record attachment", () => {
  it("attaches the full decision to the route for the turn inspector", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("ask", 0.78)) });
    const result = await classifyTurn(makeInput({ messageText: "find meeting notes" }), deps, "turn-50");

    // The decision is attached to the route so the inspector can read it.
    expect(result.decision).toBeDefined();
    expect(result.decision.source).toBe("llm");
    expect(result.decision.input.messageText).toBe("find meeting notes");
    expect(result.decision.output?.label).toBe("ask");
    expect(result.decision.output?.confidence).toBe(0.78);
    expect(result.decision.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.decision.promptVersion).toBe("0.1.0");
  });

  it("turnId is threaded through the route decision", async () => {
    const deps = makeDeps();
    const result = await classifyTurn(makeInput(), deps, "my-turn-id");
    expect(result.turnId).toBe("my-turn-id");
  });

  it("decision row written for downstream inspector consumption", async () => {
    const writer = new InMemoryClassifierEventWriter();
    const deps = makeDeps({ llm: makeJsonLLM(validJson("capture", 0.91)), eventWriter: writer });
    await classifyTurn(makeInput({ messageText: "save meeting log" }), deps, "turn-52");

    expect(writer.decisions).toHaveLength(1);
    const row = writer.decisions[0];
    expect(row.turn_id).toBe("turn-52");
    expect(row.source).toBe("llm");
    expect(row.label).toBe("capture");
    expect(row.confidence).toBe(0.91);
    // input_json / output_json are serialised for DuckDB storage.
    const parsedInput = JSON.parse(row.input_json);
    expect(parsedInput.messageText).toBe("save meeting log");
    const parsedOutput = JSON.parse(row.output_json!);
    expect(parsedOutput.label).toBe("capture");
  });
});

// ─── Preset command + leading-? input fidelity ─────────────────────────

describe("classifyTurn — input fidelity", () => {
  it("preserves attachments in the decision input", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson()) });
    const result = await classifyTurn(
      makeInput({
        messageText: "Save these",
        attachments: [{ kind: "pdf", filename: "report.pdf" }, { kind: "image", filename: "chart.png" }],
      }),
      deps,
      "turn-60",
    );
    expect(result.decision.input.attachments).toHaveLength(2);
    expect(result.decision.input.attachments[0].filename).toBe("report.pdf");
  });

  it("preserves active file in the decision input", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson()) });
    const result = await classifyTurn(
      makeInput({ activeFile: { filename: "projects.md", title: "Projects" } }),
      deps,
      "turn-61",
    );
    expect(result.decision.input.activeFile?.filename).toBe("projects.md");
  });

  it("slices recent turns to last 3", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson()) });
    const recent = [
      { text: "turn 1", intent: "capture" as const },
      { text: "turn 2", intent: "ask" as const },
      { text: "turn 3", intent: "ask" as const },
      { text: "turn 4", intent: "capture" as const },
    ];
    const result = await classifyTurn(makeInput({ recentTurns: recent }), deps, "turn-62");
    expect(result.decision.input.recentTurns).toHaveLength(3);
    expect(result.decision.input.recentTurns[0].text).toBe("turn 2");
  });
});

// ─── Event writer integration ──────────────────────────────────────────

describe("classifyTurn — event writer integration", () => {
  it("writes one decision row per classification", async () => {
    const writer = new InMemoryClassifierEventWriter();
    const deps = makeDeps({ eventWriter: writer, llm: makeJsonLLM(validJson()) });

    await classifyTurn(makeInput({ messageText: "first" }), deps, "turn-a");
    await classifyTurn(makeInput({ messageText: "second" }), deps, "turn-b");
    await classifyTurn(
      { messageText: "", attachments: [{ kind: "text", filename: "note.txt" }], activeFile: null, recentTurns: [] },
      deps,
      "turn-c",
    );

    expect(writer.decisions).toHaveLength(3);
    expect(writer.decisions.map((d) => d.turn_id)).toEqual(["turn-a", "turn-b", "turn-c"]);
    expect(writer.decisions[0].source).toBe("llm");
    expect(writer.decisions[1].source).toBe("llm");
    expect(writer.decisions[2].source).toBe("skip");
  });
});

// ─── Integration: full pipeline ────────────────────────────────────────

describe("classifyTurn — full pipeline integration", () => {
  it("prefers skip router over LLM when both could match", async () => {
    // Leading "?" takes precedence — no LLM call made.
    let llmCalled = false;
    const llm: LLMService = {
      chat: async () => { llmCalled = true; return { content: validJson() } as LLMResponse; },
      isReachable: async () => "running",
      listModels: async () => ["gemma3:latest"],
      pickDefaultModel: async () => "gemma3:latest",
    };
    const deps = makeDeps({ llm });
    const result = await classifyTurn(
      { messageText: "?what is this", attachments: [], activeFile: null, recentTurns: [] },
      deps,
      "turn-skip-first",
    );
    expect(result.label).toBe("ask");
    expect(result.decision.source).toBe("skip");
    expect(llmCalled).toBe(false);
  });

  it("falls through to LLM when skip router returns null", async () => {
    const deps = makeDeps({ llm: makeJsonLLM(validJson("ask", 0.95)) });
    const result = await classifyTurn(makeInput({ messageText: "no skip triggers here" }), deps, "turn-fallthrough");
    expect(result.decision.source).toBe("llm");
    expect(result.label).toBe("ask");
  });
});
