import { HARD_STOPS } from "../contracts";

/**
 * Tracks the per-turn retry ceiling (#51).
 *
 * Model-output retries (invalid JSON, schema violations) and tool-argument
 * retries all draw from the same pool so pathological prompts cannot exhaust
 * the turn with retry loops at each state independently.
 *
 * Infra retries (Ollama connection refused, embedding failure) are handled by
 * `withInfraRetry`, which has its own fixed 1-attempt budget and does NOT
 * consume from this pool — they are transport-level, not model-output events.
 */
export class RetryBudget {
  private used = 0;

  constructor(private readonly max = HARD_STOPS.MAX_RETRIES_PER_TURN) {}

  /** True when at least one retry remains. */
  canRetry(): boolean {
    return this.used < this.max;
  }

  /**
   * Consume one retry slot. Returns true when the slot was granted,
   * false when the budget is exhausted and the caller should not retry.
   */
  consume(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }

  get count(): number {
    return this.used;
  }
}

// ── Model-output validity ──────────────────────────────────────────────────────

export type JsonRetryResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "invalid_json" | "budget_exhausted" };

/**
 * Calls `fn` and attempts to parse the result. On parse failure, consumes one
 * slot from `budget` and retries once. On second failure, or if the budget is
 * already exhausted, returns an error result rather than throwing.
 *
 * Corresponds to: "invalid JSON → 1 retry under format:'json'; on second
 * failure → MODEL_INVALID_OUTPUT" from tool-loop.md retry policy.
 */
export async function withJsonRetry<T>(
  fn: (signal?: AbortSignal) => Promise<string>,
  parse: (raw: string) => T | null,
  budget: RetryBudget,
  signal?: AbortSignal,
): Promise<JsonRetryResult<T>> {
  const raw = await fn(signal);
  const parsed = tryParse(parse, raw);
  if (parsed !== null) return { ok: true, value: parsed };

  if (!budget.consume()) return { ok: false, reason: "budget_exhausted" };

  const raw2 = await fn(signal);
  const parsed2 = tryParse(parse, raw2);
  if (parsed2 !== null) return { ok: true, value: parsed2 };
  return { ok: false, reason: "invalid_json" };
}

function tryParse<T>(parse: (raw: string) => T | null, raw: string): T | null {
  try {
    return parse(raw);
  } catch {
    return null;
  }
}

export type FeedbackRetryResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "validation_failed" | "budget_exhausted"; value: T };

/**
 * Calls `fn`, validates the result, and on failure retries once with error
 * feedback via `retryFn`. On second failure, or if the budget is exhausted,
 * returns the latest value alongside an error result so callers can surface it.
 *
 * Corresponds to: "schema-valid-but-rule-violating JSON → 1 retry with
 * explicit error feedback; second failure → VALIDATION_FAILED".
 */
export async function withFeedbackRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  validate: (v: T) => string | null,
  retryFn: (errorMsg: string, signal?: AbortSignal) => Promise<T>,
  budget: RetryBudget,
  signal?: AbortSignal,
): Promise<FeedbackRetryResult<T>> {
  const value = await fn(signal);
  const error = validate(value);
  if (!error) return { ok: true, value };

  if (!budget.consume()) return { ok: false, reason: "budget_exhausted", value };

  const value2 = await retryFn(error, signal);
  const error2 = validate(value2);
  if (!error2) return { ok: true, value: value2 };
  return { ok: false, reason: "validation_failed", value: value2 };
}

// ── Transient infra ───────────────────────────────────────────────────────────

/**
 * Calls `fn` and, on any thrown error, waits `delayMs` then retries once.
 * Throws on the second failure — callers surface the error as a Notice or
 * return the job to the queue depending on which component failed.
 *
 * Does NOT consume from `RetryBudget` — infra retries are transport-level
 * events, not model-output retries. Each component has its own fixed budget:
 *   - Ollama connection refused: 1 retry after 500 ms
 *   - Embedding call fails: 1 retry after 250 ms
 *   - Reranker fails: 0 retries (caller skips rerank, never calls this)
 *
 * `sleep` is injectable for deterministic tests.
 */
export async function withInfraRetry<T>(
  fn: () => Promise<T>,
  delayMs: number,
  signal?: AbortSignal,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  try {
    return await fn();
  } catch {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await sleep(delayMs);
    return fn();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
