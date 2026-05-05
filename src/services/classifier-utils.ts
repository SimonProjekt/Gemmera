import { ClassifierInput, RecentTurn } from "../contracts/classifier";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Planning/classifier.md §"Input contract": 8 KB message cap. */
const MESSAGE_BYTE_LIMIT = 8192;

/** Marker appended when the message is truncated, so the user can see it
 *  wasn't fully processed. Kept short to minimise prompt tokens. */
const TRUNCATION_MARKER = "\n… [message truncated]";

/**
 * Pre-process raw user input into a `ClassifierInput` suitable for
 * prompt assembly. Handles truncation and the recent-turns slice in one
 * call-site convenience function.
 */
export function prepareClassifierInput(raw: {
  messageText: string;
  attachments: ClassifierInput["attachments"];
  activeFile: ClassifierInput["activeFile"];
  recentTurns: RecentTurn[];
}): ClassifierInput {
  const { text, truncated } = truncateMessage(raw.messageText);
  return {
    messageText: text,
    truncated,
    attachments: raw.attachments,
    activeFile: raw.activeFile,
    recentTurns: lastRecentTurns(raw.recentTurns),
  };
}

/**
 * Truncate `text` so its UTF-8 byte length does not exceed `limit`
 * (default 8 KB). The last code-point boundary before the limit is
 * preserved — multibyte characters are never split. Returns the
 * truncated string with a visible marker and a `truncated` flag.
 *
 * No-op when the text is already under the limit.
 */
export function truncateMessage(
  text: string,
  limit: number = MESSAGE_BYTE_LIMIT,
): { text: string; truncated: boolean } {
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= limit) {
    return { text, truncated: false };
  }

  const tail = encoder.encode(TRUNCATION_MARKER);
  const contentLimit = limit - tail.byteLength;

  if (contentLimit <= 0) {
    // Edge case: limit is smaller than the marker itself.
    // Deliver just the marker so the user at least knows truncation happened.
    return { text: TRUNCATION_MARKER.trimStart(), truncated: true };
  }

  const trimmed = trimUtf8(encoded, contentLimit);
  const truncatedText = decoder.decode(trimmed);

  return { text: truncatedText + TRUNCATION_MARKER, truncated: true };
}

/**
 * Return at most the last 3 recent turns. The classifier prompt uses
 * this slice for referent resolution ("save that", "tell me more").
 */
export function lastRecentTurns(turns: readonly RecentTurn[]): RecentTurn[] {
  if (turns.length <= 3) return [...turns];
  return turns.slice(-3);
}

// ─── internals ────────────────────────────────────────────────────────

function trimUtf8(bytes: Uint8Array, byteLimit: number): Uint8Array {
  let end = byteLimit;
  // Walk backwards to the nearest code-point boundary. Multi-byte
  // sequences in UTF-8 never contain 0xxxxxxx or 11xxxxxx as a
  // continuation byte — continuation bytes are always 10xxxxxx.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return bytes.slice(0, end);
}
