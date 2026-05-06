/**
 * Pre-classifier skip router.
 *
 * Every user submission goes through this first; only `null` results
 * proceed to the LLM classifier.  Rules are evaluated in the order
 * documented in planning/classifier.md §"Skip conditions".
 *
 * #04
 */

import {
  Attachment,
  IntentLabel,
  PresetCommand,
  SkipReason,
  SkipRouterResult,
} from "../contracts/classifier";

export interface SkipRouterInput {
  /** Raw message text as typed by the user. */
  messageText: string;
  /** Attachments attached to the message, if any. */
  attachments: Attachment[];
  /** True when the user submitted with Ctrl/Cmd+Enter. */
  ctrlEnter?: boolean;
  /** Command preset that triggered the submission, if any. */
  presetCommand?: PresetCommand;
}

/**
 * Evaluate skip conditions for the classifier.
 *
 * Returns:
 *   - `{ kind: "error", error: "empty-message" }` when the message is empty or
 *     whitespace-only.  No event should be emitted for this path.
 *   - `{ kind: "skip", label, reason }` when a hard signal pre-empts the LLM.
 *     The caller must emit a `classifier_decision` event with `source: "skip"`.
 *   - `null` when none of the skip conditions match — proceed to the LLM.
 */
export function classifySkipRouter(input: SkipRouterInput): SkipRouterResult {
  const trimmed = input.messageText.trim();

  // 1. Empty / whitespace-only → error.
  if (trimmed.length === 0 && input.attachments.length === 0) {
    return { kind: "error", error: "empty-message" };
  }

  // 2. Attachments present but no text → pre-route capture.
  if (trimmed.length === 0 && input.attachments.length > 0) {
    return { kind: "skip", label: "capture", reason: "attachment-only" };
  }

  // 3. Preset command → hard-coded label.
  if (input.presetCommand) {
    switch (input.presetCommand) {
      case "cowork.capture-selection":
      case "cowork.capture-active-note":
        return { kind: "skip", label: "capture", reason: "command-capture" };
      case "cowork.ask-about-active-note":
        return { kind: "skip", label: "ask", reason: "command-ask" };
    }
  }

  // 4. Ctrl/Cmd+Enter submit → capture.
  if (input.ctrlEnter) {
    return { kind: "skip", label: "capture", reason: "ctrl-enter" };
  }

  // 5. Leading "?" → ask (strip the "?" before downstream use).
  if (trimmed.startsWith("?")) {
    const stripped = trimmed.slice(1).trimStart();
    return {
      kind: "skip",
      label: "ask",
      reason: "leading-question-mark",
      strippedText: stripped,
    };
  }

  // No skip condition matched — proceed to LLM.
  return null;
}
