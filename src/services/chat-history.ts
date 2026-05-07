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

export class ChatHistoryStore {
  constructor(
    private readonly filePath: string,
    private readonly retention: ChatRetentionPolicy = {},
  ) {}

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

  async pruneIfNeeded(): Promise<void> {
    const data = await this.load();
    let sessions = [...data.sessions];
    if (this.retention.maxDays !== undefined) {
      const cutoff = Date.now() - this.retention.maxDays * 24 * 60 * 60 * 1000;
      sessions = sessions.filter((s) => s.updatedAt >= cutoff);
    }
    if (this.retention.maxSessions !== undefined && sessions.length > this.retention.maxSessions) {
      sessions = sessions
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, this.retention.maxSessions);
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
