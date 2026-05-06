import type { RunnerStatusSnapshot } from "../services/runner-status";

/**
 * Vaults below this size hide the pill entirely. Cold start finishes faster
 * than the eye can register, and a flicker is worse than no signal.
 */
export const TINY_VAULT_THRESHOLD = 50;

export interface PillView {
  /** Text to render. Empty when the pill should be hidden. */
  text: string;
  /** Whether the pill should be visible. */
  visible: boolean;
  /** Suggested CSS modifier suffix. */
  variant: "running" | "paused" | "hidden";
}

/**
 * Pure formatter for the indexing pill (#15b). Takes a status snapshot and a
 * "tiny vault" threshold; returns whether to render and what to display.
 *
 * Tiny vaults (total < tinyVaultThreshold) hide the pill entirely — cold
 * start finishes faster than the eye can register, and a flicker is worse
 * than no signal.
 */
export function formatPill(
  snapshot: RunnerStatusSnapshot,
  tinyVaultThreshold: number = TINY_VAULT_THRESHOLD,
): PillView {
  if (snapshot.phase === "paused") {
    const total = snapshot.total ?? 0;
    const completed = snapshot.completed;
    return {
      text:
        total > 0
          ? `Indexing paused (${completed} / ${total})`
          : "Indexing paused",
      visible: true,
      variant: "paused",
    };
  }

  if (snapshot.phase === "idle" || snapshot.total === undefined) {
    return { text: "", visible: false, variant: "hidden" };
  }

  if (snapshot.total < tinyVaultThreshold) {
    return { text: "", visible: false, variant: "hidden" };
  }

  return {
    text: `Indexing ${snapshot.completed} of ${snapshot.total}`,
    visible: true,
    variant: "running",
  };
}
