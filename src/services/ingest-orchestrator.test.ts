import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { IngestWriter } from "./ingest-writer";
import { runIngest, type PreviewDecision, type PreviewHandler } from "./ingest-orchestrator";
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

class StaticLLM implements LLMService {
  constructor(public reply: string) {}
  async chat(_opts: ChatOptions): Promise<LLMResponse> { return { content: this.reply }; }
  async isReachable(): Promise<LLMReachability> { return "running"; }
  async listModels() { return []; }
  async pickDefaultModel() { return "mock"; }
}

class StubRetriever implements Retriever {
  constructor(public hits: RetrievalHit[] = []) {}
  async retrieve(): Promise<RetrievalHit[]> { return this.hits; }
}

const promptLoader: PromptLoader = {
  async load(): Promise<LoadedPrompt> {
    return { id: "ingest-parser", version: "0.1", body: "stub" };
  },
  invalidate() {},
};

function specReply(overrides: Partial<NoteSpec> = {}): string {
  return JSON.stringify({
    title: "Q2 standup",
    type: "meeting",
    tags: ["q2"],
    aliases: [],
    source: "chat-paste",
    entities: [],
    related: [],
    status: "inbox",
    summary: "Decisions.",
    key_points: [],
    body_markdown: "# Decisions\n\nWe ship v2.",
    confidence: "high",
    ...overrides,
  });
}

function setup(opts: {
  llmReply?: string;
  vaultFiles?: Record<string, string>;
  retrieverHits?: RetrievalHit[];
  preview: PreviewHandler;
  /** Seed an existing note with the given body hash for dedup tests. */
  storeNotes?: Array<{ path: string; bodyHash: string }>;
}) {
  const vault = new MockVaultService(opts.vaultFiles ?? {});
  const store = new InMemoryIngestionStore();
  if (opts.storeNotes) {
    for (const { path, bodyHash } of opts.storeNotes) {
      store.upsert(
        { path, contentHash: bodyHash, bodyHash, mtime: 0, frontmatter: null },
        [],
      );
    }
  }
  const queue = new InMemoryJobQueue();
  const writer = new IngestWriter(vault);
  return {
    vault,
    store,
    queue,
    writer,
    deps: {
      llm: new StaticLLM(opts.llmReply ?? specReply()),
      promptLoader,
      retriever: new StubRetriever(opts.retrieverHits),
      store,
      vault,
      writer,
      jobQueue: queue,
      preview: opts.preview,
      inboxFolder: "Inbox/",
      runId: () => "run-1",
      model: "test-model",
      version: "0.0.1",
    },
  };
}

const autoConfirm: PreviewHandler = async () => ({ action: "confirm" });

