import {
  EventLog,
  EventLogEntry,
  StateMachineConfig,
} from "../contracts/state-machine";
import { StateMachine } from "./state-machine";

// TODO: a DuckDB-backed implementation lives behind events.duckdb (see
// planning/tool-loop.md "Observability"). Until that lands, the in-memory
// log is the only writer and the turn inspector reads from it directly.
export class InMemoryEventLog implements EventLog {
  private entries: EventLogEntry[] = [];

  write(entry: EventLogEntry): void {
    this.entries.push(entry);
  }

  async eventsFor(turnId: string): Promise<readonly EventLogEntry[]> {
    return this.entries.filter((e) => e.turnId === turnId);
  }
}

// Re-runs a recorded turn on a fresh state machine and returns the event
// log produced by the replay so it can be compared against the original.
//
// Each recorded `enter` entry's triggeringEvent is dispatched back into the
// state machine. Framework-emitted events are routed to their original entry
// points: `{kind: "limit"}` becomes a bumpCounter call, `{kind: "retry"}`
// becomes a retry call. The bounded-events synthetic and the wall-clock
// timer are framework-internal and cannot be replayed deterministically;
// turns that hit those paths will diverge.
export async function replayTurn(
  recorded: EventLog,
  turnId: string,
  config: StateMachineConfig,
): Promise<readonly EventLogEntry[]> {
  const entries = await recorded.eventsFor(turnId);
  const replayLog = new InMemoryEventLog();
  const sm = new StateMachine({ ...config, eventLog: replayLog });
  await sm.startTurn(turnId);

  for (const entry of entries) {
    if (entry.kind === "bump" && entry.triggeringEvent?.kind === "limit") {
      await sm.bumpCounter(entry.triggeringEvent.name);
      continue;
    }
    if (entry.kind !== "enter" || !entry.triggeringEvent) continue;
    const event = entry.triggeringEvent;

    // Skip framework-emitted entries that are reproduced through other paths
    // (limit → bump entry above; turn_timeout → wall-clock cannot replay).
    if (event.kind === "limit") continue;

    switch (event.kind) {
      case "retry":
        await sm.retry();
        break;
      case "timer":
        if (event.name === "turn_timeout") continue;
        await sm.dispatch(event);
        break;
      default:
        await sm.dispatch(event);
    }
  }
  return replayLog.eventsFor(turnId);
}
