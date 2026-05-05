import {
  ClassifierDecisionRow,
  ClassifierDisambiguationRow,
  ClassifierEventWriter,
} from "../contracts/classifier";

// ─── DuckDB DDL ───────────────────────────────────────────────────────

/** SQL to create the `classifier_decision` table. Idempotent via
 *  `CREATE TABLE IF NOT EXISTS`. Columns match `ClassifierDecisionRow`. */
export const CLASSIFIER_DECISION_DDL = [
  "CREATE TABLE IF NOT EXISTS classifier_decision (",
  "  turn_id      TEXT NOT NULL,",
  "  ts           INTEGER NOT NULL,",
  "  source       TEXT NOT NULL,",
  "  skip_reason  TEXT,",
  "  prompt_version TEXT NOT NULL,",
  "  input_json   TEXT NOT NULL,",
  "  output_json  TEXT,",
  "  latency_ms   INTEGER NOT NULL,",
  "  confidence   REAL,",
  "  label        TEXT",
  ");",
].join("\n");

/** SQL to create the `classifier_disambiguation` table. Idempotent. */
export const CLASSIFIER_DISAMBIGUATION_DDL = [
  "CREATE TABLE IF NOT EXISTS classifier_disambiguation (",
  "  turn_id            TEXT NOT NULL,",
  "  ts                 INTEGER NOT NULL,",
  "  original_label     TEXT NOT NULL,",
  "  original_confidence REAL NOT NULL,",
  "  chosen_label       TEXT,",
  "  cancelled          INTEGER NOT NULL DEFAULT 0",
  ");",
].join("\n");

/** Ordered set of classifier-related DDL statements for migration runs. */
export const CLASSIFIER_DDL = [
  CLASSIFIER_DECISION_DDL,
  CLASSIFIER_DISAMBIGUATION_DDL,
];

// ─── In-memory writer ──────────────────────────────────────────────────

/**
 * In-memory implementation of `ClassifierEventWriter`. Stores rows in
 * insertion order for testing and replay. Not for production — rows are
 * lost on process exit.
 */
export class InMemoryClassifierEventWriter implements ClassifierEventWriter {
  decisions: ClassifierDecisionRow[] = [];
  disambiguations: ClassifierDisambiguationRow[] = [];

  async writeDecision(row: ClassifierDecisionRow): Promise<void> {
    this.decisions.push({ ...row });
  }

  async writeDisambiguation(row: ClassifierDisambiguationRow): Promise<void> {
    this.disambiguations.push({ ...row });
  }

  /** Drop all stored rows. */
  clear(): void {
    this.decisions = [];
    this.disambiguations = [];
  }
}

// ─── Row helpers ───────────────────────────────────────────────────────

/**
 * Build a `ClassifierDecisionRow` from an in-memory `ClassifierDecision`
 * plus the owning `turnId`. Serialises `input` and `output` to JSON so
 * the row is ready to write.
 */
export function toDecisionRow(
  turnId: string,
  decision: {
    source: string;
    skipReason: string | null;
    promptVersion: string;
    latencyMs: number;
    input: object;
    output: object | null;
    confidence: number | null;
    label: string | null;
  },
): ClassifierDecisionRow {
  return {
    turn_id: turnId,
    ts: Date.now(),
    source: decision.source as ClassifierDecisionRow["source"],
    skip_reason: decision.skipReason,
    prompt_version: decision.promptVersion,
    input_json: JSON.stringify(decision.input),
    output_json: decision.output ? JSON.stringify(decision.output) : null,
    latency_ms: decision.latencyMs,
    confidence: decision.confidence,
    label: decision.label as ClassifierDecisionRow["label"],
  };
}

/**
 * Build a `ClassifierDisambiguationRow`.
 */
export function toDisambiguationRow(
  turnId: string,
  event: {
    originalLabel: string;
    originalConfidence: number;
    chosenLabel: string | null;
    cancelled: boolean;
  },
): ClassifierDisambiguationRow {
  return {
    turn_id: turnId,
    ts: Date.now(),
    original_label: event.originalLabel as ClassifierDisambiguationRow["original_label"],
    original_confidence: event.originalConfidence,
    chosen_label: event.chosenLabel as ClassifierDisambiguationRow["chosen_label"],
    cancelled: event.cancelled,
  };
}
