import { describe, expect, it } from "vitest";
import { InMemoryEventLog } from "./event-log";
import { RetryBudget } from "./retry-policy";
import { runQuery, type QueryOrchestratorDeps, type QueryInput } from "./query-orchestrator";
import type {
  ChatOptions,
  LLMReachability,
  LLMResponse,
  LLMService,
  PayloadAssembler,
  PayloadChunk,
  RetrievalHit,
  RetrievalPayload,
  Retriever,
} from "../contracts";

// ── Test doubles ─────────────────────────────────────────────────────────────

class StubRetriever implements Retriever {
  constructor(private readonly hits: RetrievalHit[] = []) {}
  async retrieve(): Promise<RetrievalHit[]> {
    return this.hits;
  }
}

class SpyRetriever implements Retriever {
  readonly calls: Array<{ query: string; topK: number | undefined }> = [];
  constructor(private readonly hits: RetrievalHit[] = []) {}
  async retrieve(query: string, opts?: { topK?: number }): Promise<RetrievalHit[]> {
    this.calls.push({ query, topK: opts?.topK });
    return this.hits;
  }
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
  async pickDefaultModel(): Promise<string> { return "test-model"; }
}

class StubAssembler implements PayloadAssembler {
  constructor(private readonly chunks: PayloadChunk[]) {}
  assemble(query: string): RetrievalPayload {
    return { query, chunks: this.chunks };
  }
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeHit(path: string, text: string): RetrievalHit {
  return {
    path,
    title: path.replace(/\.md$/, "").split("/").pop() ?? path,
    ord: 0,
    contentHash: `hash-${path}`,
    text,
    headingPath: [],
    score: 1,
    winningSignal: "semantic",
  };
}

function makeChunk(path: string): PayloadChunk {
  return {
    path,
    title: path.replace(/\.md$/, "").split("/").pop() ?? path,
    headingPath: [],
    text: `Content of ${path}`,
    whyMatched: "semantic",
  };
}

function validReply(answer: string, citations: string[]): string {
  return JSON.stringify({ answer, citations });
}

function setup(opts: {
  hits?: RetrievalHit[];
  chunks?: PayloadChunk[];
  llmReplies?: string[];
  reranker?: Retriever;
  withEventLog?: true;
}): { deps: QueryOrchestratorDeps; eventLog: InMemoryEventLog | undefined } {
  const hits = opts.hits ?? [makeHit("Notes/a.md", "Some content")];
  const chunks = opts.chunks ?? [makeChunk("Notes/a.md")];
  const eventLog = opts.withEventLog ? new InMemoryEventLog() : undefined;
  const deps: QueryOrchestratorDeps = {
    retriever: new StubRetriever(hits),
    assembler: new StubAssembler(chunks),
    llm: new SequenceLLM(opts.llmReplies ?? [validReply("The answer.", ["Notes/a.md"])]),
    reranker: opts.reranker,
    eventLog,
    turnId: "turn-1",
    model: "test-model",
  };
  return { deps, eventLog };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runQuery", () => {
  it("happy path: retrieve, assemble, generate, validate, present", async () => {
    const { deps } = setup({});
    const result = await runQuery({ query: "What is Gemmera?" }, deps);
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.answer).toBe("The answer.");
    expect(result.citations).toEqual(["Notes/a.md"]);
  });

  it("returns empty when retriever produces no hits", async () => {
    const { deps } = setup({ hits: [], llmReplies: ["irrelevant"] });
    const result = await runQuery({ query: "anything" }, deps);
    expect(result.kind).toBe("empty");
  });

