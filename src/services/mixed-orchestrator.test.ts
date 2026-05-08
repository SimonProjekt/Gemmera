import { describe, expect, it } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { IngestWriter } from "./ingest-writer";
import { InMemoryEventLog } from "./event-log";
import { runMixed, type MixedOrchestratorDeps, type MixedPhase } from "./mixed-orchestrator";
import type {
  ChatOptions,
  LLMReachability,
  LLMResponse,
  LLMService,
  LoadedPrompt,
  NoteSpec,
  PayloadAssembler,
  PayloadChunk,
  PromptLoader,
  RetrievalHit,
  RetrievalPayload,
  Retriever,
} from "../contracts";
import type { PreviewDecision, PreviewHandler } from "./ingest-orchestrator";

// ── Test doubles ─────────────────────────────────────────────────────────────

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


class StubRetriever implements Retriever {
  constructor(private readonly hits: RetrievalHit[] = []) {}
  async retrieve(): Promise<RetrievalHit[]> { return this.hits; }
}

class StubAssembler implements PayloadAssembler {
  constructor(private readonly chunks: PayloadChunk[] = []) {}
  assemble(query: string): RetrievalPayload { return { query, chunks: this.chunks }; }
}

const promptLoader: PromptLoader = {
  async load(): Promise<LoadedPrompt> {
    return { id: "ingest-parser", version: "0.1", body: "stub" };
  },
  invalidate() {},
};

const confirmPreview: PreviewHandler = async () => ({ action: "confirm" });
const cancelPreview: PreviewHandler = async () => ({ action: "cancel" });

function specReply(overrides: Partial<NoteSpec> = {}): string {
  return JSON.stringify({
    title: "Mixed note",
    type: "meeting",
    tags: [],
    aliases: [],
    source: "chat-paste",
    entities: [],
    related: [],
    status: "inbox",
    summary: "A note.",
    key_points: [],
    body_markdown: "# Mixed\n\nContent.",
    confidence: "high",
    ...overrides,
  });
}

function makeChunk(path: string): PayloadChunk {
  return {
    path,
    title: path,
    text: "chunk text",
    headingPath: [],
    whyMatched: "semantic",
  } as unknown as PayloadChunk;
}

function makeHit(path: string): RetrievalHit {
  return {
    path,
    title: path,
    ord: 0,
    contentHash: `hash-${path}`,
    text: "hit text",
    headingPath: [],
    score: 0.2, // below LLM_FLOOR_SCORE (0.3) so decideStrategy skips the LLM call
    winningSignal: "semantic",
  };
}

function setup(opts: {
  llmReplies: string[];
  preview?: PreviewHandler;
  retrieverHits?: RetrievalHit[];
  chunks?: PayloadChunk[];
}): MixedOrchestratorDeps & { eventLog: InMemoryEventLog } {
  const vault = new MockVaultService({});
  const store = new InMemoryIngestionStore();
  const queue = new InMemoryJobQueue();
  const writer = new IngestWriter(vault);
  const eventLog = new InMemoryEventLog();
  const hits = opts.retrieverHits ?? [makeHit("note.md")];
  const chunks = opts.chunks ?? [makeChunk("note.md")];

  return {
    llm: new SequenceLLM(opts.llmReplies),
    promptLoader,
    retriever: new StubRetriever(hits),
    store,
    vault,
    writer,
    jobQueue: queue,
    preview: opts.preview ?? confirmPreview,
    assembler: new StubAssembler(chunks),
    eventLog,
    turnId: "turn-1",
    alwaysPreview: false,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runMixed", () => {
  it("clean turn: saves note then returns answer", async () => {
    const queryReply = JSON.stringify({ answer: "Here is your answer.", citations: ["note.md"] });
    const deps = setup({ llmReplies: [specReply(), queryReply] });

    const outcome = await runMixed("Save this and answer me", deps);

    expect(outcome.kind).toBe("answered");
    if (outcome.kind !== "answered") return;
    expect(outcome.answer).toBe("Here is your answer.");
    expect(outcome.citations).toEqual(["note.md"]);
    expect(outcome.savedPath).toMatch(/\.md$/);
  });

  it("clean turn: event log has both ingest and query phases", async () => {
    const queryReply = JSON.stringify({ answer: "Answer.", citations: [] });
    const deps = setup({ llmReplies: [specReply(), queryReply], chunks: [] });

    await runMixed("test", deps);

    const entries = await deps.eventLog.eventsFor("turn-1");
    const phases = entries.map((e) => e.phase).filter(Boolean);
    expect(phases).toContain("ingest");
    expect(phases).toContain("query");
  });

  it("cancelled mid-ingest: aborts whole turn, no query phase", async () => {
    const deps = setup({ llmReplies: [specReply()], preview: cancelPreview });
    deps.alwaysPreview = true; // force preview so cancelPreview can fire

    const outcome = await runMixed("test", deps);

    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind !== "cancelled") return;
    expect(outcome.phase).toBe("ingest");

    const entries = await deps.eventLog.eventsFor("turn-1");
    const queryEntries = entries.filter((e) => e.phase === "query");
    expect(queryEntries).toHaveLength(0);
  });

  it("cancelled mid-query via signal: note is saved, query phase fails gracefully", async () => {
    const queryReply = JSON.stringify({ answer: "Answer.", citations: [] });

    const queryController = new AbortController();
    const vault = new MockVaultService({});
    const store = new InMemoryIngestionStore();
    const queue = new InMemoryJobQueue();
    const writer = new IngestWriter(vault);
    const eventLog = new InMemoryEventLog();

    // Abort the query signal immediately
    queryController.abort();

    const deps: MixedOrchestratorDeps & { eventLog: InMemoryEventLog } = {
      llm: new SequenceLLM([specReply(), queryReply]),
      promptLoader,
      retriever: new StubRetriever([makeHit("note.md")]),
      store,
      vault,
      writer,
      jobQueue: queue,
      preview: confirmPreview,
      assembler: new StubAssembler([makeChunk("note.md")]),
      eventLog,
      turnId: "turn-2",
      alwaysPreview: false,
      querySignal: queryController.signal,
    };

    const outcome = await runMixed("test", deps);

    // Query phase failed (aborted) but ingest note was preserved
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.phase).toBe("query");

    // Verify the job queue has an index job for the saved note (ingest completed)
    const jobs = queue.drain();
    expect(jobs.some((j) => j.kind === "index")).toBe(true);
  });

  it("onStateChange called with phase for both ingest and query", async () => {
    const queryReply = JSON.stringify({ answer: "Answer.", citations: [] });
    const deps = setup({ llmReplies: [specReply(), queryReply], chunks: [] });

    const calls: Array<{ state: string; phase: MixedPhase }> = [];
    deps.onStateChange = (state, _label, phase) => calls.push({ state, phase });

    await runMixed("test", deps);

    const ingestCalls = calls.filter((c) => c.phase === "ingest");
    const queryCalls = calls.filter((c) => c.phase === "query");
    expect(ingestCalls.length).toBeGreaterThan(0);
    expect(queryCalls.length).toBeGreaterThan(0);
  });

  it("ingest failure: returns failed with ingest phase, no query", async () => {
    // LLM returns invalid JSON so parse fails
    const deps = setup({ llmReplies: ["not json at all"] });

    const outcome = await runMixed("test", deps);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.phase).toBe("ingest");
  });
});
