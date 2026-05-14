import type { ClassifierDecision, IntentLabel } from "./contracts/classifier";

export type DisambiguationAction = "save" | "ask" | "cancel";

export interface DisambiguationResolution {
  action: "save" | "ask";
  text: string;
  turnId: string;
  originalDecision: ClassifierDecision;
}

export interface DisambiguationCancellation {
  turnId: string;
  originalDecision: ClassifierDecision;
}

/**
 * Pure state machine for the disambiguation chip. Tracks the held message,
 * the queued messages, and the resolution state. Has no DOM knowledge —
 * the view is responsible for rendering and destroying the chip element.
 */
export class DisambiguationChip {
  private pending: { text: string; turnId: string; decision: ClassifierDecision } | null = null;
  private queue: string[] = [];

  /**
   * Hold a message pending disambiguation. Returns false if a message is
   * already held — the caller must not overwrite an unresolved chip.
   */
  hold(text: string, turnId: string, decision: ClassifierDecision): boolean {
    if (this.pending !== null) return false;
    this.pending = { text, turnId, decision };
    return true;
  }

  isShowing(): boolean {
    return this.pending !== null;
  }

  get rationale(): string {
    return this.pending?.decision.output?.rationale ?? "";
  }

  get pendingTurnId(): string | null {
    return this.pending?.turnId ?? null;
  }

  get originalLabel(): IntentLabel | null {
    return this.pending?.decision.output?.label ?? null;
  }

  get originalConfidence(): number {
    return this.pending?.decision.output?.confidence ?? 0;
  }

  /** Enqueue a message submitted while the chip is showing. */
  enqueue(text: string): void {
    this.queue.push(text);
  }

  /**
   * Resolve via Save or Ask. Clears the held message and returns the
   * resolution so the caller can re-submit with the chosen label.
   */
  resolve(action: "save" | "ask"): DisambiguationResolution | null {
    if (!this.pending) return null;
    const result: DisambiguationResolution = {
      action,
      text: this.pending.text,
      turnId: this.pending.turnId,
      originalDecision: this.pending.decision,
    };
    this.pending = null;
    return result;
  }

  /**
   * Cancel the disambiguation. Discards the held message and returns
   * the metadata needed to write the classifier_disambiguation event.
   */
  cancel(): DisambiguationCancellation | null {
    if (!this.pending) return null;
    const result: DisambiguationCancellation = {
      turnId: this.pending.turnId,
      originalDecision: this.pending.decision,
    };
    this.pending = null;
    return result;
  }

  /**
   * Return all queued messages and reset the queue. Call after resolving
   * or cancelling so queued messages can be dispatched.
   */
  drainQueue(): string[] {
    const q = [...this.queue];
    this.queue = [];
    return q;
  }
}
