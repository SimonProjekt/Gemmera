/**
 * Classifier orchestrator — issue #79.
 *
 * Wires the full classifier pipeline (skip router → LLM call → retries →
 * confidence thresholds → event writing) into a single `classifyTurn`
 * function that produces a `RouteDecision` for the turn router.
 *
 * This is the integration point between the classifier sub-system and the
 * tool loop.  The caller (view.ts / main.ts) calls `classifyTurn` on every
 * user submission, then dispatches the returned `RouteDecision` to the
 * appropriate state machine or renders the meta help response.
 *
 * #79
 */

import {
  Attachment,
  ActiveFile,
  RecentTurn,
  PresetCommand,
  ClassifierDecision,
  ClassifierInput,
  ClassifierSource,
  ClassifierThresholds,
  DEFAULT_CLASSIFIER_THRESHOLDS,
  IntentLabel,
  RouteDecision,
  SkipReason,
} from "../contracts/classifier";
import { LLMService } from "../contracts/llm";
import { PromptLoader } from "../contracts/prompts";
import { ClassifierEventWriter } from "../contracts/classifier";
import { classifySkipRouter } from "./classifier-skip-router";
import { classifyWithRetries } from "./classifier-retries";
import { isConfident } from "./classifier-thresholds";
import { prepareClassifierInput } from "./classifier-utils";
import { toDecisionRow } from "./classifier-events";
import { META_HELP_RESPONSE } from "./help-content";

// ─── Orchestrator input ────────────────────────────────────────────────

/** Raw input received from the chat view / composer. */
export interface ClassifyTurnInput {
  messageText: string;
  attachments: Attachment[];
  activeFile: ActiveFile | null;
  recentTurns: RecentTurn[];
  ctrlEnter?: boolean;
  presetCommand?: PresetCommand;
}

/** Dependencies required by the classifier orchestrator. */
export interface ClassifyTurnDeps {
  llm: LLMService;
  promptLoader: PromptLoader;
  eventWriter: ClassifierEventWriter;
  thresholds?: ClassifierThresholds;
}

// ─── Orchestrator ──────────────────────────────────────────────────────

/**
 * Run the full classifier pipeline against a single turn.
 *
 * Pipeline:
 *   1. Skip router — hard signals that pre-empt the LLM.
 *   2. Input preparation — truncation + recent-turns slice.
 *   3. LLM call (with retry budget) — Ollama classification.
 *   4. Confidence gating — asymmetric per-label thresholds.
 *   5. Event writing — decision row written regardless of outcome.
 *   6. Meta short-circuit — help response returned directly.
 *
 * Returns `RouteDecision` with the final label, the full decision object
 * for the turn inspector, and any disambiguation / short-circuit flags.
 *
 * Transport errors are re-thrown — the caller must surface an Ollama-error
 * Notice.  All other classifier errors are encoded in the decision.
 */
export async function classifyTurn(
  input: ClassifyTurnInput,
  deps: ClassifyTurnDeps,
  turnId: string,
): Promise<RouteDecision> {
  const start = performance.now();
  const thresholds = deps.thresholds ?? DEFAULT_CLASSIFIER_THRESHOLDS;

  // ── 1. Skip router ──────────────────────────────────────────────────

  const skipResult = classifySkipRouter({
    messageText: input.messageText,
    attachments: input.attachments,
    ctrlEnter: input.ctrlEnter,
    presetCommand: input.presetCommand,
  });

  if (skipResult !== null) {
    return handleSkip(skipResult, input, turnId, start, deps);
  }

  // ── 2. LLM classification ───────────────────────────────────────────

  return handleLLM(input, turnId, start, deps, thresholds);
}

// ─── Skip path ─────────────────────────────────────────────────────────

