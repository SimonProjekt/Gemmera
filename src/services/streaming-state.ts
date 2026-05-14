/**
 * Tracks whether the chat view is currently streaming a response. Owns the
 * `AbortController` so the Stop button can cancel the in-flight LLM call (and
 * any orchestrator that threads the same `AbortSignal`).
 *
 * Lives as a tiny module so the view's send/stop button toggling can be
 * exercised in isolation — view-level UI is otherwise untested.
 */
export class StreamingState {
  private controller: AbortController | null = null;

  isStreaming(): boolean {
    return this.controller !== null;
  }

  /** Begin a new streaming turn and return its `AbortSignal`. */
  begin(): AbortSignal {
    if (this.controller) {
      // Defensive: caller didn't end the previous turn. Abort it so the user
      // never has two concurrent in-flight calls racing into the same view.
      this.controller.abort();
    }
    this.controller = new AbortController();
    return this.controller.signal;
  }

  /** Cancel the in-flight turn. Returns true if anything was cancelled. */
  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    this.controller = null;
    return true;
  }

  /** Mark the turn as finished cleanly (no abort). */
  end(): void {
    this.controller = null;
  }
}

/**
 * Pattern shared with `classifier-llm.ts` and `retry-policy.ts` — DOMException
 * with name "AbortError" plus stdlib errors that carry the same name.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
