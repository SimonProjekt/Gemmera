import type {
  DedupChoice,
  EventLog,
  EventLogEntry,
  IngestInput,
  IngestOutcome,
  IngestStrategy,
  IngestionStore,
  JobQueue,
  LLMService,
  NoteSpec,
  PromptLoader,
  Retriever,
  VaultService,
} from "../contracts";
import { parseContent } from "./ingest-parser";
import { decideStrategy } from "./ingest-strategy";
import { IngestWriter } from "./ingest-writer";

const STATES = {
  parse: "PARSE_CONTENT",
  search: "SEARCH_SIMILAR",
  decide: "DECIDE_STRATEGY",
  preview: "PREVIEW",
  write: "WRITE",
  updateIndex: "UPDATE_INDEX",
  done: "DONE",
  cancelled: "CANCELLED",
  failed: "TOOL_FAILED",
} as const;

export interface IngestPreview {
  /** "save" | "append" | "dedup" — drives which buttons the preview shows. */
  kind: "save" | "append" | "dedup";
  spec: NoteSpec;
  strategy: IngestStrategy;
}

export type PreviewDecision =
  | { action: "confirm" }
  | { action: "edit"; spec: NoteSpec }
  | { action: "cancel" }
  | { action: "dedup_choice"; choice: DedupChoice };

export type PreviewHandler = (
  preview: IngestPreview,
) => Promise<PreviewDecision>;

export interface IngestOrchestratorDeps {
  llm: LLMService;
  promptLoader: PromptLoader;
  retriever: Retriever;
  store: IngestionStore;
  vault: VaultService;
  writer: IngestWriter;
  jobQueue: JobQueue;
  /** Returns `confirm` immediately for the bypass path used in tests. */
  preview: PreviewHandler;
  /**
   * Optional event log. The orchestrator writes one `enter` row per
   * orchestrator state (parse → search → decide → preview → write →
   * update_index → done/cancelled/failed) so the turn inspector and the
   * #13 acceptance test can replay what happened.
   */
  eventLog?: EventLog;
  /** Turn id used for event-log entries. Defaults to a fresh uuid. */
  turnId?: string;
  inboxFolder?: string;
  dedupThreshold?: number;
  alwaysPreview?: boolean;
  model?: string;
  version?: string;
  runId?: () => string;
  signal?: AbortSignal;
}

/**
 * Drives the ingest tool loop (#13): parse → search_similar → decide →
 * preview → write → update_index.
 *
 * The preview gate is an injected callback so the orchestrator stays
 * UI-agnostic; tests pass a function that auto-confirms or simulates a
 * cancel. The chat view passes a callback that opens an Obsidian Modal.
 *
 * The preview is the only state allowed to bounce back to itself: the user
 * can edit the candidate and re-render before confirming. A hard cap of 10
 * iterations prevents pathological loops from a misbehaving handler.
 */