  it("citation retry: invalid citation on first try, valid on retry", async () => {
    const { deps } = setup({
      llmReplies: [
        // First GENERATE: cites a path not in the payload
        validReply("First answer.", ["Notes/a.md", "Notes/ghost.md"]),
        // RETRY: corrected, only cites valid path
        validReply("Revised answer.", ["Notes/a.md"]),
      ],
    });
    const result = await runQuery({ query: "query" }, deps);
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.answer).toBe("Revised answer.");
    expect(result.citations).toEqual(["Notes/a.md"]);
  });

  it("citation retry exhausted: invalid on both tries → validation_failed", async () => {
    const { deps } = setup({
      llmReplies: [
        validReply("First answer.", ["Notes/a.md", "Notes/ghost.md"]),
        validReply("Retry answer.", ["Notes/b.md"]), // b.md also not in payload
      ],
    });
    const result = await runQuery({ query: "query" }, deps);
    expect(result.kind).toBe("validation_failed");
  });

  it("GENERATE invalid JSON → failed", async () => {
    const { deps } = setup({ llmReplies: ["not json at all"] });
    const result = await runQuery({ query: "query" }, deps);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.reason).toBe("generate:invalid_json");
  });

  it("zero citations in response are valid (no cited notes)", async () => {
    const { deps } = setup({ llmReplies: [validReply("General answer.", [])] });
    const result = await runQuery({ query: "query" }, deps);
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.citations).toEqual([]);
  });

  it("multiple valid citations all pass", async () => {
    const { deps } = setup({
      hits: [makeHit("a.md", "text"), makeHit("b.md", "text"), makeHit("c.md", "text")],
      chunks: [makeChunk("a.md"), makeChunk("b.md"), makeChunk("c.md")],
      llmReplies: [validReply("Multi-source answer.", ["a.md", "b.md"])],
    });
    const result = await runQuery({ query: "query" }, deps);
    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.citations).toEqual(["a.md", "b.md"]);
  });

  it("reranker is used when provided", async () => {
    const rerankedHit = makeHit("Reranked/note.md", "Reranked content");
    const reranker = new StubRetriever([rerankedHit]);
    const { deps } = setup({
      reranker,
      chunks: [makeChunk("Reranked/note.md")],
      llmReplies: [validReply("Reranked answer.", ["Reranked/note.md"])],
    });
    const result = await runQuery({ query: "query" }, deps);
    expect(result.kind).toBe("answered");
  });

  it("reranker failure is skipped, raw hits used", async () => {
    const throwingReranker: Retriever = {
      async retrieve(): Promise<RetrievalHit[]> {
        throw new Error("reranker offline");
      },
    };
    const { deps } = setup({
      reranker: throwingReranker,
      llmReplies: [validReply("Fallback answer.", ["Notes/a.md"])],
    });
    // Should not propagate the reranker error
    const result = await runQuery({ query: "query" }, deps);
    expect(result.kind).toBe("answered");
  });

  it("event log records state sequence for happy path", async () => {
    const { deps, eventLog } = setup({ withEventLog: true });
    await runQuery({ query: "query" }, deps);
    const events = await eventLog!.eventsFor("turn-1");
    const states = events.filter((e) => e.kind === "enter").map((e) => e.state);
    expect(states).toEqual([
      "PLAN_RETRIEVAL",
      "RETRIEVE",
      "RERANK",
      "ASSEMBLE_CONTEXT",
      "GENERATE",
      "VALIDATE_CITATIONS",
      "PRESENT",
      "DONE",
    ]);
  });

  it("event log records citation retry path", async () => {
    const { deps, eventLog } = setup({
      withEventLog: true,
      llmReplies: [
        validReply("First.", ["Notes/a.md", "Notes/ghost.md"]),
        validReply("Revised.", ["Notes/a.md"]),
      ],
    });
    await runQuery({ query: "query" }, deps);
    const events = await eventLog!.eventsFor("turn-1");
    const states = events.filter((e) => e.kind === "enter").map((e) => e.state);
    expect(states).toContain("VALIDATE_CITATIONS");
    expect(states).toContain("RETRY_WITH_CONSTRAINED_CITATIONS");
    expect(states[states.length - 1]).toBe("DONE");
  });

  it("event log records VALIDATION_FAILED when retry also fails", async () => {
    const { deps, eventLog } = setup({
      withEventLog: true,
      llmReplies: [
        validReply("First.", ["Notes/ghost.md"]),
        validReply("Retry.", ["Notes/ghost2.md"]),
      ],
    });
    await runQuery({ query: "query" }, deps);
    const events = await eventLog!.eventsFor("turn-1");
    const states = events.filter((e) => e.kind === "enter").map((e) => e.state);
    expect(states).toContain("RETRY_WITH_CONSTRAINED_CITATIONS");
    expect(states[states.length - 1]).toBe("VALIDATION_FAILED");
  });

  // Invariant for #14: vault-tagged turns must never bypass retrieval. The
  // event-log assertion alone could pass if an orchestrator logged the state
  // without calling the retriever, so this spy guards against that drift.
  it("retrieval invariant: retriever.retrieve is called with the user query", async () => {
    const spy = new SpyRetriever([makeHit("Notes/a.md", "x")]);
    const eventLog = new InMemoryEventLog();
    const deps: QueryOrchestratorDeps = {
      retriever: spy,
      assembler: new StubAssembler([makeChunk("Notes/a.md")]),
      llm: new SequenceLLM([validReply("A.", ["Notes/a.md"])]),
      eventLog,
      turnId: "turn-1",
      model: "test-model",
    };
    await runQuery({ query: "What is X?" }, deps);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.query).toBe("What is X?");
    const events = await eventLog.eventsFor("turn-1");
    expect(events.some((e) => e.kind === "enter" && e.state === "RETRIEVE")).toBe(true);
  });

  it("empty retrieval event log goes PLAN_RETRIEVAL → RETRIEVE → PRESENT → DONE", async () => {
    const { deps, eventLog } = setup({ hits: [], withEventLog: true });
    await runQuery({ query: "query" }, deps);
    const events = await eventLog!.eventsFor("turn-1");
    const states = events.filter((e) => e.kind === "enter").map((e) => e.state);
    expect(states).toEqual(["PLAN_RETRIEVAL", "RETRIEVE", "PRESENT", "DONE"]);
  });
});

