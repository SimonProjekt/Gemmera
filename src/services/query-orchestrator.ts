import type {
  ChatMessage,
  EventLog,
  EventLogEntry,
  LLMService,
  PayloadAssembler,
  RetrievalHit,
  RetrievalPayload,
  Retriever,
} from "../contracts";
import { RetryBudget, withInfraRetry, withJsonRetry } from "./retry-policy";
import type { TurnStatusCallback } from "./turn-status";
import { labelForState } from "./turn-status";

const STATES = {
  planRetrieval: "PLAN_RETRIEVAL",
  retrieve: "RETRIEVE",
  rerank: "RERANK",
  assembleContext: "ASSEMBLE_CONTEXT",
  generate: "GENERATE",
  validateCitations: "VALIDATE_CITATIONS",
  retryConstrainedCitations: "RETRY_WITH_CONSTRAINED_CITATIONS",
  present: "PRESENT",
  done: "DONE",
  failed: "TOOL_FAILED",
  validationFailed: "VALIDATION_FAILED",
} as const;

const TOP_K_RETRIEVE = 30;
const TOP_K_RERANK = 8;

export interface QueryInput {
  query: string;
}

export type QueryOutcome =
  | { kind: "answered"; answer: string; citations: string[] }
  | { kind: "empty" }
  | { kind: "failed"; reason: string }
  | { kind: "validation_failed"; answer: string };

export interface QueryOrchestratorDeps {
  retriever: Retriever;
  assembler: PayloadAssembler;
  llm: LLMService;
  /**
   * Optional second-pass reranker. When omitted, raw retriever hits pass
   * directly to the assembler. On failure, skipped per tool-loop.md retry policy.
   */
  reranker?: Retriever;
  eventLog?: EventLog;
  turnId?: string;
  model?: string;
  signal?: AbortSignal;
  /** Called synchronously on each state entry so the UI can update its status chip. */
  onStateChange?: TurnStatusCallback;
  /**
   * Called once with the hits the query loop will actually use, after
   * RETRIEVE (and after a successful RERANK, if a reranker is configured).
   * Wired so the context panel (#42) can render chunks with scores and
   * why-matched tags while the model is still generating the answer.
   */
  onHits?: (hits: RetrievalHit[]) => void;
  /** Shared retry budget for model-output retries across this turn. */
  retryBudget?: RetryBudget;
}

interface LLMQueryResponse {
  answer: string;
  citations: string[];
}

/**
 * Drives the query tool loop (#41): plan → retrieve → rerank →
 * assemble_context → generate → validate_citations → present.
 *
 * Citation validation checks every cited path is in the assembled payload.
 * Invalid citations trigger one retry with the allowed paths listed
 * explicitly. A second failure exits to VALIDATION_FAILED.
 */
