import {
  ActiveTurn,
  EventLogEntry,
  EventLogEntryKind,
  PerTurnLimit,
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
  private limits = new Map<string, PerTurnLimit>();
  private counterValues = new Map<string, number>();
  private retryCounts = new Map<string, number>();
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

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
    for (const l of config.limits ?? []) {
      if (this.limits.has(l.name)) {
        throw new Error(`Duplicate limit: ${l.name}`);
      }
      if (!this.states.has(l.terminalState)) {
        throw new Error(
          `Limit ${l.name} references unknown terminal state: ${l.terminalState}`,
        );
      }
      this.limits.set(l.name, l);
    }
    if (
      config.timer &&
      !this.states.has(config.timer.terminalState)
    ) {
      throw new Error(
        `Timer references unknown terminal state: ${config.timer.terminalState}`,
      );
    }
    for (const s of config.states) {
      if (s.retry && !this.states.has(s.retry.onExhausted)) {
        throw new Error(
          `State ${s.name} retry references unknown state: ${s.retry.onExhausted}`,
        );
      }
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

  // Increment a per-turn counter. If the new value exceeds the configured
  // limit, the state machine transitions to the limit's terminal state.
  async bumpCounter(name: string): Promise<void> {
    if (!this.active) {
      throw new Error("No active turn");
    }
    const limit = this.limits.get(name);
    if (!limit) {
      throw new Error(`Counter not registered: ${name}`);
    }
    const next = (this.counterValues.get(name) ?? 0) + 1;
    this.counterValues.set(name, next);
    if (next > limit.limit) {
      await this.transitionTo(limit.terminalState, {
        kind: "limit",
        name,
        payload: { limit: limit.limit, value: next },
      });
    }
  }

  // Reset a per-turn counter to zero. Used for "consecutive" counters
  // (e.g. consecutive no-ops) that reset when the streak breaks.
  resetCounter(name: string): void {
    if (!this.limits.has(name)) {
      throw new Error(`Counter not registered: ${name}`);
    }
    this.counterValues.set(name, 0);
  }

  // Cancel the active turn. Transitions immediately to the cancellation
  // terminal state (default "CANCELLED") via the shared unwind from #34.
  // No-op if no turn is active.
  async cancel(terminalState: string = "CANCELLED"): Promise<void> {
    if (!this.active) return;
    if (!this.states.has(terminalState)) {
      throw new Error(`Cancel terminal state not defined: ${terminalState}`);
    }
    await this.transitionTo(terminalState, {
      kind: "user_action",
      name: "cancel",
    });
  }

  // Retry the current state. Re-enters the same state via onExit/onEnter and
  // increments a per-state retry counter. When the counter exceeds the state's
  // `retry.max`, the state machine transitions to `retry.onExhausted` instead.
  // If a per-turn `"retry"` limit is configured, retry() also bumps it so the
  // global retry budget is enforced (see planning/tool-loop.md "Hard stops").
  async retry(): Promise<void> {
    if (!this.active) {
      throw new Error("No active turn");
    }
    const stateDef = this.states.get(this.active.currentState)!;
    if (!stateDef.retry) {
      throw new Error(`State ${stateDef.name} does not allow retries`);
    }

    const next = (this.retryCounts.get(stateDef.name) ?? 0) + 1;
    this.retryCounts.set(stateDef.name, next);

    if (next > stateDef.retry.max) {
      await this.transitionTo(stateDef.retry.onExhausted, {
        kind: "retry",
        name: "exhausted",
        payload: { state: stateDef.name, attempts: next },
      });
      return;
    }

    if (this.limits.has("retry")) {
      await this.bumpCounter("retry");
      if (!this.active) return;
    }

    await this.transitionTo(stateDef.name, {
      kind: "retry",
      name: "again",
      payload: { attempt: next },
    });
  }

  private async beginTurn(turnId: string): Promise<ActiveTurn> {
    const initial = this.config.initialState;
    this.active = { turnId, currentState: initial };
    this.eventCounts.clear();
    this.counterValues.clear();
    this.retryCounts.clear();
    const ctx: StateContext = {
      turnId,
      state: initial,
      fromState: null,
      triggeringEvent: null,
    };
    await this.writeLog("enter", ctx);
    await this.states.get(initial)!.onEnter?.(ctx);
    if (this.config.timer) {
      const { budgetMs, terminalState } = this.config.timer;
      this.timeoutId = setTimeout(() => {
        void this.handleTimeout(terminalState);
      }, budgetMs);
    }
    return this.active;
  }

  private async handleTimeout(terminalState: string): Promise<void> {
    if (!this.active) return;
    await this.transitionTo(terminalState, {
      kind: "timer",
      name: "turn_timeout",
    });
  }

  private async transitionTo(
    toState: string,
    triggeringEvent: StateMachineEvent,
  ): Promise<void> {
    const turnId = this.active!.turnId;
    const fromState = this.active!.currentState;
    const fromDef = this.states.get(fromState)!;
    const toDef = this.states.get(toState)!;

    const exitCtx: StateContext = { turnId, state: fromState, fromState, triggeringEvent };
    await this.writeLog("exit", exitCtx);
    await fromDef.onExit?.(exitCtx);

    this.active!.currentState = toState;

    const enterCtx: StateContext = { turnId, state: toState, fromState, triggeringEvent };
    await this.writeLog("enter", enterCtx);
    await toDef.onEnter?.(enterCtx);

    if (toDef.terminal) {
      await this.runUnwind(enterCtx);
      this.clearTimer();
      this.active = null;
      this.eventCounts.clear();
      this.counterValues.clear();
      this.retryCounts.clear();
      const next = this.queue.shift();
      if (next) {
        await this.beginTurn(next.turnId);
      }
    }
  }

  private clearTimer(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private async writeLog(
    kind: EventLogEntryKind,
    ctx: StateContext,
  ): Promise<void> {
    if (!this.config.eventLog) return;
    const entry: EventLogEntry = {
      turnId: ctx.turnId,
      kind,
      state: ctx.state,
      fromState: ctx.fromState,
      timestamp: Date.now(),
      triggeringEvent: ctx.triggeringEvent,
    };
    const final = this.config.redactEvent ? this.config.redactEvent(entry) : entry;
    await this.config.eventLog.write(final);
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
