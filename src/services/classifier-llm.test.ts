import { describe, expect, it } from "vitest";
import {
  classifyWithLLM,
  ClassifierCallDeps,
  ClassifierError,
} from "./classifier-llm";
import { ClassifierInput } from "../contracts/classifier";
import { LLMService } from "../contracts/llm";
import { LoadedPrompt, PromptLoader } from "../contracts/prompts";

const TEST_PROMPT: LoadedPrompt = {
  id: "intent-classifier",
  version: "0.1.0",
  body: `
# Intent Classifier v0.1.0
Classify the user message.

{{messageText}}
{{attachmentList}}
{{activeFileLine}}
{{recentTurnList}}
`,
};

function makeMockPromptLoader(prompt: LoadedPrompt = TEST_PROMPT): PromptLoader {
  return {
    load: async () => prompt,
    invalidate: () => {},
  };
}

function makeInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    messageText: "Save this as meeting notes",
    truncated: false,
    attachments: [],
    activeFile: null,
    recentTurns: [],
    ...overrides,
  };
}

interface MockResponse {
  content?: string;
  delayMs?: number;
  throwError?: Error;
}

function makeMockLLM(responses: MockResponse[]): LLMService {
  let callCount = 0;
  return {
    chat: async (opts) => {
      const resp = responses[callCount++];
      if (!resp) throw new Error("Unexpected extra LLM call");
      if (resp.throwError) throw resp.throwError;

      // Respect abort signal for timeout tests.
      function abortError(): Error {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return err;
      }

      if (opts.signal?.aborted) {
        throw abortError();
      }

      if (resp.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, resp.delayMs);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(abortError());
          });
        });
      }

      // Verify classifier-specific options are passed.
      expect(opts.format).toBe("json");
      expect(opts.stream).toBe(false);
      expect(opts.model).toBe("gemma3:latest");

      return { content: resp.content ?? "" };
    },
    isReachable: async () => "running",
    listModels: async () => ["gemma3:latest"],
    pickDefaultModel: async () => "gemma3:latest",
  };
}

describe("classifyWithLLM", () => {
  // ─── Happy path ───────────────────────────────────────────────────────

  it("returns parsed output on valid JSON response", async () => {
    const llm = makeMockLLM([
      {
        content: JSON.stringify({
          label: "capture",
          confidence: 0.92,
          rationale: "User wants to save content.",
        }),
      },
    ]);

    const result = await classifyWithLLM(makeInput(), {
      llm,
      promptLoader: makeMockPromptLoader(),
    });

    expect(result.output).toEqual({
      label: "capture",
      confidence: 0.92,
      rationale: "User wants to save content.",
    });
    expect(result.promptVersion).toBe("0.1.0");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("works for each valid label", async () => {
    const labels = ["capture", "ask", "mixed", "meta"] as const;
    for (const label of labels) {
      const llm = makeMockLLM([
        {
          content: JSON.stringify({
            label,
            confidence: 0.8,
            rationale: "Test rationale.",
          }),
        },
      ]);

      const result = await classifyWithLLM(makeInput(), {
        llm,
        promptLoader: makeMockPromptLoader(),
      });

      expect(result.output.label).toBe(label);
    }
  });

  // ─── Parse / validation errors ────────────────────────────────────────

  it("throws unparseable on invalid JSON", async () => {
    const llm = makeMockLLM([{ content: "not json" }]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "unparseable" });
  });

  it("throws invalid-label when label is not in taxonomy", async () => {
    const llm = makeMockLLM([
      {
        content: JSON.stringify({
          label: "unknown",
          confidence: 0.9,
          rationale: "Test.",
        }),
      },
    ]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "invalid-label" });
  });

  it("throws invalid-confidence when confidence is negative", async () => {
    const llm = makeMockLLM([
      {
        content: JSON.stringify({
          label: "capture",
          confidence: -0.1,
          rationale: "Test.",
        }),
      },
    ]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "invalid-confidence" });
  });

  it("throws invalid-confidence when confidence is above 1", async () => {
    const llm = makeMockLLM([
      {
        content: JSON.stringify({
          label: "capture",
          confidence: 1.5,
          rationale: "Test.",
        }),
      },
    ]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "invalid-confidence" });
  });

  it("throws invalid-confidence when confidence is not a number", async () => {
    const llm = makeMockLLM([
      {
        content: JSON.stringify({
          label: "capture",
          confidence: "high",
          rationale: "Test.",
        }),
      },
    ]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "invalid-confidence" });
  });

  it("throws unparseable when rationale is missing", async () => {
    const llm = makeMockLLM([
      {
        content: JSON.stringify({
          label: "capture",
          confidence: 0.9,
        }),
      },
    ]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "unparseable" });
  });

  it("throws unparseable when output is not an object", async () => {
    const llm = makeMockLLM([{ content: JSON.stringify(["capture", 0.9]) }]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "unparseable" });
  });

  // ─── Transport / timeout errors ───────────────────────────────────────

  it("throws transport error when LLM throws a network error", async () => {
    const llm = makeMockLLM([{ throwError: new Error("ECONNREFUSED") }]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "transport" });
  });

  it("throws timeout error when LLM call exceeds 500ms", async () => {
    const llm = makeMockLLM([{ content: "irrelevant", delayMs: 600 }]);

    await expect(
      classifyWithLLM(makeInput(), { llm, promptLoader: makeMockPromptLoader() }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
