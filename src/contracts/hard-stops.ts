// Canonical per-turn ceilings from planning/tool-loop.md "Hard stops".
// Pinned here so concrete state machines (#39, #41) and tool dispatchers
// share the same numbers and the values do not drift between teammates.
export const HARD_STOPS = {
  // Maximum tool calls per turn.
  MAX_TOOL_CALLS_PER_TURN: 10,
  // Default wall-clock budget per turn, in milliseconds.
  WALL_CLOCK_MS_PER_TURN: 120_000,
  // Maximum allowed wall-clock budget per turn, in milliseconds.
  WALL_CLOCK_MS_MAX: 300_000,
  // Maximum consecutive no-op model responses per turn.
  MAX_CONSECUTIVE_NO_OPS: 3,
  // Maximum retries across the whole turn.
  MAX_RETRIES_PER_TURN: 3,
  // Maximum compacted retrieval payload size, in bytes.
  MAX_RETRIEVAL_PAYLOAD_BYTES: 16_384,
} as const;
