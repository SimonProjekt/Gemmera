import { describe, expect, it } from "vitest";
import type {
  ChatOptions,
  LLMReachability,
  LLMResponse,
  LLMService,
  LoadedPrompt,
  PromptLoader,
} from "../contracts";
import { parseContent } from "./ingest-parser";
import { RetryBudget } from "./retry-policy";

class StaticLLM implements LLMService {
  constructor(public reply: string) {}
  async chat(_opts: ChatOptions): Promise<LLMResponse> {
    return { content: this.reply };
  }
  async isReachable(): Promise<LLMReachability> {
    return "running";
  }
  async listModels(): Promise<string[]> { return ["mock"]; }
  async pickDefaultModel(): Promise<string> { return "mock"; }
}

const stubPromptLoader: PromptLoader = {
  async load(): Promise<LoadedPrompt> {
    return { id: "ingest-parser", version: "0.1.0", body: "stub-prompt" };
  },
  invalidate() {},
};

describe("parseContent", () => {
  it("returns a NoteSpec for valid LLM JSON", async () => {
    const llm = new StaticLLM(
      JSON.stringify({
        title: "Q2 standup",
        type: "meeting",
        tags: ["q2"],
        aliases: [],
        source: "chat-paste",
        entities: ["Alice"],
        related: [],
        status: "inbox",
        summary: "Decisions from standup.",
        key_points: ["Switch to v2"],
        body_markdown: "# Decisions\n\nWe ship v2.",
        confidence: "high",
      }),
    );
    const result = await parseContent("Q2 standup notes", undefined, {
      llm,
      promptLoader: stubPromptLoader,
      runId: () => "test-run",
      model: "test-model",
      version: "0.0.1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.title).toBe("Q2 standup");
    expect(result.spec.cowork.run_id).toBe("test-run");
    expect(result.spec.cowork.source).toBe("ingest");
  });

  it("returns parse_failed on invalid JSON", async () => {
    const llm = new StaticLLM("not json at all");
    const result = await parseContent("anything", undefined, {
      llm,
      promptLoader: stubPromptLoader,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("parse_failed");
  });

  it("returns schema_failed on missing required fields", async () => {
    const llm = new StaticLLM(JSON.stringify({ title: "ok" }));
    const result = await parseContent("anything", undefined, {
      llm,
      promptLoader: stubPromptLoader,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("schema_failed");
  });

  it("rejects bodies that contain frontmatter blocks", async () => {
    const llm = new StaticLLM(
      JSON.stringify({
        title: "x",
        type: "source",
        body_markdown: "---\nhijack: yes\n---\n\nbad",
      }),
    );
    const result = await parseContent("anything", undefined, {
      llm,
      promptLoader: stubPromptLoader,
    });
    expect(result.ok).toBe(false);
  });

  it("returns empty for whitespace-only input without calling LLM", async () => {
    let called = false;
    const llm = {
      async chat() {
        called = true;
        return { content: "" };
      },
      async isReachable(): Promise<LLMReachability> { return "running"; },
      async listModels() { return []; },
      async pickDefaultModel() { return "mock"; },
    } as LLMService;
    const result = await parseContent("   \n  ", undefined, {
      llm,
      promptLoader: stubPromptLoader,
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

// ── Retry policy (#51) ────────────────────────────────────────────────────────

function validSpecJson(): string {
  return JSON.stringify({
    title: "Test note",
    type: "meeting",
    tags: [],
    aliases: [],
    source: "chat-paste",
    entities: [],
    related: [],
    status: "inbox",
    summary: "A test note.",
    key_points: [],
    body_markdown: "# Test\n\nContent.",
    confidence: "high",
  });
}

class SequenceLLM implements LLMService {
  private calls = 0;
  constructor(private readonly replies: string[]) {}
  async chat(_opts: ChatOptions): Promise<LLMResponse> {
    const reply = this.replies[this.calls] ?? this.replies[this.replies.length - 1];
    this.calls++;
    return { content: reply };
  }
  async isReachable(): Promise<LLMReachability> { return "running"; }
  async listModels(): Promise<string[]> { return []; }
  async pickDefaultModel(): Promise<string> { return "mock"; }
}

class FailThenSucceedLLM implements LLMService {
  private calls = 0;
  constructor(private readonly failCount: number, private readonly successReply: string) {}
  async chat(_opts: ChatOptions): Promise<LLMResponse> {
    if (this.calls++ < this.failCount) throw new Error("connection refused");
    return { content: this.successReply };
  }
  async isReachable(): Promise<LLMReachability> { return "running"; }
  async listModels(): Promise<string[]> { return []; }
  async pickDefaultModel(): Promise<string> { return "mock"; }
}

describe("parseContent — retry policy (#51)", () => {
  it("invalid JSON → 1 retry → succeeds on second call", async () => {
    const llm = new SequenceLLM(["not json", validSpecJson()]);
    const budget = new RetryBudget(3);
    const result = await parseContent("test", undefined, { llm, promptLoader: stubPromptLoader }, undefined, budget);
    expect(result.ok).toBe(true);
    expect(budget.count).toBe(1);
  });

  it("invalid JSON on both attempts → parse_failed", async () => {
    const llm = new SequenceLLM(["not json"]);
    const budget = new RetryBudget(3);
    const result = await parseContent("test", undefined, { llm, promptLoader: stubPromptLoader }, undefined, budget);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("parse_failed");
  });

  it("schema-valid JSON but missing required fields → 1 feedback retry → succeeds", async () => {
    const llm = new SequenceLLM([
      JSON.stringify({ title: "ok" }), // schema_failed — missing type and body_markdown
      validSpecJson(),
    ]);
    const budget = new RetryBudget(3);
    const result = await parseContent("test", undefined, { llm, promptLoader: stubPromptLoader }, undefined, budget);
    expect(result.ok).toBe(true);
    expect(budget.count).toBe(1);
  });

  it("schema fails on both attempts → schema_failed", async () => {
    const llm = new SequenceLLM([JSON.stringify({ title: "ok" })]);
    const budget = new RetryBudget(3);
    const result = await parseContent("test", undefined, { llm, promptLoader: stubPromptLoader }, undefined, budget);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("schema_failed");
  });

  it("budget exhausted before any retry → parse_failed without retrying", async () => {
    let callCount = 0;
    const llm: LLMService = {
      async chat(): Promise<LLMResponse> { callCount++; return { content: "not json" }; },
      async isReachable(): Promise<LLMReachability> { return "running"; },
      async listModels(): Promise<string[]> { return []; },
      async pickDefaultModel(): Promise<string> { return "mock"; },
    };
    const budget = new RetryBudget(0);
    const result = await parseContent("test", undefined, { llm, promptLoader: stubPromptLoader }, undefined, budget);
    expect(result.ok).toBe(false);
    expect(callCount).toBe(1); // no retry attempted
  });

  it("Ollama connection refused → 1 infra retry → succeeds (does not consume budget)", async () => {
    const llm = new FailThenSucceedLLM(1, validSpecJson());
    const budget = new RetryBudget(3);
    const result = await parseContent("test", undefined, { llm, promptLoader: stubPromptLoader }, undefined, budget);
    expect(result.ok).toBe(true);
    expect(budget.count).toBe(0); // infra retries don't count against budget
  });
});