export async function runQuery(
  input: QueryInput,
  deps: QueryOrchestratorDeps,
): Promise<QueryOutcome> {
  const turnId = deps.turnId ?? crypto.randomUUID();
  // Classification happens upstream (classifier-orchestrator); query picks up
  // from the state the classifier left on exit.
  let prevState = "CLASSIFY_INTENT";
  const enter = async (state: string, payload?: Record<string, unknown>) => {
    deps.onStateChange?.(state, labelForState(state));
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

  // ── PLAN_RETRIEVAL ────────────────────────────────────────────────────
  // Simple queries skip planning and go to RETRIEVE with sensible defaults.
  await enter(STATES.planRetrieval);
  const { query } = input;

  const budget = deps.retryBudget ?? new RetryBudget();

  // ── RETRIEVE ──────────────────────────────────────────────────────────
  // Embedding fail → 1 infra retry after 250 ms; second failure → TOOL_FAILED.
  await enter(STATES.retrieve);
  let hits: RetrievalHit[];
  try {
    hits = await withInfraRetry(
      () => deps.retriever.retrieve(query, { topK: TOP_K_RETRIEVE }),
      250,
      deps.signal,
    );
  } catch (err) {
    const reason = `retrieve:${stringifyError(err)}`;
    await enter(STATES.failed, { reason });
    return { kind: "failed", reason };
  }

  if (hits.length === 0) {
    await enter(STATES.present, { empty: true });
    await enter(STATES.done, { empty: true });
    return { kind: "empty" };
  }

  // ── RERANK ────────────────────────────────────────────────────────────
  // Reranker fail → 0 retries, skip and use raw hits per tool-loop.md.
  await enter(STATES.rerank);
  if (deps.reranker) {
    try {
      hits = await deps.reranker.retrieve(query, { topK: TOP_K_RERANK });
    } catch {
      // intentional skip
    }
  }

  deps.onHits?.(hits);

  // ── ASSEMBLE_CONTEXT ──────────────────────────────────────────────────
  await enter(STATES.assembleContext);
  const payload = deps.assembler.assemble(query, hits);
  const validPaths = new Set(payload.chunks.map((c) => c.path));

  // ── GENERATE ──────────────────────────────────────────────────────────
  // Ollama connection refused → 1 infra retry after 500 ms.
  // Invalid JSON → 1 model-output retry consuming from budget.
  await enter(STATES.generate);
  const model = deps.model ?? (await deps.llm.pickDefaultModel());
  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(query, payload);

  const callLlm = (messages: ChatMessage[]) =>
    async (signal?: AbortSignal): Promise<string> => {
      const response = await withInfraRetry(
        () => deps.llm.chat({ messages, model, format: "json", signal }),
        500,
        signal,
      );
      return response.content;
    };

  let llmRaw: string;
  let parsed: LLMQueryResponse | null;
  try {
    const jsonResult = await withJsonRetry(
      callLlm([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]),
      parseQueryResponse,
      budget,
      deps.signal,
    );
    if (!jsonResult.ok) {
      await enter(STATES.failed, { reason: "generate:invalid_json" });
      return { kind: "failed", reason: "generate:invalid_json" };
    }
    llmRaw = ""; // not needed downstream; value captured in jsonResult
    parsed = jsonResult.value;
  } catch (err) {
    const reason = `generate:${stringifyError(err)}`;
    await enter(STATES.failed, { reason });
    return { kind: "failed", reason };
  }

  // ── VALIDATE_CITATIONS ────────────────────────────────────────────────
  // Hallucinated citations → 1 feedback retry consuming from budget;
  // second failure → VALIDATION_FAILED.
  await enter(STATES.validateCitations, { citationCount: parsed.citations.length });
  const invalid = parsed.citations.filter((p) => !validPaths.has(p));

  if (invalid.length > 0) {
    // ── RETRY_WITH_CONSTRAINED_CITATIONS ─────────────────────────────
    if (!budget.consume()) {
      await enter(STATES.validationFailed, { reason: "budget_exhausted" });
      return { kind: "validation_failed", answer: parsed.answer };
    }

    const allowed = [...validPaths];
    await enter(STATES.retryConstrainedCitations, { invalid, allowed });

    const retryMessage = buildRetryMessage(allowed);
    let retryParsed: LLMQueryResponse | null;
    try {
      const retryRaw = await callLlm([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
        { role: "assistant", content: JSON.stringify(parsed) },
        { role: "user", content: retryMessage },
      ])(deps.signal);
      retryParsed = parseQueryResponse(retryRaw);
    } catch (err) {
      const reason = `retry:${stringifyError(err)}`;
      await enter(STATES.failed, { reason });
      return { kind: "failed", reason };
    }

    if (!retryParsed) {
      await enter(STATES.validationFailed, { reason: "retry:invalid_json" });
      return { kind: "validation_failed", answer: parsed.answer };
    }

    const stillInvalid = retryParsed.citations.filter((p) => !validPaths.has(p));
    if (stillInvalid.length > 0) {
      await enter(STATES.validationFailed, { stillInvalid });
      return { kind: "validation_failed", answer: retryParsed.answer };
    }

    parsed = retryParsed;
  }

  // ── PRESENT ───────────────────────────────────────────────────────────
  await enter(STATES.present, { citationCount: parsed.citations.length });
  await enter(STATES.done);
  return { kind: "answered", answer: parsed.answer, citations: parsed.citations };
}

function buildSystemPrompt(): string {
  return [
    "You are a knowledgeable assistant with access to the user's personal vault of notes.",
    "Answer the user's question using only the provided note excerpts.",
    "Cite every note you draw from using its exact vault path.",
    "",
    "Respond with JSON matching exactly this schema:",
    '{ "answer": "<your answer>", "citations": ["path/to/note.md", ...] }',
    "",
    "Rules:",
    "- Only cite paths that appear in the provided excerpts.",
    "- If no excerpts are relevant, set citations to [].",
    "- Do not invent or guess paths.",
  ].join("\n");
}

function buildUserMessage(query: string, payload: RetrievalPayload): string {
  const excerpts = payload.chunks
    .map((c) => `[${c.path}] ${c.title}\n${c.text}`)
    .join("\n\n---\n\n");
  return `Question: ${query}\n\nNote excerpts:\n${excerpts}`;
}

function buildRetryMessage(allowedPaths: string[]): string {
  return [
    "Your previous response cited paths that are not in the provided excerpts.",
    "Only cite from these paths:",
    ...allowedPaths.map((p) => `  - ${p}`),
    "",
    'Revise your answer and citations. Return: { "answer": "...", "citations": [...] }',
  ].join("\n");
}

function parseQueryResponse(raw: string): LLMQueryResponse | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      typeof (obj as Record<string, unknown>).answer === "string" &&
      Array.isArray((obj as Record<string, unknown>).citations) &&
      ((obj as Record<string, unknown>).citations as unknown[]).every(
        (c) => typeof c === "string",
      )
    ) {
      return obj as LLMQueryResponse;
    }
    return null;
  } catch {
    return null;
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
