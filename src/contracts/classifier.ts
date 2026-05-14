/**
 * Classifier input/output contracts — single module consumed by both the
 * classifier call site and the eval harness. Matches the contract in
 * planning/classifier.md §"Input contract" and §"Output contract".
 *
 * LIFECYCLE: Every struct in this file is serialisable and must be safe
 * to store in events.duckdb (see #19).
 */

// ─── Taxonomy ────────────────────────────────────────────────────────

export type IntentLabel = "capture" | "ask" | "mixed" | "meta";

// ─── Input ────────────────────────────────────────────────────────────

export type AttachmentKind = "pdf" | "image" | "audio" | "text";

export interface Attachment {
  kind: AttachmentKind;
  filename: string;
}

export interface ActiveFile {
  filename: string;
  title: string;
}

export interface RecentTurn {
  text: string;
  intent: IntentLabel;
}

export interface ClassifierInput {
  /** Full message text, truncated to 8 KB with a visible marker. */
  messageText: string;
  /** True when the message was truncated by the pre-processor. */
  truncated: boolean;
  /** Attachments the user attached to the message (contents NOT included). */
  attachments: Attachment[];
  /** Currently open note, if any. */
  activeFile: ActiveFile | null;
  /** Last 3 chat turns (user text + final intent label). Always at most 3. */
  recentTurns: RecentTurn[];
}

// ─── Output ───────────────────────────────────────────────────────────

export interface ClassifierOutput {
  label: IntentLabel;
  /** Model-reported confidence in [0.0, 1.0]. */
  confidence: number;
  /** One-line human-readable rationale for the label. */
  rationale: string;
}

// ─── Skip router ──────────────────────────────────────────────────────

/** Known reason codes emitted when the classifier is short-circuited by a
 *  hard signal.  These are stored in `skip_reason` / `skipReason` fields. */
export type SkipReason =
  | "empty-message"
  | "attachment-only"
  | "command-capture"
  | "command-ask"
  | "ctrl-enter"
  | "leading-question-mark";

/** Result of running the skip router. */
export type SkipRouterResult =
  | { kind: "error"; error: "empty-message" }
  | { kind: "skip"; label: IntentLabel; reason: SkipReason; strippedText?: string }
  | null;

/** Commands that carry a preset intent and bypass the LLM classifier. */
export type PresetCommand =
  | "cowork.capture-selection"
  | "cowork.capture-active-note"
  | "cowork.ask-about-active-note";

// ─── Confidence thresholds ────────────────────────────────────────────

/** Per-label confidence thresholds. When confidence falls below the
 *  label's threshold, the disambiguation chip is shown. */
export interface ClassifierThresholds {
  capture: number;
  ask: number;
  mixed: number;
  meta: number;
}

/** Anchor values from planning/classifier.md §"Confidence thresholds".
 *  Committed values land after the first golden-set run during M1. */
export const DEFAULT_CLASSIFIER_THRESHOLDS: ClassifierThresholds = {
  capture: 0.85,
  ask: 0.70,
  mixed: 0.75,
  meta: 0.70,
};

// ─── Decision log entry (upstream of #19 event-log schema) ────────────

/** Source of a classifier decision. "skip" means a hard signal pre-empted
 *  the LLM call; "llm" means the model produced the output. */
export type ClassifierSource = "skip" | "llm";

export interface ClassifierDecision {
  source: ClassifierSource;
  input: ClassifierInput;
  output: ClassifierOutput | null;
  /** Wall-clock ms from input arrival to decision ready. */
  latencyMs: number;
  /** Prompt version ID from the intent-classifier prompt file. */
  promptVersion: string;
  /**
   * Reason code when source === "skip". Null for LLM-sourced decisions.
   * Examples: "empty-message", "attachment-only", "command-capture",
   * "ctrl-enter", "leading-question-mark".
   */
  skipReason: SkipReason | null;
  /**
   * True when the confidence is below the active threshold and the
   * disambiguation chip should be shown.  Always false for skip-path
   * decisions and true for LLM fallbacks (null output).
   */
  needsDisambiguation: boolean;
  /**
   * Reason for LLM fallback — set when output is null and the LLM call
   * failed (timeout, unparseable, invalid-label, invalid-confidence).
   * Null for skip-path decisions and successful LLM calls.
   */
  fallbackReason: "timeout" | "unparseable" | "invalid-label" | "invalid-confidence" | null;
}

// ─── Event-log rows (#19) ─────────────────────────────────────────────

/**
 * Flattened row written to the `classifier_decision` DuckDB table.
 * `input_json` and `output_json` are JSON-serialised `ClassifierInput`
 * and `ClassifierOutput | null` respectively.
 */
export interface ClassifierDecisionRow {
  turn_id: string;
  ts: number;
  source: ClassifierSource;
  skip_reason: SkipReason | null;
  prompt_version: string;
  input_json: string;
  output_json: string | null;
  latency_ms: number;
  confidence: number | null;
  label: IntentLabel | null;
}

/**
 * Row written to the `classifier_disambiguation` table when the user
 * corrects a low-confidence classification via the disambiguation chip.
 *
 * `original_label` and `original_confidence` are nullable because the chip
 * also fires on fallback decisions (timeout / unparseable / invalid-label /
 * invalid-confidence) where the model emitted no usable output. For those
 * rows the original-side is null; the fallback reason can be joined from
 * `classifier_decision.fallback_reason` via `turn_id`. Eval queries that
 * count "model-vs-user" corrections should filter `original_label IS NOT NULL`.
 */
export interface ClassifierDisambiguationRow {
  turn_id: string;
  ts: number;
  original_label: IntentLabel | null;
  original_confidence: number | null;
  /** The label the user chose, or null when they cancelled. */
  chosen_label: IntentLabel | null;
  /** True when the user dismissed the chip without choosing a label. */
  cancelled: boolean;
}

/** Writer contract for classifier event rows. Implementations write to
 *  DuckDB (#35), an in-memory buffer for testing, or the turn inspector. */
export interface ClassifierEventWriter {
  writeDecision(row: ClassifierDecisionRow): Promise<void>;
  writeDisambiguation(row: ClassifierDisambiguationRow): Promise<void>;
}

// ─── Route decision (#79) ──────────────────────────────────────────────

/**
 * Result of running the full classifier pipeline (skip router → LLM →
 * confidence check) against a single turn.  Returned by the classifier
 * orchestrator and consumed by the turn router to dispatch into the
 * ingest / query / meta state machines.
 */
export interface RouteDecision {
  /** Owning turn id so the caller does not need to thread it separately. */
  turnId: string;

  /**
   * Final intent label after all processing.
   * - `null` when the skip router returned an error (empty message).
   * - `"meta"` when the orchestrator short-circuits to help.
   * - Otherwise the validated or fallback label.
   */
  label: IntentLabel | null;

  /**
   * Full classifier decision for the turn inspector and the event log.
   * Always populated — even for empty-message errors, so the inspector
   * can show the attempted classification.
   */
  decision: ClassifierDecision;

  /**
   * True when the confidence is below the active threshold and the
   * disambiguation chip should be shown to the user.  Always false for
   * skip-path decisions and true for LLM fallbacks (null output).
   */
  needsDisambiguation: boolean;

  /**
   * True when the orchestrator should short-circuit the main tool loop
   * and render a response directly (currently only `"meta"`).
   */
  shortCircuit: boolean;

  /**
   * Static help text rendered when `shortCircuit` is true.  Undefined
   * for non-meta routes.
   */
  helpResponse?: string;
}