describe("runIngest", () => {
  it("happy path: parses, decides create, writes, enqueues index", async () => {
    const { deps, vault, queue } = setup({ preview: autoConfirm });

    const result = await runIngest({ text: "Q2 standup notes" }, deps);

    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.mode).toBe("create");
    expect(result.path.startsWith("Inbox/")).toBe(true);

    const written = await vault.read(result.path);
    expect(written).toContain("cowork_managed: true");
    expect(written).toContain("# Decisions");

    expect(queue.size()).toBe(1);
  });

  it("dedup_ask: exact-hash duplicate routes to preview, append choice writes to existing", async () => {
    const body = "# Decisions\n\nWe ship v2.";
    const bodyHash = createHash("sha256").update(body).digest("hex");

    let askedKind = "";
    const handler: PreviewHandler = async (p) => {
      askedKind = p.kind;
      return { action: "dedup_choice", choice: "append" };
    };
    const { deps, vault, queue } = setup({
      vaultFiles: { "Existing/standup.md": "# Existing\n\n" },
      storeNotes: [{ path: "Existing/standup.md", bodyHash }],
      preview: handler,
    });

    const result = await runIngest({ text: "Q2 standup notes" }, deps);
    expect(askedKind).toBe("dedup");
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.mode).toBe("append");
    expect(result.path).toBe("Existing/standup.md");

    const after = await vault.read("Existing/standup.md");
    expect(after).toMatch(/##\s+\d{4}-\d{2}-\d{2}/);
    expect(after).toContain("# Decisions");
    expect(queue.size()).toBe(1);
  });

  it("dedup_ask: save_anyway turns into create with the matched path linked", async () => {
    const body = "# Decisions\n\nWe ship v2.";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const handler: PreviewHandler = async () => ({ action: "dedup_choice", choice: "save_anyway" });
    const { deps, vault } = setup({
      storeNotes: [{ path: "Existing/standup.md", bodyHash }],
      preview: handler,
    });

    const result = await runIngest({ text: "Q2 standup notes" }, deps);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.mode).toBe("create");

    const written = await vault.read(result.path);
    expect(written).toContain("Existing/standup.md");
  });

  it("cancel propagates", async () => {
    const handler: PreviewHandler = async () => ({ action: "cancel" });
    const { deps, queue } = setup({ preview: handler });
    const result = await runIngest({ text: "anything" }, deps);
    expect(result.kind).toBe("cancelled");
    expect(queue.size()).toBe(0);
  });

  it("edit then confirm uses the edited spec", async () => {
    let calls = 0;
    const handler: PreviewHandler = async ({ spec }): Promise<PreviewDecision> => {
      calls++;
      if (calls === 1) {
        return { action: "edit", spec: { ...spec, title: "Edited title" } };
      }
      return { action: "confirm" };
    };
    const { deps, vault } = setup({ preview: handler });
    const result = await runIngest({ text: "x" }, deps);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    const written = await vault.read(result.path);
    expect(written).toContain("title: Edited title");
  });

  it("returns failed when parse fails (invalid JSON from LLM)", async () => {
    const { deps } = setup({ llmReply: "not json", preview: autoConfirm });
    const result = await runIngest({ text: "x" }, deps);
    expect(result.kind).toBe("failed");
  });

  it("returns cancelled for empty input without calling LLM", async () => {
    const { deps } = setup({ preview: autoConfirm });
    const result = await runIngest({ text: "   " }, deps);
    expect(result.kind).toBe("cancelled");
  });

  it("alwaysPreview=false: bypasses preview for high-confidence creates", async () => {
    let previewCalls = 0;
    const handler: PreviewHandler = async () => {
      previewCalls++;
      return { action: "confirm" };
    };
    const { deps } = setup({ preview: handler });
    const result = await runIngest(
      { text: "x" },
      { ...deps, alwaysPreview: false },
    );
    expect(result.kind).toBe("saved");
    expect(previewCalls).toBe(0);
  });

  it("alwaysPreview=false: still previews for append and dedup_ask", async () => {
    const body = "# Decisions\n\nWe ship v2.";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    let previewCalls = 0;
    const handler: PreviewHandler = async () => {
      previewCalls++;
      return { action: "dedup_choice", choice: "append" };
    };
    const { deps } = setup({
      vaultFiles: { "Existing/standup.md": "# Existing\n" },
      storeNotes: [{ path: "Existing/standup.md", bodyHash }],
      preview: handler,
    });
    await runIngest(
      { text: "Q2 standup notes" },
      { ...deps, alwaysPreview: false },
    );
    expect(previewCalls).toBeGreaterThan(0);
  });

  it("emits an event-log entry for every orchestrator phase (issue #13 acceptance)", async () => {
    const { deps } = setup({ preview: autoConfirm });
    const eventLog = new InMemoryEventLog();
    const turnId = "test-turn-1";
    const result = await runIngest(
      { text: "Q2 standup notes" },
      { ...deps, eventLog, turnId },
    );
    expect(result.kind).toBe("saved");
    const entries = await eventLog.eventsFor(turnId);
    const states = entries.map((e) => e.state);
    expect(states).toContain("PARSE_CONTENT");
    expect(states).toContain("SEARCH_SIMILAR");
    expect(states).toContain("DECIDE_STRATEGY");
    expect(states).toContain("PREVIEW");
    expect(states).toContain("WRITE");
    expect(states).toContain("UPDATE_INDEX");
    expect(states).toContain("DONE");
  });
});

import { InMemoryEventLog } from "./event-log";