// ── Retry policy (#51) ────────────────────────────────────────────────────────

class FailThenSucceedRetriever implements Retriever {
  private calls = 0;
  constructor(private readonly failCount: number, private readonly hits: RetrievalHit[]) {}
  async retrieve(): Promise<RetrievalHit[]> {
    if (this.calls++ < this.failCount) throw new Error("embedding failed");
    return this.hits;
  }
}

describe("runQuery — retry policy (#51)", () => {
  it("invalid JSON → 1 budget retry → succeeds", async () => {
    const { deps } = setup({
      llmReplies: ["not json", validReply("ok", ["Notes/a.md"])],
    });
    const budget = new RetryBudget(3);
    deps.retryBudget = budget;

    const outcome = await runQuery({ query: "q" }, deps);
    expect(outcome.kind).toBe("answered");
    expect(budget.count).toBe(1);
  });

  it("invalid JSON on both attempts → failed", async () => {
    const { deps } = setup({ llmReplies: ["not json"] });
    deps.retryBudget = new RetryBudget(3);

    const outcome = await runQuery({ query: "q" }, deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("generate:invalid_json");
  });

  it("hallucinated citations → budget retry → succeeds with valid citations", async () => {
    const { deps } = setup({
      llmReplies: [
        validReply("First.", ["Notes/ghost.md"]),          // invalid citation
        validReply("Fixed.", ["Notes/a.md"]),              // valid
      ],
    });
    deps.retryBudget = new RetryBudget(3);

    const outcome = await runQuery({ query: "q" }, deps);
    expect(outcome.kind).toBe("answered");
    if (outcome.kind !== "answered") return;
    expect(outcome.citations).toEqual(["Notes/a.md"]);
  });

  it("hallucinated citations + budget exhausted → validation_failed without retry", async () => {
    const { deps } = setup({
      llmReplies: [validReply("First.", ["Notes/ghost.md"])],
    });
    deps.retryBudget = new RetryBudget(0);

    const outcome = await runQuery({ query: "q" }, deps);
    expect(outcome.kind).toBe("validation_failed");
  });

  it("embedding fail → 1 infra retry after 250 ms → succeeds (no budget consumed)", async () => {
    const { deps } = setup({ llmReplies: [validReply("ok", ["Notes/a.md"])] });
    const budget = new RetryBudget(3);
    deps.retryBudget = budget;
    deps.retriever = new FailThenSucceedRetriever(1, [makeHit("Notes/a.md", "text")]);

    const outcome = await runQuery({ query: "q" }, deps);
    expect(outcome.kind).toBe("answered");
    expect(budget.count).toBe(0); // infra retries don't consume budget
  });

  it("retriever fails twice → TOOL_FAILED", async () => {
    const { deps } = setup({ llmReplies: [] });
    deps.retriever = new FailThenSucceedRetriever(99, []);

    const outcome = await runQuery({ query: "q" }, deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toMatch(/retrieve:/);
  });

  it("reranker fail → 0 retries, falls back to raw hits, still answers", async () => {
    const failingReranker: Retriever = {
      async retrieve(): Promise<RetrievalHit[]> { throw new Error("reranker down"); },
    };
    const { deps } = setup({ llmReplies: [validReply("ok", ["Notes/a.md"])] });
    deps.reranker = failingReranker;

    const outcome = await runQuery({ query: "q" }, deps);
    expect(outcome.kind).toBe("answered");
  });
});
