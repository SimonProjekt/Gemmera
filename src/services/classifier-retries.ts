/**
 * Classifier retry budget — issue #75.
 *
 * Wraps `classifyWithLLM` with the classifier-specific retry rules
 * documented in planning/classifier.md §"Retry budget".
 *
 * - 1 retry on invalid JSON output (retries do NOT count against the
 *   main turn's 3-retry budget).
 * - 0 retries on transport errors → re-throw for main-loop handling.
 * - 0 retries on out-of-taxonomy labels, confidence out-of-range,
 *   or timeout → fallback result (caller routes to "ask" + chip).
 * - Low confidence on a valid output → NOT a retry; returned as-is
 *   (disambiguation is handled by #07 thresholds).
 *
 * #75
 */

import { ClassifierInput, ClassifierOutput } from "../contracts/classifier";
import {
  classifyWithLLM,
  ClassifierCallDeps,
  ClassifierError,
  ClassifierCallResult,
} from "./classifier-llm";

export interface ClassifierRetriedResult {
  /** Validated output, or null when fallback occurred. */
  output: ClassifierOutput | null;
  /** Number of retries attempted (0 or 1). */
  retries: number;
  /** Total wall-clock latency from initial call to final decision, in ms. */
  latencyMs: number;
  /** Prompt version ID from the loaded intent-classifier prompt. */
  promptVersion: string;
  /** Raw classifier response text for debugging (set when output is null). */
  rawResponse?: string;
  /** Reason for fallback (only set when output is null). */
  fallbackReason?: "timeout" | "unparseable" | "invalid-label" | "invalid-confidence";
}

/**
 * Run the classifier with the v1 retry budget.
 *
 * Rules (in order of evaluation):
 *
 * | Error type          | Retries | Outcome                                   |
 * |---------------------|---------|-------------------------------------------|
 * | unparseable         | 1       | Retry once; second failure → fallback      |
 * | timeout             | 0       | Fallback (no retry)                        |
 * | invalid-label       | 0       | Fallback (no retry)                        |
 * | invalid-confidence  | 0       | Fallback (no retry)                        |
 * | transport           | 0       | Re-throw (caller shows main-loop error)    |
 *
 * All fallback paths return `{ output: null, fallbackReason, rawResponse }`.
 * Transport errors are re-thrown — the caller must route to the main-loop
 * Ollama-error handling (Notice with Start action). The turn is not submitted.
 */
export async function classifyWithRetries(
  input: ClassifierInput,
  deps: ClassifierCallDeps,
): Promise<ClassifierRetriedResult> {
  const overallStart = performance.now();

  try {
    const first = await classifyWithLLM(input, deps);
    return toSuccess(first, 0, overallStart);
  } catch (err) {
    if (!(err instanceof ClassifierError)) {
      throw err;
    }

    const pv = err.promptVersion ?? "";

    // Transport errors: 0 retries, re-throw.
    if (err.code === "transport") {
      throw err;
    }

    // Invalid label or confidence: 0 retries, fallback.
    if (err.code === "invalid-label" || err.code === "invalid-confidence") {
      return {
        output: null,
        retries: 0,
        latencyMs: Math.round(performance.now() - overallStart),
        promptVersion: pv,
        rawResponse: err.raw,
        fallbackReason: err.code,
      };
    }

    // Timeout: 0 retries, fallback.
    if (err.code === "timeout") {
      return {
        output: null,
        retries: 0,
        latencyMs: Math.round(performance.now() - overallStart),
        promptVersion: pv,
        fallbackReason: "timeout",
      };
    }

    // unparseable: 1 retry.
    if (err.code === "unparseable") {
      const firstRaw = err.raw;

      try {
        const second = await classifyWithLLM(input, deps);
        return toSuccess(second, 1, overallStart);
      } catch (retryErr) {
        if (!(retryErr instanceof ClassifierError)) {
          throw retryErr;
        }

        // Second failure — fallback.  Per spec, treat as timeout behaviour
        // (route ask, show chip, log malformed output).
        return {
          output: null,
          retries: 1,
          latencyMs: Math.round(performance.now() - overallStart),
          promptVersion: pv,
          rawResponse: firstRaw ?? retryErr.raw,
          fallbackReason: "unparseable",
        };
      }
    }

    throw err;
  }
}

function toSuccess(
  result: ClassifierCallResult,
  retries: number,
  overallStart: number,
): ClassifierRetriedResult {
  return {
    output: result.output,
    retries,
    latencyMs: Math.round(performance.now() - overallStart),
    promptVersion: result.promptVersion,
  };
}
