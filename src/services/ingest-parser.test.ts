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
