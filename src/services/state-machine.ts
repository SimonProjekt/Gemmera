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
  private abortController = new AbortController();

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
    if (!this.states.get(config.errorBoundedEventsState)!.terminal) {
      throw new Error(
        `errorBoundedEventsState ${config.errorBoundedEventsState} must be terminal`,
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
    if (config.timer) {
      const { budgetMs, terminalState } = config.timer;
      if (budgetMs <= 0 || budgetMs > 300_000) {
        throw new Error(
          `Timer budgetMs must be in (0, 300000] ms per planning/tool-loop.md, got ${budgetMs}`,
        );
      }
      if (!this.states.has(terminalState)) {
        throw new Error(
          `Timer references unknown terminal state: ${terminalState}`,
        );
      }
    }
    for (const s of config.states) {
      if (s.retry && s.terminal) {
        throw new Error(
          `State ${s.name} cannot be both terminal and have retry config`,
        );
      }
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
      await this.transitionTo(this.config.errorBoundedEventsState, {
        kind: "limit",
        name: "bounded_events",
        payload: {
          state: fromState,
          limit: fromDef.maxEventsPerTurn,
          value: newCount,
        },
      });
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

  // Increment a per-turn counter. The transition fires when the counter
  // strictly exceeds `limit` — i.e. `limit` is the maximum allowed value,
  // so `limit: 10` permits 10 bumps and the 11th triggers the terminal.
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
    // Log every bump so replay can reconstruct counter-triggered turns.
    await this.writeLog("bump", {
      turnId: this.active.turnId,
      state: this.active.currentState,
      fromState: this.active.currentState,
      triggeringEvent: { kind: "limit", name, payload: { value: next } },
      signal: this.abortController.signal,
    });
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
    // Abort first so any in-flight LLM/tool work in onEnter/onExit
    // releases before the transition cascade runs.
    this.abortController.abort();
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
    this.abortController = new AbortController();
    const ctx: StateContext = {
      turnId,
      state: initial,
      fromState: null,
      triggeringEvent: null,
      signal: this.abortController.signal,
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
    // Re-check active here: a dispatch() can complete a terminal transition
    // before this fires, in which case active is null and we no-op. The
    // setTimeout callback can also race with an in-flight dispatch on
    // longer hook chains; serializing transitions via a lock is the
    // principled fix once concurrent driving becomes a real scenario.
    if (!this.active) return;
    this.abortController.abort();
    await this.transitionTo(terminalState, {
      kind: "timer",
      name: "turn_timeout",
    });
  }

  private async transitionTo(
    toState: string,
    triggeringEvent: StateMachineEvent,
  ): Promise<void> {
    if (!this.active) {
      throw new Error("transitionTo called with no active turn");
    }
    const active = this.active;
    const turnId = active.turnId;
    const fromState = active.currentState;
    const fromDef = this.states.get(fromState)!;
    const toDef = this.states.get(toState)!;

    const signal = this.abortController.signal;
    const exitCtx: StateContext = {
      turnId,
      state: fromState,
      fromState,
      triggeringEvent,
      signal,
    };
    await this.writeLog("exit", exitCtx);
    await fromDef.onExit?.(exitCtx);

    active.currentState = toState;

    const enterCtx: StateContext = {
      turnId,
      state: toState,
      fromState,
      triggeringEvent,
      signal,
    };
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
    // Abort first so any in-flight LLM/tool calls release before the
    // ordered unwind runs. Idempotent — cancel/timeout may have already
    // aborted before reaching here.
    this.abortController.abort();
    const u = this.config.unwind;
    if (!u) return;
    // Best-effort: each hook is isolated so one failure does not strand
    // the remaining hooks, the timer, or the queue.
    await safeRun(() => u.stopModelStream?.(ctx));
    await safeRun(() => u.dropPendingToolResults?.(ctx));
    await safeRun(() => u.rollbackUnconfirmedWrites?.(ctx));
    await safeRun(() => u.writeEvents?.(ctx));
    await safeRun(() => u.surfaceNotice?.(ctx));
  }
}

function transitionKey(from: string, kind: string, name: string): string {
  return `${from}|${kind}|${name}`;
}

async function safeRun(
  fn: () => void | Promise<void> | undefined,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Unwind hook failed:", err);
  }
}
