/**
 * State → human-readable UI label mapping for #66.
 *
 * Every named state in the ingest, query, and destructive-op state machines
 * maps to a short, past-tense-free status string that the chat view renders
 * as a status chip while the turn is live. Terminal states map to strings
 * suitable for a final Notice.
 */
export const STATE_LABELS: Record<string, string> = {
  // ── Shared / classifier ───────────────────────────────────────────────
  CLASSIFY_INTENT: "Thinking…",

  // ── Ingest state machine ──────────────────────────────────────────────
  PARSE_CONTENT: "Reading your note…",
  SEARCH_SIMILAR: "Searching for similar notes…",
  DECIDE_STRATEGY: "Deciding what to do…",
  PREVIEW: "Ready for review",
  WRITE: "Saving…",
  UPDATE_INDEX: "Indexing…",

  // ── Query state machine ───────────────────────────────────────────────
  PLAN_RETRIEVAL: "Planning search…",
  RETRIEVE: "Searching notes…",
  RERANK: "Reranking…",
  ASSEMBLE_CONTEXT: "Assembling context…",
  GENERATE: "Generating answer…",
  VALIDATE_CITATIONS: "Validating citations…",
  RETRY_WITH_CONSTRAINED_CITATIONS: "Fixing citations…",
  PRESENT: "Presenting answer…",

  // ── Destructive-op mini state machine ─────────────────────────────────
  CONFIRM: "Waiting for confirmation…",
  EXECUTE: "Executing…",

  // ── Terminal states ───────────────────────────────────────────────────
  DONE: "Done",
  CANCELLED: "Cancelled",
  TIMED_OUT: "Timed out",
  MODEL_INVALID_OUTPUT: "Model returned an unexpected response",
  TOOL_FAILED: "Tool error",
  VALIDATION_FAILED: "Validation failed",
} as const;

/**
 * Returns the UI label for `state`, falling back to the raw state name
 * for any state not in the map (e.g. future states added by teammates).
 */
export function labelForState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/**
 * Injected into orchestrator deps so the chat view can update its status
 * chip in real time as the turn progresses through states.
 *
 * Called once per state entry (from → to), matching the event-log entries.
 * UI implementations must be synchronous and non-blocking — the orchestrator
 * does not await this callback.
 */
export type TurnStatusCallback = (state: string, label: string) => void;

// ── Turn inspector data helpers ────────────────────────────────────────────────

export interface InspectorEntry {
  state: string;
  label: string;
  fromState: string | null;
  timestamp: number;
  /** ISO-formatted timestamp for display. */
  time: string;
  payloadPreview: string | null;
}

/**
 * Converts raw event log entries into a display-ready list for the turn
 * inspector. Only `enter` entries are shown (exit entries are internal
 * bookkeeping not meaningful to users).
 */
export function formatInspectorEntries(
  entries: ReadonlyArray<{
    kind: string;
    state: string;
    fromState: string | null;
    timestamp: number;
    triggeringEvent: { payload?: unknown } | null;
  }>,
): InspectorEntry[] {
  return entries
    .filter((e) => e.kind === "enter")
    .map((e) => ({
      state: e.state,
      label: labelForState(e.state),
      fromState: e.fromState,
      timestamp: e.timestamp,
      time: new Date(e.timestamp).toISOString(),
      payloadPreview: summarisePayload(e.triggeringEvent?.payload),
    }));
}

function summarisePayload(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  try {
    const str = JSON.stringify(payload);
    return str.length > 120 ? str.slice(0, 119) + "…" : str;
  } catch {
    return null;
  }
}
