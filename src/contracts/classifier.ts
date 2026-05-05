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
  skipReason: string | null;
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
  skip_reason: string | null;
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
 */
export interface ClassifierDisambiguationRow {
  turn_id: string;
  ts: number;
  original_label: IntentLabel;
  original_confidence: number;
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
