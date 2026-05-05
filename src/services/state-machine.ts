import {
  ActiveTurn,
  QueuedTurn,
  StateContext,
  StateDefinition,
  StateMachineConfig,
  StateMachineEvent,
} from "../contracts/state-machine";

export class StateMachine {
  private active: ActiveTurn | null = null;
  private queue: QueuedTurn[] = [];
  private states = new Map<string, StateDefinition>();
  private transitions = new Map<string, string>();
  private eventCounts = new Map<string, number>();

  constructor(private config: StateMachineConfig) {
    for (const s of config.states) {
      this.states.set(s.name, s);
    }
    if (!this.states.has(config.initialState)) {
      throw new Error(`Initial state not defined: ${config.initialState}`);
    }
    if (!this.states.has(config.errorBoundedEventsState)) {
      throw new Error(
        `Bounded-events error state not defined: ${config.errorBoundedEventsState}`,
      );
    }
    for (const t of config.transitions) {
      const key = transitionKey(t.from, t.on.kind, t.on.name);
      if (this.transitions.has(key)) {
        throw new Error(`Duplicate transition: ${key}`);
      }
      this.transitions.set(key, t.to);
    }
  }

  async startTurn(turnId: string): Promise<ActiveTurn | QueuedTurn> {
    if (this.active) {
      const queued: QueuedTurn = { turnId };
      this.queue.push(queued);
      return queued;
    }
    return this.beginTurn(turnId);
  }

  async dispatch(event: StateMachineEvent): Promise<void> {
    if (!this.active) {
      throw new Error("No active turn");
    }
    const fromState = this.active.currentState;
    const fromDef = this.states.get(fromState)!;
    if (fromDef.terminal) {
      throw new Error(`Cannot dispatch from terminal state: ${fromState}`);
    }

    const newCount = (this.eventCounts.get(fromState) ?? 0) + 1;
    this.eventCounts.set(fromState, newCount);
    if (newCount > fromDef.maxEventsPerTurn) {
      await this.transitionTo(this.config.errorBoundedEventsState, event);
      return;
    }

    const toState = this.transitions.get(
      transitionKey(fromState, event.kind, event.name),
    );
    if (!toState) {
      throw new Error(
        `No transition from ${fromState} on ${event.kind}:${event.name}`,
      );
    }
    await this.transitionTo(toState, event);
  }

  getActive(): ActiveTurn | null {
    return this.active;
  }

  getQueue(): readonly QueuedTurn[] {
    return this.queue;
  }

  private async beginTurn(turnId: string): Promise<ActiveTurn> {
    const initial = this.config.initialState;
    this.active = { turnId, currentState: initial };
    this.eventCounts.clear();
    await this.states.get(initial)!.onEnter?.({
      turnId,
      state: initial,
      fromState: null,
      triggeringEvent: null,
    });
    return this.active;
  }

  private async transitionTo(
    toState: string,
    triggeringEvent: StateMachineEvent,
  ): Promise<void> {
    const turnId = this.active!.turnId;
    const fromState = this.active!.currentState;
    const fromDef = this.states.get(fromState)!;
    const toDef = this.states.get(toState)!;

    await fromDef.onExit?.({ turnId, state: fromState, fromState, triggeringEvent });

    this.active!.currentState = toState;

    await toDef.onEnter?.({ turnId, state: toState, fromState, triggeringEvent });

    if (toDef.terminal) {
      await this.runUnwind({ turnId, state: toState, fromState, triggeringEvent });
      this.active = null;
      this.eventCounts.clear();
      const next = this.queue.shift();
      if (next) {
        await this.beginTurn(next.turnId);
      }
    }
  }

  private async runUnwind(ctx: StateContext): Promise<void> {
    const u = this.config.unwind;
    if (!u) return;
    await u.stopModelStream?.(ctx);
    await u.dropPendingToolResults?.(ctx);
    await u.rollbackUnconfirmedWrites?.(ctx);
    await u.writeEvents?.(ctx);
    await u.surfaceNotice?.(ctx);
  }
}

function transitionKey(from: string, kind: string, name: string): string {
  return `${from}|${kind}|${name}`;
}
