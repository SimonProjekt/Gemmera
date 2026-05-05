import { describe, expect, it, vi } from "vitest";
import { StateMachineConfig } from "../contracts/state-machine";
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
});
