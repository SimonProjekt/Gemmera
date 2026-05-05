import {
  EventLog,
  EventLogEntry,
  StateMachineConfig,
} from "../contracts/state-machine";
import { StateMachine } from "./state-machine";

export class InMemoryEventLog implements EventLog {
  private entries: EventLogEntry[] = [];

  write(entry: EventLogEntry): void {
    this.entries.push(entry);
  }

  async eventsFor(turnId: string): Promise<readonly EventLogEntry[]> {
    return this.entries.filter((e) => e.turnId === turnId);
  }
}

// Re-runs a recorded turn by extracting the dispatch sequence from "enter"
// entries with a non-null triggeringEvent and dispatching them on a fresh
// state machine. Returns the event log produced by the replay so it can be
// compared against the original.
export async function replayTurn(
  recorded: EventLog,
  turnId: string,
  config: StateMachineConfig,
): Promise<readonly EventLogEntry[]> {
  const entries = await recorded.eventsFor(turnId);
  const dispatchSequence = entries
    .filter((e) => e.kind === "enter" && e.triggeringEvent !== null)
    .map((e) => e.triggeringEvent!);

  const replayLog = new InMemoryEventLog();
  const sm = new StateMachine({ ...config, eventLog: replayLog });
  await sm.startTurn(turnId);
  for (const event of dispatchSequence) {
    await sm.dispatch(event);
  }
  return replayLog.eventsFor(turnId);
}