async function handleSkip(
  result: NonNullable<ReturnType<typeof classifySkipRouter>>,
  input: ClassifyTurnInput,
  turnId: string,
  start: number,
  deps: ClassifyTurnDeps,
): Promise<RouteDecision> {
  // Empty message with no attachments — error, no label.
  if (result.kind === "error") {
    const decision = makeDecision({
      source: "skip",
      input: { messageText: "", truncated: false, attachments: [], activeFile: null, recentTurns: [] },
      label: null,
      confidence: null,
      latencyMs: Math.round(performance.now() - start),
      promptVersion: "",
      skipReason: null,
      fallbackReason: null,
      needsDisambiguation: false,
    });
    return {
      turnId,
      label: null,
      decision,
      needsDisambiguation: false,
      shortCircuit: false,
    };
  }

  // Hard-signal skip — bypass LLM, label is always confident.
  const classifierInput = prepareClassifierInput({
    messageText: result.strippedText ?? input.messageText,
    attachments: input.attachments,
    activeFile: input.activeFile,
    recentTurns: input.recentTurns,
  });

  const decision = makeDecision({
    source: "skip",
    input: classifierInput,
    label: result.label,
    confidence: 1.0,
    latencyMs: Math.round(performance.now() - start),
    promptVersion: "",
    skipReason: result.reason,
    fallbackReason: null,
    needsDisambiguation: false,
  });

  // Meta from skip router is not possible in the current taxonomy —
  // skip conditions only produce capture or ask.
  const isMeta = result.label === "meta";

  await writeDecisionEvent(turnId, decision, deps.eventWriter);

  return {
    turnId,
    label: result.label,
    decision,
    needsDisambiguation: false,
    shortCircuit: isMeta,
    helpResponse: isMeta ? META_HELP_RESPONSE : undefined,
  };
}

// ─── LLM path ──────────────────────────────────────────────────────────

async function handleLLM(
  input: ClassifyTurnInput,
  turnId: string,
  start: number,
  deps: ClassifyTurnDeps,
  thresholds: ClassifierThresholds,
): Promise<RouteDecision> {
  const classifierInput = prepareClassifierInput({
    messageText: input.messageText,
    attachments: input.attachments,
    activeFile: input.activeFile,
    recentTurns: input.recentTurns,
  });

  let result: Awaited<ReturnType<typeof classifyWithRetries>>;
  try {
    result = await classifyWithRetries(classifierInput, {
      llm: deps.llm,
      promptLoader: deps.promptLoader,
    });
  } catch (err) {
    // Transport errors — re-throw for the caller to surface a Notice.
    throw err;
  }

  const latencyMs = result.latencyMs;

  // ── Fallback (null output) ────────────────────────────────────────

  if (result.output === null) {
    const decision = makeDecision({
      source: "llm",
      input: classifierInput,
      label: null,
      confidence: null,
      latencyMs,
      promptVersion: result.promptVersion,
      skipReason: null,
      fallbackReason: result.fallbackReason ?? null,
      needsDisambiguation: true,
    });

    await writeDecisionEvent(turnId, decision, deps.eventWriter);

    return {
      turnId,
      // Fallback: route to "ask" so the user at least gets a query
      // attempt rather than a silent failure.  The disambiguation chip
      // is shown because we have no confident label.
      label: "ask",
      decision,
      needsDisambiguation: true,
      shortCircuit: false,
    };
  }

  // ── Success ───────────────────────────────────────────────────────

  const { label, confidence } = result.output;
  const confident = isConfident(label, confidence, thresholds);
  const isMeta = label === "meta";

  const decision = makeDecision({
    source: "llm",
    input: classifierInput,
    label,
    confidence,
    latencyMs,
    promptVersion: result.promptVersion,
    skipReason: null,
    fallbackReason: null,
    needsDisambiguation: !confident,
  });

  await writeDecisionEvent(turnId, decision, deps.eventWriter);

  return {
    turnId,
    label,
    decision,
    needsDisambiguation: !confident,
    shortCircuit: isMeta,
    helpResponse: isMeta ? META_HELP_RESPONSE : undefined,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface MakeDecisionParams {
  source: ClassifierSource;
  input: ClassifierInput;
  label: IntentLabel | null;
  confidence: number | null;
  latencyMs: number;
  promptVersion: string;
  skipReason: SkipReason | null;
  fallbackReason: ClassifierDecision["fallbackReason"];
  needsDisambiguation: boolean;
}

function makeDecision(params: MakeDecisionParams): ClassifierDecision {
  return {
    source: params.source,
    input: params.input,
    output:
      params.label && params.confidence !== null
        ? { label: params.label, confidence: params.confidence, rationale: "" }
        : null,
    latencyMs: params.latencyMs,
    promptVersion: params.promptVersion,
    skipReason: params.skipReason,
    needsDisambiguation: params.needsDisambiguation,
    fallbackReason: params.fallbackReason,
  };
}

async function writeDecisionEvent(
  turnId: string,
  decision: ClassifierDecision,
  writer: ClassifierEventWriter,
): Promise<void> {
  const row = toDecisionRow(turnId, {
    source: decision.source,
    skipReason: decision.skipReason,
    promptVersion: decision.promptVersion,
    latencyMs: decision.latencyMs,
    input: decision.input,
    output: decision.output,
    confidence: decision.output?.confidence ?? null,
    label: decision.output?.label ?? null,
  });
  await writer.writeDecision(row);
}
