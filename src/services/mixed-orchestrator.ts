import type {
  EventLog,
  EventLogEntry,
  IngestionStore,
  JobQueue,
  LLMService,
  PayloadAssembler,
  PromptLoader,
  Retriever,
  VaultService,
} from "../contracts";
import { IngestWriter } from "./ingest-writer";
import { runIngest, type PreviewHandler } from "./ingest-orchestrator";
import { runQuery } from "./query-orchestrator";

export type MixedPhase = "ingest" | "query";

export type MixedOutcome =
  | { kind: "answered"; answer: string; citations: string[]; savedPath: string }
  | { kind: "cancelled"; phase: MixedPhase }
  | { kind: "failed"; phase: MixedPhase; reason: string }
  | { kind: "validation_failed"; answer: string; savedPath: string };

export interface MixedOrchestratorDeps {
  llm: LLMService;
  promptLoader: PromptLoader;
  retriever: Retriever;
  store: IngestionStore;
  vault: VaultService;
  writer: IngestWriter;
  jobQueue: JobQueue;
  preview: PreviewHandler;
  assembler: PayloadAssembler;
  reranker?: Retriever;
  eventLog?: EventLog;
  turnId?: string;
  /** Called on each state entry with the state name, label, and current phase. */
  onStateChange?: (state: string, label: string, phase: MixedPhase) => void;
  inboxFolder?: string;
  dedupThreshold?: number;
  alwaysPreview?: boolean;
  model?: string;
  version?: string;
  /** Signal for the ingest phase. Aborting this also aborts the whole turn. */
  ingestSignal?: AbortSignal;
  /** Signal for the query phase only. Aborting preserves the saved note. */
  querySignal?: AbortSignal;
}

/**
 * Orchestrates a mixed-intent turn (#47): ingest runs first to completion,
 * then query runs against the vault (which now includes the newly saved note).
 *
 * Both phases share a single `turnId`. Event log entries are tagged with a
 * `phase` field so the turn inspector can show ingest and query as separate
 * sections within one turn.
 *
 * Cancellation during ingest aborts the whole turn. Cancellation after ingest
 * completes preserves the saved note and aborts only the query phase.
 */
export async function runMixed(
  text: string,
  deps: MixedOrchestratorDeps,
): Promise<MixedOutcome> {
  const turnId = deps.turnId ?? crypto.randomUUID();

  const ingestLog = deps.eventLog ? new PhaseEventLog(deps.eventLog, "ingest") : undefined;
  const queryLog = deps.eventLog ? new PhaseEventLog(deps.eventLog, "query") : undefined;

  // ── INGEST PHASE ──────────────────────────────────────────────────────
  const ingestOutcome = await runIngest(
    { text },
    {
      llm: deps.llm,
      promptLoader: deps.promptLoader,
      retriever: deps.retriever,
      store: deps.store,
      vault: deps.vault,
      writer: deps.writer,
      jobQueue: deps.jobQueue,
      preview: deps.preview,
      eventLog: ingestLog,
      turnId,
      onStateChange: deps.onStateChange
        ? (state, label) => deps.onStateChange!(state, label, "ingest")
        : undefined,
      inboxFolder: deps.inboxFolder,
      dedupThreshold: deps.dedupThreshold,
      alwaysPreview: deps.alwaysPreview,
      model: deps.model,
      version: deps.version,
      signal: deps.ingestSignal,
    },
  );

  if (ingestOutcome.kind === "cancelled") return { kind: "cancelled", phase: "ingest" };
  if (ingestOutcome.kind === "failed") {
    return { kind: "failed", phase: "ingest", reason: ingestOutcome.reason };
  }

  const savedPath =
    ingestOutcome.kind === "saved"
      ? ingestOutcome.path
      : ingestOutcome.kind === "split_saved"
        ? (ingestOutcome.paths[0] ?? "")
        : "";

  // ── QUERY PHASE ───────────────────────────────────────────────────────
  if (deps.querySignal?.aborted) {
    return { kind: "failed", phase: "query", reason: "aborted" };
  }

  const queryOutcome = await runQuery(
    { query: text },
    {
      retriever: deps.retriever,
      assembler: deps.assembler,
      llm: deps.llm,
      reranker: deps.reranker,
      eventLog: queryLog,
      turnId,
      model: deps.model,
      signal: deps.querySignal,
      onStateChange: deps.onStateChange
        ? (state, label) => deps.onStateChange!(state, label, "query")
        : undefined,
    },
  );

  if (queryOutcome.kind === "failed") {
    return { kind: "failed", phase: "query", reason: queryOutcome.reason };
  }
  if (queryOutcome.kind === "validation_failed") {
    return { kind: "validation_failed", answer: queryOutcome.answer, savedPath };
  }
  if (queryOutcome.kind === "empty") {
    return { kind: "answered", answer: "No relevant notes found.", citations: [], savedPath };
  }

  return {
    kind: "answered",
    answer: queryOutcome.answer,
    citations: queryOutcome.citations,
    savedPath,
  };
}

class PhaseEventLog implements EventLog {
  constructor(
    private readonly inner: EventLog,
    private readonly phase: MixedPhase,
  ) {}

  write(entry: EventLogEntry): void | Promise<void> {
    return this.inner.write({ ...entry, phase: this.phase });
  }

  eventsFor(turnId: string): Promise<readonly EventLogEntry[]> {
    return this.inner.eventsFor(turnId);
  }
}
