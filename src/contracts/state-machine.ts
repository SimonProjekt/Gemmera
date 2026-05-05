export type StateMachineEventKind =
  | "user_action"
  | "tool_result"
  | "timer"
  | "model_output";

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
}

export interface StateDefinition {
  name: string;
  maxEventsPerTurn: number;
  terminal?: boolean;
  onEnter?: (ctx: StateContext) => void | Promise<void>;
  onExit?: (ctx: StateContext) => void | Promise<void>;
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
}

export interface ActiveTurn {
  turnId: string;
  currentState: string;
}

export interface QueuedTurn {
  turnId: string;
}
