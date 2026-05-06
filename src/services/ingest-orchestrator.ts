import type {
  DedupChoice,
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
  // ── PARSE_CONTENT ────────────────────────────────────────────────────
  const parse = await parseContent(input.text, input.instruction, {
    llm: deps.llm,
    promptLoader: deps.promptLoader,
    runId: deps.runId,
    model: deps.model,
    version: deps.version,
  }, deps.signal);
  if (!parse.ok) {
    if (parse.reason === "empty") return { kind: "cancelled" };
    return { kind: "failed", reason: `parse:${parse.reason}` };
  }
  let spec = parse.spec;

  // ── SEARCH_SIMILAR + DECIDE_STRATEGY ─────────────────────────────────
  const decision = await decideStrategy(spec, {
    llm: deps.llm,
    promptLoader: deps.promptLoader,
    retriever: deps.retriever,
    store: deps.store,
    dedupThreshold: deps.dedupThreshold,
  }, deps.signal);
  let strategy = decision.strategy;

  // ── PREVIEW ──────────────────────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    const previewKind = previewKindFor(strategy);
    const result = await deps.preview({ kind: previewKind, spec, strategy });
    if (result.action === "cancel") return { kind: "cancelled" };
    if (result.action === "edit") {
      spec = result.spec;
      continue;
    }
    if (result.action === "dedup_choice") {
      if (result.choice === "cancel") return { kind: "cancelled" };
      if (strategy.kind !== "dedup_ask") {
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
  if (strategy.kind === "dedup_ask") {
    return { kind: "failed", reason: "preview_unresolved" };
  }
  if (strategy.kind === "append") {
    if (!(await deps.vault.exists(strategy.target))) {
      return { kind: "failed", reason: "append_target_missing" };
    }
    try {
      await deps.writer.appendUnderDatedHeading(strategy.target, spec.body_markdown);
    } catch (err) {
      return { kind: "failed", reason: `write:${stringifyError(err)}` };
    }
    deps.jobQueue.enqueue({ kind: "index", path: strategy.target });
    return { kind: "saved", path: strategy.target, mode: "append", spec };
  }

  // create
  spec = { ...spec, related: strategy.related };
  let path: string;
  try {
    const result = await deps.writer.writeNew(spec, { folder: deps.inboxFolder });
    path = result.path;
  } catch (err) {
    return { kind: "failed", reason: `write:${stringifyError(err)}` };
  }
  deps.jobQueue.enqueue({ kind: "index", path });
  return { kind: "saved", path, mode: "create", spec };
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
