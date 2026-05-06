import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import type {
  ChatOptions,
  LLMReachability,
  LLMResponse,
  LLMService,
  LoadedPrompt,
  NoteSpec,
  PromptLoader,
  RetrievalHit,
  Retriever,
} from "../contracts";
import { decideStrategy } from "./ingest-strategy";

function spec(body: string, overrides: Partial<NoteSpec> = {}): NoteSpec {
  return {
    title: "candidate",
    type: "source",
    tags: [],
    aliases: [],
    source: "chat-paste",
    entities: [],
    related: [],
    status: "inbox",
    summary: "",
    key_points: [],
    body_markdown: body,
    cowork: {
      source: "ingest",
      run_id: "r",
      model: "m",
      version: "v",
      confidence: "high",
    },
    ...overrides,
  };
}

class StubRetriever implements Retriever {
  constructor(public hits: RetrievalHit[]) {}
  async retrieve(): Promise<RetrievalHit[]> {
    return this.hits;
  }
}

class CrashingRetriever implements Retriever {
  async retrieve(): Promise<RetrievalHit[]> {
    throw new Error("boom");
  }
}

class StaticLLM implements LLMService {
  constructor(public reply: string) {}
  async chat(_opts: ChatOptions): Promise<LLMResponse> { return { content: this.reply }; }
  async isReachable(): Promise<LLMReachability> { return "running"; }
  async listModels() { return []; }
  async pickDefaultModel() { return "mock"; }
}

const promptLoader: PromptLoader = {
  async load(): Promise<LoadedPrompt> {
    return { id: "dedup-decider", version: "0.1", body: "stub" };
  },
  invalidate() {},
};

function hit(path: string, score: number, text = "snippet"): RetrievalHit {
  return {
    path,
    title: path.replace(/\.md$/, ""),
    ord: 0,
    contentHash: "h",
    text,
    headingPath: [],
    score,
    winningSignal: "semantic",
  };
}

describe("decideStrategy", () => {
  it("short-circuits to dedup_ask on exact-hash content match", async () => {
    const store = new InMemoryIngestionStore();
    const body = "exact body";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    await store.upsert(
      {
        path: "Existing/Note.md",
        contentHash: "x",
        bodyHash,
        mtime: 0,
        frontmatter: null,
      },
      [],
    );

    const result = await decideStrategy(spec(body), {
      llm: new StaticLLM(""),
      promptLoader,
      retriever: new StubRetriever([]),
      store,
    });
    expect(result.strategy.kind).toBe("dedup_ask");
    if (result.strategy.kind !== "dedup_ask") return;
    expect(result.strategy.target).toBe("Existing/Note.md");
  });

  it("returns create when retriever has no hits", async () => {
    const store = new InMemoryIngestionStore();
    const result = await decideStrategy(spec("body"), {
      llm: new StaticLLM(""),
      promptLoader,
      retriever: new StubRetriever([]),
      store,
    });
    expect(result.strategy.kind).toBe("create");
  });

  it("returns dedup_ask when top hit exceeds threshold", async () => {
    const store = new InMemoryIngestionStore();
    const result = await decideStrategy(spec("body"), {
      llm: new StaticLLM(""),
      promptLoader,
      retriever: new StubRetriever([hit("Some/Note.md", 0.95)]),
      store,
      dedupThreshold: 0.85,
    });
    expect(result.strategy.kind).toBe("dedup_ask");
  });

  it("uses LLM decision when below threshold (append branch)", async () => {
    const store = new InMemoryIngestionStore();
    const result = await decideStrategy(spec("body"), {
      llm: new StaticLLM(JSON.stringify({ strategy: "append", targetPath: "Parent.md", reason: "extends it" })),
      promptLoader,
      retriever: new StubRetriever([hit("Parent.md", 0.5)]),
      store,
    });
    expect(result.strategy.kind).toBe("append");
    if (result.strategy.kind !== "append") return;
    expect(result.strategy.target).toBe("Parent.md");
  });

  it("falls back to create with related links when LLM output is malformed", async () => {
    const store = new InMemoryIngestionStore();
    const result = await decideStrategy(spec("body"), {
      llm: new StaticLLM("not json"),
      promptLoader,
      retriever: new StubRetriever([hit("a.md", 0.4), hit("b.md", 0.3)]),
      store,
    });
    expect(result.strategy.kind).toBe("create");
    if (result.strategy.kind !== "create") return;
    expect(result.strategy.related).toEqual(["a.md", "b.md"]);
  });

  it("treats retriever errors as cold vault and returns create", async () => {
    const store = new InMemoryIngestionStore();
    const result = await decideStrategy(spec("body"), {
      llm: new StaticLLM(""),
      promptLoader,
      retriever: new CrashingRetriever(),
      store,
    });
    expect(result.strategy.kind).toBe("create");
  });
});