export async function runIngest(
  input: IngestInput,
  deps: IngestOrchestratorDeps,
): Promise<IngestOutcome> {
  const turnId = deps.turnId ?? freshTurnId();
  let prevState = "IDLE";
  const enter = async (state: string, payload?: Record<string, unknown>) => {
    if (!deps.eventLog) return;
    const entry: EventLogEntry = {
      turnId,
      kind: "enter",
      state,
      fromState: prevState,
      timestamp: Date.now(),
      triggeringEvent: payload
        ? { kind: "tool_result", name: state, payload }
        : null,
    };
    await deps.eventLog.write(entry);
    prevState = state;
  };

  // ── PARSE_CONTENT ────────────────────────────────────────────────────
  await enter(STATES.parse);
  const parse = await parseContent(input.text, input.instruction, {
    llm: deps.llm,
    promptLoader: deps.promptLoader,
    runId: deps.runId,
    model: deps.model,
    version: deps.version,
  }, deps.signal);
  if (!parse.ok) {
    if (parse.reason === "empty") {
      await enter(STATES.cancelled, { reason: "empty_input" });
      return { kind: "cancelled" };
    }
    await enter(STATES.failed, { reason: `parse:${parse.reason}` });
    return { kind: "failed", reason: `parse:${parse.reason}` };
  }
  let spec = parse.spec;

  // ── SEARCH_SIMILAR + DECIDE_STRATEGY ─────────────────────────────────
  await enter(STATES.search);
  const decision = await decideStrategy(spec, {
    llm: deps.llm,
    promptLoader: deps.promptLoader,
    retriever: deps.retriever,
    store: deps.store,
    dedupThreshold: deps.dedupThreshold,
  }, deps.signal);
  let strategy = decision.strategy;
  await enter(STATES.decide, { kind: strategy.kind });

  // ── PREVIEW ──────────────────────────────────────────────────────────
  await enter(STATES.preview, { kind: previewKindFor(strategy) });
  for (let i = 0; i < 10; i++) {
    const previewKind = previewKindFor(strategy);
    const result = await deps.preview({ kind: previewKind, spec, strategy });
    if (result.action === "cancel") {
      await enter(STATES.cancelled, { from: "preview" });
      return { kind: "cancelled" };
    }
    if (result.action === "edit") {
      spec = result.spec;
      continue;
    }
    if (result.action === "dedup_choice") {
      if (result.choice === "cancel") {
        await enter(STATES.cancelled, { from: "dedup" });
        return { kind: "cancelled" };
      }
      if (strategy.kind !== "dedup_ask") {
        await enter(STATES.failed, { reason: "dedup_choice_without_dedup_ask" });
        return { kind: "failed", reason: "dedup_choice_without_dedup_ask" };
      }
      if (result.choice === "append") {
        strategy = { kind: "append", target: strategy.target };
      } else {
        // save_anyway — fall through to a regular create. Surface the
        // matched note as a related link so the user sees the connection.
        strategy = {
          kind: "create",
          related: unique([...spec.related, strategy.target]),
        };
      }
      // The user has resolved the dedup; proceed straight to write.
      break;
    }
    // confirm
    break;
  }

  // ── WRITE ────────────────────────────────────────────────────────────
  await enter(STATES.write, { kind: strategy.kind });
  if (strategy.kind === "dedup_ask") {
    await enter(STATES.failed, { reason: "preview_unresolved" });
    return { kind: "failed", reason: "preview_unresolved" };
  }
  if (strategy.kind === "append") {
    if (!(await deps.vault.exists(strategy.target))) {
      await enter(STATES.failed, { reason: "append_target_missing" });
      return { kind: "failed", reason: "append_target_missing" };
    }
    try {
      await deps.writer.appendUnderDatedHeading(strategy.target, spec.body_markdown);
    } catch (err) {
      const reason = `write:${stringifyError(err)}`;
      await enter(STATES.failed, { reason });
      return { kind: "failed", reason };
    }
    deps.jobQueue.enqueue({ kind: "index", path: strategy.target });
    await enter(STATES.updateIndex, { path: strategy.target });
    await enter(STATES.done, { mode: "append", path: strategy.target });
    return { kind: "saved", path: strategy.target, mode: "append", spec };
  }

  // create
  spec = { ...spec, related: strategy.related };
  let path: string;
  try {
    const result = await deps.writer.writeNew(spec, { folder: deps.inboxFolder });
    path = result.path;
  } catch (err) {
    const reason = `write:${stringifyError(err)}`;
    await enter(STATES.failed, { reason });
    return { kind: "failed", reason };
  }
  deps.jobQueue.enqueue({ kind: "index", path });
  await enter(STATES.updateIndex, { path });
  await enter(STATES.done, { mode: "create", path });
  return { kind: "saved", path, mode: "create", spec };
}

function freshTurnId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `turn_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

function previewKindFor(strategy: IngestStrategy): IngestPreview["kind"] {
  if (strategy.kind === "dedup_ask") return "dedup";
  if (strategy.kind === "append") return "append";
  return "save";
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
