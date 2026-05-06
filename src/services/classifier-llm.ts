/**
 * Classifier LLM call — issue #05.
 *
 * Renders the intent-classifier prompt, issues an Ollama call with
 * `format: "json"` constrained decoding, parses + validates the output.
 *
 * Retry budget and timeout fallbacks are handled by the caller (issue #06).
 *
 * #05
 */

import { ClassifierInput, ClassifierOutput } from "../contracts/classifier";
import { ChatMessage, LLMService } from "../contracts/llm";
import { PromptLoader } from "../contracts/prompts";
import { assembleClassifierPrompt } from "./classifier-prompt";

const CLASSIFIER_MODEL = "gemma3:latest";
const CLASSIFIER_TIMEOUT_MS = 500;

/** Errors the classifier call surface can throw. */
export class ClassifierError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "timeout"
      | "unparseable"
      | "invalid-label"
      | "invalid-confidence"
      | "transport",
    public readonly raw?: string,
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}

/** Result of a classifier LLM call. */
export interface ClassifierCallResult {
  output: ClassifierOutput;
  latencyMs: number;
  promptVersion: string;
}

/** Dependencies needed by the classifier call site. */
export interface ClassifierCallDeps {
  llm: LLMService;
  /** Prompt loader — tests can inject a mock. */
  promptLoader: PromptLoader;
}

/**
 * Run the LLM classifier against the given input.
 *
 * Behaviour:
 *   1. Load the intent-classifier prompt via `promptLoader`.
 *   2. Render the prompt body with the input.
 *   3. Call Ollama with `format: "json"`, `stream: false`, and a 500 ms
 *      AbortSignal timeout.
 *   4. Parse the JSON response.
 *   5. Validate `label` is in the taxonomy and `confidence` is in [0,1].
 *   6. On transport/timeout error → throw ClassifierError (caller falls
 *      back to main-loop Ollama-error handling or timeout behaviour).
 */
export async function classifyWithLLM(
  input: ClassifierInput,
  deps: ClassifierCallDeps,
): Promise<ClassifierCallResult> {
  const loaded = await deps.promptLoader.load("intent-classifier");
  const prompt = assembleClassifierPrompt(input, loaded.body);
  const messages: ChatMessage[] = [
    { role: "system", content: "You are an intent classifier." },
    { role: "user", content: prompt },
  ];

  const start = performance.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const res = await deps.llm.chat({
      messages,
      model: CLASSIFIER_MODEL,
      format: "json",
      stream: false,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const output = parseAndValidate(res.content);
    const latencyMs = Math.round(performance.now() - start);

    return {
      output,
      latencyMs,
      promptVersion: loaded.version,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === "AbortError") {
      throw new ClassifierError("Classifier timed out", "timeout");
    }
    if (err instanceof ClassifierError) {
      throw err;
    }
    // Transport / network / generic Ollama error.
    throw new ClassifierError(
      err instanceof Error ? err.message : String(err),
      "transport",
    );
  }
}

function parseAndValidate(raw: string): ClassifierOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClassifierError("Invalid JSON from classifier", "unparseable", raw);
  }

  if (!isPlainObject(parsed)) {
    throw new ClassifierError("Classifier output is not an object", "unparseable", raw);
  }

  const label = parsed.label;
  const confidence = parsed.confidence;
  const rationale = parsed.rationale;

  if (!isValidLabel(label)) {
    throw new ClassifierError(
      `Invalid label: ${String(label)}`,
      "invalid-label",
      raw,
    );
  }

  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new ClassifierError(
      `Confidence out of range: ${String(confidence)}`,
      "invalid-confidence",
      raw,
    );
  }

  if (typeof rationale !== "string") {
    throw new ClassifierError(
      `Rationale missing or not a string`,
      "unparseable",
      raw,
    );
  }

  return { label, confidence, rationale };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidLabel(v: unknown): v is "capture" | "ask" | "mixed" | "meta" {
  return v === "capture" || v === "ask" || v === "mixed" || v === "meta";
}
