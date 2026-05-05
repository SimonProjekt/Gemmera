export type StateMachineEventKind =
  | "user_action"
  | "tool_result"
  | "timer"
  | "model_output"
  | "limit"
  | "retry";

export interface StateMachineEvent {
  kind: StateMachineEventKind;
  name: string;
  payload?: unknown;
}

export interface StateContext {
  turnId: string;
  state: string;
  fromState: string | null;
  triggeringEvent: StateMachineEvent | null;
  // Aborts when the turn enters a terminal state (cancel, timeout, error).
  // onEnter/onExit handlers should forward this to LLM/tool calls so they
  // release promptly when the turn ends.
  signal: AbortSignal;
}

export interface StateDefinition {
  name: string;
  maxEventsPerTurn: number;
  terminal?: boolean;
  onEnter?: (ctx: StateContext) => void | Promise<void>;
  onExit?: (ctx: StateContext) => void | Promise<void>;
  // Retry policy. When `sm.retry()` is called, the framework re-enters this
  // state via the unwind/enter path and increments a per-state retry counter.
  // When the counter exceeds `max`, the state machine transitions to
  // `onExhausted` instead of re-entering. See planning/tool-loop.md "Retry
  // policy" for the mapping of states to retry budgets.
  retry?: {
    max: number;
    onExhausted: string;
  };
}

export interface TransitionDefinition {
  from: string;
  on: { kind: StateMachineEventKind; name: string };
  to: string;
}

export interface StateMachineConfig {
  states: StateDefinition[];
  transitions: TransitionDefinition[];
  initialState: string;
  errorBoundedEventsState: string;
  unwind?: UnwindHooks;
  eventLog?: EventLog;
  // Sensitive-content redaction at the writer boundary. If provided, each
  // entry is passed through this function before being written.
  redactEvent?: (entry: EventLogEntry) => EventLogEntry;
  // Per-turn hard stops. The framework enforces these ceilings and
  // transitions to the configured terminal state when any is exceeded.
  // See planning/tool-loop.md "Hard stops".
  timer?: PerTurnTimer;
  limits?: PerTurnLimit[];
}

export interface PerTurnTimer {
  // Wall-clock budget per turn in milliseconds.
  budgetMs: number;
  // Terminal state entered when the budget is exceeded.
  terminalState: string;
}

export interface PerTurnLimit {
  // Counter name. Consumers call `sm.bumpCounter(name)` to increment.
  name: string;
  // Maximum allowed value before the limit is considered exceeded.
  limit: number;
  // Terminal state entered when the limit is exceeded.
  terminalState: string;
}

// Canonical terminal state names per planning/tool-loop.md.
export const TERMINAL_STATES = [
  "DONE",
  "CANCELLED",
  "TIMED_OUT",
  "MODEL_INVALID_OUTPUT",
  "TOOL_FAILED",
  "VALIDATION_FAILED",
] as const;

export type TerminalStateName = (typeof TERMINAL_STATES)[number];

// Hooks invoked in fixed order on entry to any terminal state:
// stop model stream → drop pending tool results → roll back unconfirmed
// writes → write events → surface notice. The framework then closes the turn.
export interface UnwindHooks {
  stopModelStream?: (ctx: StateContext) => void | Promise<void>;
  dropPendingToolResults?: (ctx: StateContext) => void | Promise<void>;
  rollbackUnconfirmedWrites?: (ctx: StateContext) => void | Promise<void>;
  writeEvents?: (ctx: StateContext) => void | Promise<void>;
  surfaceNotice?: (ctx: StateContext) => void | Promise<void>;
}

export interface ActiveTurn {
  turnId: string;
  currentState: string;
}

export interface QueuedTurn {
  turnId: string;
}

export type EventLogEntryKind = "enter" | "exit" | "bump";

// One row written for every state enter and exit. Payload covers the
// triggering event (kind, name, and any tool args / results / model
// output the consumer attaches as `payload`). Used by the turn inspector
// and as the input to deterministic replay.
export interface EventLogEntry {
  turnId: string;
  kind: EventLogEntryKind;
  state: string;
  fromState: string | null;
  timestamp: number;
  triggeringEvent: StateMachineEvent | null;
}

export interface EventLog {
  write(entry: EventLogEntry): void | Promise<void>;
  eventsFor(turnId: string): Promise<readonly EventLogEntry[]>;
}
