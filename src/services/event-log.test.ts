import { describe, expect, it } from "vitest";
import {
  EventLogEntry,
  StateMachineConfig,
} from "../contracts/state-machine";
import { InMemoryEventLog, replayTurn } from "./event-log";
import { StateMachine } from "./state-machine";

function basicConfig(): StateMachineConfig {
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
  };
}

function stripTimestamps(entries: readonly EventLogEntry[]): unknown[] {
  return entries.map(({ timestamp, ...rest }) => rest);
}

describe("InMemoryEventLog", () => {
  it("stores entries and returns them filtered by turn id", async () => {
    const log = new InMemoryEventLog();
    log.write({
      turnId: "turn-1",
      kind: "enter",
      state: "A",
      fromState: null,
      timestamp: 1,
      triggeringEvent: null,
    });
    log.write({
      turnId: "turn-2",
      kind: "enter",
      state: "X",
      fromState: null,
      timestamp: 2,
      triggeringEvent: null,
    });

    const turn1 = await log.eventsFor("turn-1");
    expect(turn1).toHaveLength(1);
    expect(turn1[0].state).toBe("A");
  });
});

describe("replayTurn", () => {
  it("produces the same entries as the original turn", async () => {
    const original = new InMemoryEventLog();
    const config = basicConfig();
    const sm = new StateMachine({ ...config, eventLog: original });
    await sm.startTurn("turn-1");
    await sm.dispatch({ kind: "user_action", name: "next" });
    await sm.dispatch({ kind: "user_action", name: "next" });

    const replayed = await replayTurn(original, "turn-1", config);
    const originalEntries = await original.eventsFor("turn-1");

    expect(stripTimestamps(replayed)).toEqual(stripTimestamps(originalEntries));
  });
});
