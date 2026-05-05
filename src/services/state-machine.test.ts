import { describe, expect, it, vi } from "vitest";
import {
  EventLogEntry,
  StateMachineConfig,
} from "../contracts/state-machine";
import { InMemoryEventLog } from "./event-log";
import { StateMachine } from "./state-machine";

function basicConfig(
  overrides: Partial<StateMachineConfig> = {},
): StateMachineConfig {
  return {
    states: [
      { name: "A", maxEventsPerTurn: 3 },
      { name: "B", maxEventsPerTurn: 3 },
      { name: "DONE", maxEventsPerTurn: 0, terminal: true },
      { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
    ],
    transitions: [
      { from: "A", on: { kind: "user_action", name: "next" }, to: "B" },
      { from: "B", on: { kind: "user_action", name: "next" }, to: "DONE" },
    ],
    initialState: "A",
    errorBoundedEventsState: "ERROR_BOUNDED",
    ...overrides,
  };
}

describe("StateMachine", () => {
  it("starts the initial turn and fires onEnter for the initial state", async () => {
    const onEnter = vi.fn();
    const config = basicConfig();
    config.states[0].onEnter = onEnter;
    const sm = new StateMachine(config);

    const handle = await sm.startTurn("turn-1");

    expect(handle).toEqual({ turnId: "turn-1", currentState: "A" });
    expect(sm.getActive()).toEqual({ turnId: "turn-1", currentState: "A" });
    expect(onEnter).toHaveBeenCalledWith({
      turnId: "turn-1",
      state: "A",
      fromState: null,
      triggeringEvent: null,
    });
  });

  it("queues a second turn while one is active", async () => {
    const sm = new StateMachine(basicConfig());

    await sm.startTurn("turn-1");
    const second = await sm.startTurn("turn-2");

    expect(sm.getActive()?.turnId).toBe("turn-1");
    expect(sm.getQueue()).toHaveLength(1);
    expect(second).toEqual({ turnId: "turn-2" });
  });

  it("starts the queued turn after the current one reaches a terminal state", async () => {
    const sm = new StateMachine(basicConfig());

    await sm.startTurn("turn-1");
    await sm.startTurn("turn-2");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.dispatch({ kind: "user_action", name: "next" });

    expect(sm.getActive()).toEqual({ turnId: "turn-2", currentState: "A" });
    expect(sm.getQueue()).toHaveLength(0);
  });

  it("transitions to the error state when a state's max events is exceeded", async () => {
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 2 },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      transitions: [
        { from: "A", on: { kind: "user_action", name: "stay" }, to: "A" },
      ],
    });
    const sm = new StateMachine(config);

    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "stay" });
    await sm.dispatch({ kind: "user_action", name: "stay" });
    await sm.dispatch({ kind: "user_action", name: "stay" });

    expect(sm.getActive()).toBeNull();
  });

  it("rejects an event with no defined transition from the current state", async () => {
    const sm = new StateMachine(basicConfig());
    await sm.startTurn("turn-1");

    await expect(
      sm.dispatch({ kind: "tool_result", name: "unexpected" }),
    ).rejects.toThrow(/No transition from A/);
  });

  it("rejects dispatch when no turn is active", async () => {
    const sm = new StateMachine(basicConfig());

    await expect(
      sm.dispatch({ kind: "user_action", name: "next" }),
    ).rejects.toThrow(/No active turn/);
  });

  it("rejects dispatch from a terminal state", async () => {
    const sm = new StateMachine(basicConfig());
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.dispatch({ kind: "user_action", name: "next" });

    expect(sm.getActive()).toBeNull();
  });

  it("fires onExit and onEnter with the triggering event payload", async () => {
    const onExitA = vi.fn();
    const onEnterB = vi.fn();
    const config = basicConfig();
    config.states[0].onExit = onExitA;
    config.states[1].onEnter = onEnterB;
    const sm = new StateMachine(config);

    await sm.startTurn("turn-1");
    const event = {
      kind: "user_action" as const,
      name: "next",
      payload: { confirmed: true },
    };
    await sm.dispatch(event);

    expect(onExitA).toHaveBeenCalledWith({
      turnId: "turn-1",
      state: "A",
      fromState: "A",
      triggeringEvent: event,
    });
    expect(onEnterB).toHaveBeenCalledWith({
      turnId: "turn-1",
      state: "B",
      fromState: "A",
      triggeringEvent: event,
    });
  });

  it("throws when initialState is not defined", () => {
    expect(
      () => new StateMachine(basicConfig({ initialState: "MISSING" })),
    ).toThrow(/Initial state not defined: MISSING/);
  });

  it("throws when errorBoundedEventsState is not defined", () => {
    expect(
      () =>
        new StateMachine(
          basicConfig({ errorBoundedEventsState: "MISSING" }),
        ),
    ).toThrow(/Bounded-events error state not defined: MISSING/);
  });

  it("throws when two transitions share the same (from, kind, name)", () => {
    expect(
      () =>
        new StateMachine(
          basicConfig({
            transitions: [
              { from: "A", on: { kind: "user_action", name: "next" }, to: "B" },
              { from: "A", on: { kind: "user_action", name: "next" }, to: "DONE" },
            ],
          }),
        ),
    ).toThrow(/Duplicate transition/);
  });

  it("runs unwind hooks in defined order on entry to a terminal state", async () => {
    const calls: string[] = [];
    const config = basicConfig({
      unwind: {
        stopModelStream: () => {
          calls.push("stopModelStream");
        },
        dropPendingToolResults: () => {
          calls.push("dropPendingToolResults");
        },
        rollbackUnconfirmedWrites: () => {
          calls.push("rollbackUnconfirmedWrites");
        },
        writeEvents: () => {
          calls.push("writeEvents");
        },
        surfaceNotice: () => {
          calls.push("surfaceNotice");
        },
      },
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.dispatch({ kind: "user_action", name: "next" });

    expect(calls).toEqual([
      "stopModelStream",
      "dropPendingToolResults",
      "rollbackUnconfirmedWrites",
      "writeEvents",
      "surfaceNotice",
    ]);
  });

  it.each([
    ["CANCELLED", "STREAMING", "cancel"],
    ["TIMED_OUT", "TOOL_CALLING", "timeout"],
    ["VALIDATION_FAILED", "VALIDATING", "validation_error"],
  ])(
    "passes the terminal state name as unwind reason for %s",
    async (terminal, source, eventName) => {
      const writeEvents = vi.fn();
      const config: StateMachineConfig = {
        states: [
          { name: source, maxEventsPerTurn: 5 },
          { name: terminal, maxEventsPerTurn: 0, terminal: true },
          { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
        ],
        transitions: [
          {
            from: source,
            on: { kind: "user_action", name: eventName },
            to: terminal,
          },
        ],
        initialState: source,
        errorBoundedEventsState: "ERROR_BOUNDED",
        unwind: { writeEvents },
      };
      const sm = new StateMachine(config);
      await sm.startTurn("turn-1");
      await sm.dispatch({ kind: "user_action", name: eventName });

      expect(writeEvents).toHaveBeenCalledTimes(1);
      expect(writeEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          state: terminal,
          fromState: source,
          turnId: "turn-1",
        }),
      );
    },
  );

  it("re-entering a state fires onEnter each time (consumer is responsible for idempotency)", async () => {
    let onEnterCount = 0;
    let sideEffectCount = 0;
    const config: StateMachineConfig = {
      states: [
        {
          name: "WRITE",
          maxEventsPerTurn: 5,
          onEnter: () => {
            onEnterCount += 1;
            if (onEnterCount === 1) sideEffectCount += 1;
          },
        },
        { name: "REVIEW", maxEventsPerTurn: 5 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      transitions: [
        { from: "WRITE", on: { kind: "user_action", name: "review" }, to: "REVIEW" },
        { from: "REVIEW", on: { kind: "user_action", name: "rewrite" }, to: "WRITE" },
      ],
      initialState: "WRITE",
      errorBoundedEventsState: "ERROR_BOUNDED",
    };
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "review" });
    await sm.dispatch({ kind: "user_action", name: "rewrite" });

    expect(onEnterCount).toBe(2);
    expect(sideEffectCount).toBe(1);
  });

  it("writes an enter and exit entry to the event log on each transition", async () => {
    const log = new InMemoryEventLog();
    const sm = new StateMachine(basicConfig({ eventLog: log }));
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.dispatch({ kind: "user_action", name: "next" });

    const entries = await log.eventsFor("turn-1");
    expect(entries.map((e) => `${e.kind}:${e.state}`)).toEqual([
      "enter:A",
      "exit:A",
      "enter:B",
      "exit:B",
      "enter:DONE",
    ]);
    expect(entries[0].triggeringEvent).toBeNull();
    expect(entries[1].triggeringEvent).toEqual({
      kind: "user_action",
      name: "next",
    });
    expect(entries[0].timestamp).toBeTypeOf("number");
  });

  it("passes each entry through redactEvent before writing", async () => {
    const log = new InMemoryEventLog();
    const sm = new StateMachine(
      basicConfig({
        eventLog: log,
        redactEvent: (e: EventLogEntry) => ({
          ...e,
          triggeringEvent: e.triggeringEvent && {
            ...e.triggeringEvent,
            payload: "[REDACTED]",
          },
        }),
      }),
    );
    await sm.startTurn("turn-1");
    await sm.dispatch({
      kind: "user_action",
      name: "next",
      payload: { secret: "hunter2" },
    });

    const entries = await log.eventsFor("turn-1");
    const exitA = entries.find((e) => e.kind === "exit" && e.state === "A");
    expect(exitA?.triggeringEvent?.payload).toBe("[REDACTED]");
  });

  it("transitions to the configured terminal state after the wall-clock budget", async () => {
    vi.useFakeTimers();
    const log = new InMemoryEventLog();
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 3 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "TIMED_OUT", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      timer: { budgetMs: 100, terminalState: "TIMED_OUT" },
      eventLog: log,
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await vi.advanceTimersByTimeAsync(150);

    expect(sm.getActive()).toBeNull();
    const entries = await log.eventsFor("turn-1");
    expect(
      entries.find((e) => e.kind === "enter" && e.state === "TIMED_OUT"),
    ).toBeDefined();
    vi.useRealTimers();
  });

  it("clears the wall-clock timer when the turn ends naturally", async () => {
    vi.useFakeTimers();
    const log = new InMemoryEventLog();
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 3 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "TIMED_OUT", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      timer: { budgetMs: 100, terminalState: "TIMED_OUT" },
      eventLog: log,
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.dispatch({ kind: "user_action", name: "next" });
    await vi.advanceTimersByTimeAsync(200);

    const entries = await log.eventsFor("turn-1");
    expect(
      entries.find((e) => e.kind === "enter" && e.state === "TIMED_OUT"),
    ).toBeUndefined();
    vi.useRealTimers();
  });

  it("transitions to the configured terminal when bumpCounter exceeds the limit", async () => {
    const log = new InMemoryEventLog();
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 3 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "TOOL_FAILED", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      limits: [
        { name: "tool_call", limit: 2, terminalState: "TOOL_FAILED" },
      ],
      eventLog: log,
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.bumpCounter("tool_call");
    await sm.bumpCounter("tool_call");
    await sm.bumpCounter("tool_call");

    expect(sm.getActive()).toBeNull();
    const entries = await log.eventsFor("turn-1");
    expect(
      entries.find((e) => e.kind === "enter" && e.state === "TOOL_FAILED"),
    ).toBeDefined();
  });

  it("resetCounter clears the streak and prevents the limit from triggering", async () => {
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 3 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "MODEL_INVALID_OUTPUT", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      limits: [
        { name: "no_op", limit: 2, terminalState: "MODEL_INVALID_OUTPUT" },
      ],
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.bumpCounter("no_op");
    await sm.bumpCounter("no_op");
    sm.resetCounter("no_op");
    await sm.bumpCounter("no_op");
    await sm.bumpCounter("no_op");

    expect(sm.getActive()?.currentState).toBe("A");
  });

  it("counters reset between turns", async () => {
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 3 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "TOOL_FAILED", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      limits: [{ name: "tool_call", limit: 2, terminalState: "TOOL_FAILED" }],
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.bumpCounter("tool_call");
    await sm.bumpCounter("tool_call");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.dispatch({ kind: "user_action", name: "next" });

    await sm.startTurn("turn-2");
    await sm.bumpCounter("tool_call");
    await sm.bumpCounter("tool_call");
    expect(sm.getActive()?.turnId).toBe("turn-2");
    expect(sm.getActive()?.currentState).toBe("A");
  });

  it("throws when a limit references an unknown terminal state", () => {
    expect(
      () =>
        new StateMachine(
          basicConfig({
            limits: [
              { name: "tool_call", limit: 1, terminalState: "NONEXISTENT" },
            ],
          }),
        ),
    ).toThrow(/unknown terminal state/);
  });

  it("throws when bumpCounter is called with an unregistered counter name", async () => {
    const sm = new StateMachine(basicConfig());
    await sm.startTurn("turn-1");
    await expect(sm.bumpCounter("unknown")).rejects.toThrow(
      /Counter not registered/,
    );
  });

  it("cancel() transitions to CANCELLED via the shared unwind", async () => {
    const calls: string[] = [];
    const log = new InMemoryEventLog();
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 3 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "CANCELLED", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      unwind: {
        stopModelStream: () => {
          calls.push("stopModelStream");
        },
        writeEvents: () => {
          calls.push("writeEvents");
        },
      },
      eventLog: log,
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.cancel();

    expect(sm.getActive()).toBeNull();
    expect(calls).toEqual(["stopModelStream", "writeEvents"]);
    const entries = await log.eventsFor("turn-1");
    expect(
      entries.find((e) => e.kind === "enter" && e.state === "CANCELLED"),
    ).toBeDefined();
  });

  it("cancel(terminalState) transitions to the supplied terminal state", async () => {
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 3 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "USER_ABORTED", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.cancel("USER_ABORTED");

    expect(sm.getActive()).toBeNull();
  });

  it("cancel() is a no-op when no turn is active", async () => {
    const sm = new StateMachine(basicConfig());
    await expect(sm.cancel()).resolves.toBeUndefined();
  });

  it("cancel() throws when the supplied terminal state is not defined", async () => {
    const sm = new StateMachine(basicConfig());
    await sm.startTurn("turn-1");
    await expect(sm.cancel("NONEXISTENT")).rejects.toThrow(
      /Cancel terminal state not defined/,
    );
  });

  it("retry() re-enters the current state and fires onExit + onEnter again", async () => {
    const calls: string[] = [];
    const config = basicConfig({
      states: [
        {
          name: "A",
          maxEventsPerTurn: 5,
          retry: { max: 1, onExhausted: "MODEL_INVALID_OUTPUT" },
          onEnter: () => {
            calls.push("enter:A");
          },
          onExit: () => {
            calls.push("exit:A");
          },
        },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "MODEL_INVALID_OUTPUT", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.retry();

    expect(sm.getActive()?.currentState).toBe("A");
    expect(calls).toEqual(["enter:A", "exit:A", "enter:A"]);
  });

  it("retry() transitions to onExhausted after max retries", async () => {
    const config = basicConfig({
      states: [
        {
          name: "A",
          maxEventsPerTurn: 5,
          retry: { max: 1, onExhausted: "MODEL_INVALID_OUTPUT" },
        },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "MODEL_INVALID_OUTPUT", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.retry();
    await sm.retry();

    expect(sm.getActive()).toBeNull();
  });

  it("retry() bumps a global \"retry\" counter when one is configured", async () => {
    const config = basicConfig({
      states: [
        {
          name: "A",
          maxEventsPerTurn: 10,
          retry: { max: 5, onExhausted: "MODEL_INVALID_OUTPUT" },
        },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "MODEL_INVALID_OUTPUT", maxEventsPerTurn: 0, terminal: true },
        { name: "RETRIES_EXHAUSTED", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      limits: [
        { name: "retry", limit: 2, terminalState: "RETRIES_EXHAUSTED" },
      ],
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.retry();
    await sm.retry();
    await sm.retry();

    expect(sm.getActive()).toBeNull();
  });

  it("retry() throws when called on a state with no retry config", async () => {
    const sm = new StateMachine(basicConfig());
    await sm.startTurn("turn-1");
    await expect(sm.retry()).rejects.toThrow(/does not allow retries/);
  });

  it("throws when a state's retry references an unknown onExhausted state", () => {
    expect(
      () =>
        new StateMachine(
          basicConfig({
            states: [
              {
                name: "A",
                maxEventsPerTurn: 3,
                retry: { max: 1, onExhausted: "NONEXISTENT" },
              },
              { name: "B", maxEventsPerTurn: 3 },
              { name: "DONE", maxEventsPerTurn: 0, terminal: true },
              { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
            ],
          }),
        ),
    ).toThrow(/retry references unknown state/);
  });

  it("isolates failures in unwind hooks so the rest of the unwind still runs", async () => {
    const calls: string[] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 3 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      unwind: {
        stopModelStream: () => {
          calls.push("stopModelStream");
          throw new Error("boom");
        },
        dropPendingToolResults: () => {
          calls.push("dropPendingToolResults");
        },
        writeEvents: () => {
          calls.push("writeEvents");
        },
      },
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.dispatch({ kind: "user_action", name: "next" });

    expect(calls).toEqual([
      "stopModelStream",
      "dropPendingToolResults",
      "writeEvents",
    ]);
    expect(sm.getActive()).toBeNull();
    consoleSpy.mockRestore();
  });

  it("bounded-events terminal entry carries a synthetic limit event", async () => {
    const log = new InMemoryEventLog();
    const config = basicConfig({
      states: [
        { name: "A", maxEventsPerTurn: 0 },
        { name: "B", maxEventsPerTurn: 3 },
        { name: "DONE", maxEventsPerTurn: 0, terminal: true },
        { name: "ERROR_BOUNDED", maxEventsPerTurn: 0, terminal: true },
      ],
      eventLog: log,
    });
    const sm = new StateMachine(config);
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "next" });

    const entries = await log.eventsFor("turn-1");
    const enterTerminal = entries.find(
      (e) => e.kind === "enter" && e.state === "ERROR_BOUNDED",
    );
    expect(enterTerminal?.triggeringEvent).toEqual({
      kind: "limit",
      name: "bounded_events",
      payload: { state: "A", limit: 0, value: 1 },
    });
  });
});
