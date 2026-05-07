import { describe, expect, it, vi } from "vitest";
import { StateMachineConfig, UnwindHooks } from "../contracts/state-machine";
import { HARD_STOPS } from "../contracts/hard-stops";
import { InMemoryEventLog } from "./event-log";
import { StateMachine } from "./state-machine";

/**
 * Cancellation and per-turn timeout tests for #60.
 *
 * Uses state names matching the query state machine (GENERATE, RERANK,
 * RETRIEVE, etc.) so the tests read as acceptance criteria even though
 * the full query SM is not yet wired. The framework is state-name-agnostic.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function querySmConfig(
  extra: Partial<StateMachineConfig> = {},
): StateMachineConfig {
  return {
    states: [
      { name: "RETRIEVE", maxEventsPerTurn: 5 },
      { name: "RERANK", maxEventsPerTurn: 5 },
      { name: "GENERATE", maxEventsPerTurn: 5 },
      { name: "DONE", maxEventsPerTurn: 0, terminal: true },
      { name: "CANCELLED", maxEventsPerTurn: 0, terminal: true },
      { name: "TIMED_OUT", maxEventsPerTurn: 0, terminal: true },
      { name: "MODEL_INVALID_OUTPUT", maxEventsPerTurn: 0, terminal: true },
    ],
    transitions: [
      { from: "RETRIEVE", on: { kind: "tool_result", name: "retrieved" }, to: "RERANK" },
      { from: "RERANK", on: { kind: "tool_result", name: "reranked" }, to: "GENERATE" },
      { from: "GENERATE", on: { kind: "model_output", name: "done" }, to: "DONE" },
    ],
    initialState: "RETRIEVE",
    errorBoundedEventsState: "MODEL_INVALID_OUTPUT",
    ...extra,
  };
}

// ── Cancel during GENERATE ────────────────────────────────────────────────────

describe("cancellation — cancel during GENERATE", () => {
  it("transitions to CANCELLED and aborts the signal", async () => {
    const eventLog = new InMemoryEventLog();
    const sm = new StateMachine(querySmConfig({ eventLog }));

    await sm.startTurn("t1");
    await sm.dispatch({ kind: "tool_result", name: "retrieved" });
    await sm.dispatch({ kind: "tool_result", name: "reranked" });
    // Now in GENERATE — cancel before the model finishes.
    await sm.cancel();

    const states = (await eventLog.eventsFor("t1"))
      .filter((e) => e.kind === "enter")
      .map((e) => e.state);
    expect(states).toContain("GENERATE");
    expect(states.at(-1)).toBe("CANCELLED");
    expect(sm.getActive()).toBeNull();
  });

  it("abort signal fires when cancelled during GENERATE", async () => {
    const sm = new StateMachine(querySmConfig());
    const turn = await sm.startTurn("t1");
    await sm.dispatch({ kind: "tool_result", name: "retrieved" });
    await sm.dispatch({ kind: "tool_result", name: "reranked" });

    // Capture the signal while in GENERATE — a real LLM call would pass it to fetch.
    let capturedSignal: AbortSignal | null = null;
    const config = querySmConfig({
      states: [
        {
          name: "GENERATE",
          maxEventsPerTurn: 5,
          onEnter: (ctx) => { capturedSignal = ctx.signal; },
        },
        ...(querySmConfig().states.filter((s) => s.name !== "GENERATE")),
      ],
    });
    const sm2 = new StateMachine(config);
    await sm2.startTurn("t2");
    await sm2.dispatch({ kind: "tool_result", name: "retrieved" });
    await sm2.dispatch({ kind: "tool_result", name: "reranked" });

    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as AbortSignal).aborted).toBe(false);

    await sm2.cancel();
    expect((capturedSignal as AbortSignal).aborted).toBe(true);
  });

  it("abort signal fires when cancelled during a long tool call in RETRIEVE", async () => {
    let capturedSignal: AbortSignal | null = null;
    const config = querySmConfig({
      states: [
        {
          name: "RETRIEVE",
          maxEventsPerTurn: 5,
          onEnter: (ctx) => { capturedSignal = ctx.signal; },
        },
        ...(querySmConfig().states.filter((s) => s.name !== "RETRIEVE")),
      ],
    });
    const sm = new StateMachine(config);
    await sm.startTurn("t1");
    // Still in RETRIEVE (tool call is in flight).
    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as AbortSignal).aborted).toBe(false);

    await sm.cancel();
    expect((capturedSignal as AbortSignal).aborted).toBe(true);
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe("cancellation — wall-clock timeout", () => {
  it("fires TIMED_OUT when the budget elapses during RERANK", async () => {
    const eventLog = new InMemoryEventLog();
    const sm = new StateMachine(
      querySmConfig({
        eventLog,
        timer: { budgetMs: 50, terminalState: "TIMED_OUT" },
      }),
    );

    await sm.startTurn("t1");
    await sm.dispatch({ kind: "tool_result", name: "retrieved" });
    // Now in RERANK — wait for timeout.
    await new Promise((r) => setTimeout(r, 120));

    const states = (await eventLog.eventsFor("t1"))
      .filter((e) => e.kind === "enter")
      .map((e) => e.state);
    expect(states.at(-1)).toBe("TIMED_OUT");
    expect(sm.getActive()).toBeNull();
  });

  it("fires TIMED_OUT during GENERATE when budget elapses", async () => {
    const eventLog = new InMemoryEventLog();
    const sm = new StateMachine(
      querySmConfig({
        eventLog,
        timer: { budgetMs: 50, terminalState: "TIMED_OUT" },
      }),
    );

    await sm.startTurn("t1");
    await sm.dispatch({ kind: "tool_result", name: "retrieved" });
    await sm.dispatch({ kind: "tool_result", name: "reranked" });
    // Now in GENERATE — wait for timeout.
    await new Promise((r) => setTimeout(r, 120));

    const states = (await eventLog.eventsFor("t1"))
      .filter((e) => e.kind === "enter")
      .map((e) => e.state);
    expect(states.at(-1)).toBe("TIMED_OUT");
  });

  it("does not fire timeout after the turn completes naturally", async () => {
    const eventLog = new InMemoryEventLog();
    const sm = new StateMachine(
      querySmConfig({
        eventLog,
        timer: { budgetMs: 100, terminalState: "TIMED_OUT" },
      }),
    );

    await sm.startTurn("t1");
    await sm.dispatch({ kind: "tool_result", name: "retrieved" });
    await sm.dispatch({ kind: "tool_result", name: "reranked" });
    await sm.dispatch({ kind: "model_output", name: "done" });
    // Turn is DONE — wait past the budget and verify no extra transitions.
    await new Promise((r) => setTimeout(r, 150));

    const states = (await eventLog.eventsFor("t1"))
      .filter((e) => e.kind === "enter")
      .map((e) => e.state);
    expect(states.at(-1)).toBe("DONE");
    expect(states).not.toContain("TIMED_OUT");
  });

  it("default wall-clock budget from HARD_STOPS is within the allowed range", () => {
    expect(HARD_STOPS.WALL_CLOCK_MS_PER_TURN).toBe(120_000);
    expect(HARD_STOPS.WALL_CLOCK_MS_MAX).toBe(300_000);
    expect(HARD_STOPS.WALL_CLOCK_MS_PER_TURN).toBeLessThanOrEqual(
      HARD_STOPS.WALL_CLOCK_MS_MAX,
    );
  });
});

// ── Unwind order ──────────────────────────────────────────────────────────────

describe("cancellation — unwind hook order", () => {
  it("runs hooks stop → drop → rollback → events → notice on cancel", async () => {
    const calls: string[] = [];
    const hooks: UnwindHooks = {
      stopModelStream: () => { calls.push("stop"); },
      dropPendingToolResults: () => { calls.push("drop"); },
      rollbackUnconfirmedWrites: () => { calls.push("rollback"); },
      writeEvents: () => { calls.push("events"); },
      surfaceNotice: () => { calls.push("notice"); },
    };

    const sm = new StateMachine(querySmConfig({ unwind: hooks }));
    await sm.startTurn("t1");
    await sm.cancel();

    expect(calls).toEqual(["stop", "drop", "rollback", "events", "notice"]);
  });

  it("runs hooks in the same order on timeout", async () => {
    const calls: string[] = [];
    const hooks: UnwindHooks = {
      stopModelStream: () => { calls.push("stop"); },
      dropPendingToolResults: () => { calls.push("drop"); },
      rollbackUnconfirmedWrites: () => { calls.push("rollback"); },
      writeEvents: () => { calls.push("events"); },
      surfaceNotice: () => { calls.push("notice"); },
    };

    const sm = new StateMachine(
      querySmConfig({ unwind: hooks, timer: { budgetMs: 50, terminalState: "TIMED_OUT" } }),
    );
    await sm.startTurn("t1");
    await new Promise((r) => setTimeout(r, 120));

    expect(calls).toEqual(["stop", "drop", "rollback", "events", "notice"]);
  });

  it("a failing hook does not prevent later hooks from running", async () => {
    const calls: string[] = [];
    const hooks: UnwindHooks = {
      stopModelStream: () => { calls.push("stop"); throw new Error("stream error"); },
      dropPendingToolResults: () => { calls.push("drop"); },
      rollbackUnconfirmedWrites: () => { calls.push("rollback"); },
      writeEvents: () => { calls.push("events"); },
      surfaceNotice: () => { calls.push("notice"); },
    };

    const sm = new StateMachine(querySmConfig({ unwind: hooks }));
    await sm.startTurn("t1");
    await sm.cancel();

    // All hooks must run even when stopModelStream throws.
    expect(calls).toEqual(["stop", "drop", "rollback", "events", "notice"]);
  });
});

// ── Confirmed writes are preserved ────────────────────────────────────────────

describe("cancellation — confirmed writes preserved", () => {
  it("a queued turn starts after the cancelled turn ends", async () => {
    const eventLog = new InMemoryEventLog();
    const sm = new StateMachine(querySmConfig({ eventLog }));

    // Start two turns — the second queues behind the first.
    await sm.startTurn("t1");
    const second = await sm.startTurn("t2");
    expect(second).toEqual({ turnId: "t2" }); // QueuedTurn

    // Cancel t1 — t2 should start automatically.
    await sm.cancel();

    expect(sm.getActive()?.turnId).toBe("t2");
    expect(sm.getQueue()).toHaveLength(0);
  });

  it("cancellation does not affect transitions already written to the event log", async () => {
    const eventLog = new InMemoryEventLog();
    const sm = new StateMachine(querySmConfig({ eventLog }));

    await sm.startTurn("t1");
    await sm.dispatch({ kind: "tool_result", name: "retrieved" });
    // RETRIEVE → RERANK is already committed to the log.
    await sm.cancel();

    const entries = await eventLog.eventsFor("t1");
    const retrieveEnter = entries.find(
      (e) => e.kind === "enter" && e.state === "RETRIEVE",
    );
    const rerankEnter = entries.find(
      (e) => e.kind === "enter" && e.state === "RERANK",
    );
    expect(retrieveEnter).toBeDefined();
    expect(rerankEnter).toBeDefined();
  });
});
