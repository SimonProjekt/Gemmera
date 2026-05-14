import type { ChatMessage } from "../contracts";
import type { RecentTurn } from "../contracts/classifier";

/**
 * Plugin-instance-level state for the live chat (#43). Lives on the plugin
 * so that detaching the view to a separate Obsidian window — which creates a
 * fresh leaf and re-instantiates `GemmeraChatView` — picks up the existing
 * conversation instead of starting empty.
 *
 * The view treats this as the source of truth for in-memory chat state:
 * on open it rehydrates from `history`, on every turn it writes back.
 * Persistence is owned by `ChatHistoryStore` (chats.json on disk).
 */
export class ChatSessionState {
  /** In-memory conversation buffer. Sent to the LLM as context for each turn. */
  history: ChatMessage[] = [];
  /** Stable id of the session currently visible in the view, or null when on a fresh chat. */
  currentSessionId: string | null = null;
  /** Last three turns' intent labels — passed to the classifier on the next turn. */
  recentTurns: RecentTurn[] = [];

  /** Wipe the in-memory state for "New chat". Disk persistence is unchanged. */
  reset(): void {
    this.history = [];
    this.currentSessionId = null;
    this.recentTurns = [];
  }
}
