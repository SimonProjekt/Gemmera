import { describe, expect, it } from "vitest";
import {
  classifyWithRetries,
  ClassifierRetriedResult,
} from "./classifier-retries";
import { ClassifierInput } from "../contracts/classifier";
import { LLMService, LLMResponse } from "../contracts/llm";
import { LoadedPrompt, PromptLoader } from "../contracts/prompts";
import { ClassifierError } from "./classifier-llm";

const TEST_PROMPT: LoadedPrompt = {
  id: "intent-classifier",
  version: "0.1.0",
  body: `{{messageText}}\n{{attachmentList}}\n{{activeFileLine}}\n{{recentTurnList}}`,
};

function makePromptLoader(prompt: LoadedPrompt = TEST_PROMPT): PromptLoader {
  return { load: async () => prompt, invalidate: () => {} };
}

function makeInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    messageText: "Save this",
    truncated: false,
    attachments: [],
    activeFile: null,
    recentTurns: [],
    ...overrides,
  };
}

/** Mock LLM that returns the given JSON (or throws). Uses format:json, stream:false. */
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

/** Sequence-based mock: each call consumes one entry. */
function makeSeqLLM(
  responses: { content: string; throwErr?: Error }[],
): LLMService {
  let i = 0;
  return {
    chat: async (opts) => {
      expect(opts.format).toBe("json");
      expect(opts.stream).toBe(false);
      const r = responses[i++];
      if (!r) throw new Error("Unexpected extra LLM call");
      if (r.throwErr) throw r.throwErr;
      return { content: r.content } as LLMResponse;
    },
    isReachable: async () => "running",
    listModels: async () => ["gemma3:latest"],
    pickDefaultModel: async () => "gemma3:latest",
  };
}

function validJson(label = "capture", confidence = 0.9) {
  return JSON.stringify({
    label,
    confidence,
    rationale: "Test rationale.",
  });
}

describe("classifyWithRetries", () => {
  // ─── Happy path ───────────────────────────────────────────────────────

  it("returns output on first successful call (no retries)", async () => {
    const result = await classifyWithRetries(makeInput(), {
      llm: makeJsonLLM(validJson()),
      promptLoader: makePromptLoader(),
    });

    expect(result.output).toEqual({
      label: "capture",
      confidence: 0.9,
      rationale: "Test rationale.",
    });
    expect(result.retries).toBe(0);
    expect(result.promptVersion).toBe("0.1.0");
    expect(result.fallbackReason).toBeUndefined();
  });

  // ─── Unparseable → retry → success ────────────────────────────────────

  it("retries once on unparseable and succeeds on second try", async () => {
    const llm = makeSeqLLM([
      { content: "not json" },
      { content: validJson("ask") },
    ]);

    const result = await classifyWithRetries(makeInput(), {
      llm,
      promptLoader: makePromptLoader(),
    });

    expect(result.output?.label).toBe("ask");
    expect(result.retries).toBe(1);
  });

  it("retry latency is measured from first call", async () => {
    const llm = makeSeqLLM([
      { content: "not json" },
      { content: validJson() },
    ]);

    const result = await classifyWithRetries(makeInput(), {
      llm,
      promptLoader: makePromptLoader(),
    });

    expect(result.retries).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Unparseable → retry → fail → fallback ─────────────────────────────

  it("falls back after two unparseable responses", async () => {
    const llm = makeSeqLLM([
      { content: "garbage 1" },
      { content: "garbage 2" },
    ]);

    const result = await classifyWithRetries(makeInput(), {
      llm,
      promptLoader: makePromptLoader(),
    });

    expect(result.output).toBeNull();
    expect(result.retries).toBe(1);
    expect(result.fallbackReason).toBe("unparseable");
    expect(result.rawResponse).toBe("garbage 1");
  });

  it("falls back when retry throws unparseable for invalid-confidence", async () => {
    // First call: unparseable. Retry: invalid-confidence (should still
    // fall back, not re-throw).
    const llm = makeSeqLLM([
      { content: "not json" },
      {
        content: JSON.stringify({
          label: "capture",
          confidence: 99,
          rationale: "x",
        }),
      },
    ]);

    const result = await classifyWithRetries(makeInput(), {
      llm,
      promptLoader: makePromptLoader(),
    });

    expect(result.output).toBeNull();
    expect(result.retries).toBe(1);
    expect(result.fallbackReason).toBe("unparseable");
  });

  // ─── Timeout → fallback (no retry) ────────────────────────────────────

  it("falls back immediately on timeout (no retry)", async () => {
    const err = new ClassifierError("timed out", "timeout", undefined, "0.1.0");
    const llm = makeJsonLLM("", err);

    const result = await classifyWithRetries(makeInput(), {
      llm,
      promptLoader: makePromptLoader(),
    });

    expect(result.output).toBeNull();
    expect(result.retries).toBe(0);
    expect(result.fallbackReason).toBe("timeout");
  });

  // ─── Invalid label / confidence → fallback (no retry) ──────────────────

  it("falls back on invalid label (no retry)", async () => {
    const llm = makeJsonLLM(
      JSON.stringify({ label: "unknown", confidence: 0.8, rationale: "x" }),
    );

    const result = await classifyWithRetries(makeInput(), {
      llm,
      promptLoader: makePromptLoader(),
    });

    expect(result.output).toBeNull();
    expect(result.retries).toBe(0);
    expect(result.fallbackReason).toBe("invalid-label");
    expect(result.rawResponse).toContain("unknown");
  });

  it("falls back on invalid confidence (no retry)", async () => {
    const llm = makeJsonLLM(
      JSON.stringify({ label: "capture", confidence: -1, rationale: "x" }),
    );

    const result = await classifyWithRetries(makeInput(), {
      llm,
      promptLoader: makePromptLoader(),
    });

    expect(result.output).toBeNull();
    expect(result.retries).toBe(0);
    expect(result.fallbackReason).toBe("invalid-confidence");
  });

  // ─── Transport → re-throw (no retry) ───────────────────────────────────

  it("re-throws transport errors immediately (no retry)", async () => {
    const err = new ClassifierError("ECONNREFUSED", "transport");
    const llm = makeJsonLLM("", err);

    await expect(
      classifyWithRetries(makeInput(), {
        llm,
        promptLoader: makePromptLoader(),
      }),
    ).rejects.toMatchObject({ code: "transport" });
  });

  // ─── Prompt version ────────────────────────────────────────────────────

  it("preserves prompt version on success", async () => {
    const result = await classifyWithRetries(makeInput(), {
      llm: makeJsonLLM(validJson()),
      promptLoader: makePromptLoader(),
    });

    expect(result.output).toBeDefined();
    expect(result.promptVersion).toBe("0.1.0");
  });

  it("preserves prompt version on fallback", async () => {
    const err = new ClassifierError("oops", "invalid-label", "raw", "0.1.0");
    const llm = makeJsonLLM("", err);

    const result = await classifyWithRetries(makeInput(), {
      llm,
      promptLoader: makePromptLoader(),
    });

    expect(result.promptVersion).toBe("0.1.0");
  });
});
