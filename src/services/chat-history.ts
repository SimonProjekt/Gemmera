import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

export interface ChatRetentionPolicy {
  maxDays?: number;
  maxSessions?: number;
}

interface StoreShape {
  sessions: ChatSession[];
}

/**
 * Retention can be a plain object (back-compat / tests) or a getter so the
 * store reads the *current* plugin settings on every prune. The getter form
 * avoids the cache-staleness bug from #152 review: changing the retention
 * sliders in Settings used to require a plugin reload to take effect.
 */
export type ChatRetentionSource = ChatRetentionPolicy | (() => ChatRetentionPolicy);

export class ChatHistoryStore {
  constructor(
    private readonly filePath: string,
    private readonly retention: ChatRetentionSource = {},
  ) {}

  private get retentionPolicy(): ChatRetentionPolicy {
    return typeof this.retention === "function" ? this.retention() : this.retention;
  }

  async createSession(): Promise<ChatSession> {
    const data = await this.load();
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
    };
    data.sessions.push(session);
    await this.flush(data);
    return session;
  }

  async loadSession(id: string): Promise<ChatSession | null> {
    const data = await this.load();
    return data.sessions.find((s) => s.id === id) ?? null;
  }

  async appendTurn(sessionId: string, turn: ChatTurn): Promise<void> {
    const data = await this.load();
    const session = data.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    session.turns.push(turn);
    session.updatedAt = turn.timestamp;
    if (session.title === "New chat" && turn.role === "user") {
      session.title = turn.content.slice(0, 50) + (turn.content.length > 50 ? "…" : "");
    }
    await this.flush(data);
  }

  async listSessions(): Promise<ChatSession[]> {
    const data = await this.load();
    return [...data.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Rename a session. Returns the updated session, or `null` if the session
   * doesn't exist or the title is empty/whitespace. Long titles are clamped
   * to 200 chars so the drawer doesn't overflow. #43.
   *
   * NOTE: rename intentionally bumps `updatedAt`, which moves the chat to
   * the top of `listSessions()`. The renamed chat is "recently touched."
   * If a user is organizing old chats, expecting them to stay in place,
   * surface this — the UI re-orders. The ordering test pins the behavior;
   * any change here also requires updating that test. #152 review.
   */
  async renameSession(id: string, title: string): Promise<ChatSession | null> {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const data = await this.load();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) return null;
    session.title = trimmed.slice(0, 200);
    session.updatedAt = Date.now();
    await this.flush(data);
    return session;
  }

  async pruneIfNeeded(): Promise<void> {
    // Read the policy via the getter so changes to the settings sliders
    // take effect on the next prune without a plugin reload (#152).
    const policy = this.retentionPolicy;
    if (policy.maxDays === undefined && policy.maxSessions === undefined) return;
    const data = await this.load();
    let sessions = [...data.sessions];
    if (policy.maxDays !== undefined) {
      const cutoff = Date.now() - policy.maxDays * 24 * 60 * 60 * 1000;
      sessions = sessions.filter((s) => s.updatedAt >= cutoff);
    }
    if (policy.maxSessions !== undefined && sessions.length > policy.maxSessions) {
      sessions = sessions
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, policy.maxSessions);
    }
    await this.flush({ sessions });
  }

  private async load(): Promise<StoreShape> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as StoreShape;
    } catch {
      return { sessions: [] };
    }
  }

  private async flush(data: StoreShape): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, this.filePath);
  }
}
