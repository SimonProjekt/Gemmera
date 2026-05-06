/**
 * Contracts for the ingest tool loop (#13). The shape that
 * `IngestOrchestrator` produces and the preview modal consumes. Mirrors the
 * frontmatter contract in planning/rag.md §"Frontmatter contract".
 */

export type NoteType =
  | "source"
  | "evergreen"
  | "project"
  | "meeting"
  | "person"
  | "concept";

export type NoteSource =
  | "chat-paste"
  | "pdf"
  | "webpage"
  | "image"
  | "audio"
  | "manual";

export type CoworkConfidence = "high" | "medium" | "low";

/**
 * Structured candidate produced by the ingest parser. Validated against
 * `prompts/ingest-parser.schema.json` before reaching the writer.
 */
export interface NoteSpec {
  title: string;
  type: NoteType;
  tags: string[];
  aliases: string[];
  source: NoteSource;
  entities: string[];
  /** Suggested related note paths from retrieve_similar_notes. */
  related: string[];
  status: "inbox" | "processed" | "linked" | "archived";
  summary: string;
  key_points: string[];
  body_markdown: string;
  cowork: {
    source: "ingest" | "synthesis";
    run_id: string;
    model: string;
    version: string;
    confidence: CoworkConfidence;
  };
}

/**
 * Decision the strategy step makes after parse + search_similar.
 *
 * - `create`: write a new note. `related` carries any link suggestions.
 * - `append`: append the body under a dated heading in `target`.
 * - `dedup_ask`: a near or exact duplicate exists; the preview modal asks
 *    the user to append, save anyway, or cancel. `target` is the matched note.
 */
export type IngestStrategy =
  | { kind: "create"; related: string[] }
  | { kind: "append"; target: string }
  | { kind: "dedup_ask"; target: string; similarity: number };

/** What the user picked in the dedup modal. */
export type DedupChoice = "append" | "save_anyway" | "cancel";

export interface IngestInput {
  /** Raw user content (chat paste, drop, etc). */
  text: string;
  /** Optional explicit instruction ("save this as a meeting note"). */
  instruction?: string;
}

export type IngestOutcome =
  | { kind: "saved"; path: string; mode: "create" | "append"; spec: NoteSpec }
  | { kind: "skipped_existing"; path: string; reason: "exact_duplicate" }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: string };
