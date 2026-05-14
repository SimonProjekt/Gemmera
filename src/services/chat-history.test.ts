import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatHistoryStore } from "./chat-history";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemmera-history-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function storePath() {
  return join(dir, "chats.json");
}

describe("ChatHistoryStore", () => {
  it("createSession returns session with 'New chat' title", async () => {
    const store = new ChatHistoryStore(storePath());
    const session = await store.createSession();
    expect(session.title).toBe("New chat");
    expect(session.turns).toHaveLength(0);
    expect(session.id).toBeTruthy();
  });

  it("appendTurn persists the turn", async () => {
    const store = new ChatHistoryStore(storePath());
    const session = await store.createSession();
    await store.appendTurn(session.id, { role: "user", content: "Hello", timestamp: 1000 });
    const loaded = await store.loadSession(session.id);
    expect(loaded?.turns).toHaveLength(1);
    expect(loaded?.turns[0].content).toBe("Hello");
  });

  it("auto-titles from first user message (<=50 chars)", async () => {
    const store = new ChatHistoryStore(storePath());
    const session = await store.createSession();
    await store.appendTurn(session.id, { role: "user", content: "Short title", timestamp: 1000 });
    const loaded = await store.loadSession(session.id);
    expect(loaded?.title).toBe("Short title");
  });

  it("auto-titles from first user message (>50 chars, truncates with ellipsis)", async () => {
    const store = new ChatHistoryStore(storePath());
    const session = await store.createSession();
    const longText = "A".repeat(60);
    await store.appendTurn(session.id, { role: "user", content: longText, timestamp: 1000 });
    const loaded = await store.loadSession(session.id);
    expect(loaded?.title).toBe("A".repeat(50) + "…");
  });

  it("does not re-title after first user message", async () => {
    const store = new ChatHistoryStore(storePath());
    const session = await store.createSession();
    await store.appendTurn(session.id, { role: "user", content: "First", timestamp: 1000 });
    await store.appendTurn(session.id, { role: "user", content: "Second", timestamp: 2000 });
    const loaded = await store.loadSession(session.id);
    expect(loaded?.title).toBe("First");
  });

  it("listSessions returns newest first", async () => {
    const store = new ChatHistoryStore(storePath());
    const s1 = await store.createSession();
    const s2 = await store.createSession();
    await store.appendTurn(s1.id, { role: "user", content: "a", timestamp: 2000 });
    await store.appendTurn(s2.id, { role: "user", content: "b", timestamp: 1000 });
    const list = await store.listSessions();
    expect(list[0].id).toBe(s1.id);
    expect(list[1].id).toBe(s2.id);
  });

  it("data survives re-instantiation", async () => {
    const path = storePath();
    const store1 = new ChatHistoryStore(path);
    const session = await store1.createSession();
    await store1.appendTurn(session.id, { role: "user", content: "hi", timestamp: 1000 });

    const store2 = new ChatHistoryStore(path);
    const loaded = await store2.loadSession(session.id);
    expect(loaded?.turns[0].content).toBe("hi");
  });

  it("pruneIfNeeded removes sessions older than maxDays", async () => {
    const store = new ChatHistoryStore(storePath(), { maxDays: 7 });
    const old = await store.createSession();
    const recent = await store.createSession();
    const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await store.appendTurn(old.id, { role: "user", content: "old", timestamp: cutoff });
    await store.appendTurn(recent.id, { role: "user", content: "recent", timestamp: Date.now() });
    await store.pruneIfNeeded();
    const list = await store.listSessions();
    expect(list.map((s) => s.id)).not.toContain(old.id);
    expect(list.map((s) => s.id)).toContain(recent.id);
  });

  it("pruneIfNeeded keeps only maxSessions newest", async () => {
    const store = new ChatHistoryStore(storePath(), { maxSessions: 2 });
    const s1 = await store.createSession();
    const s2 = await store.createSession();
    const s3 = await store.createSession();
    await store.appendTurn(s1.id, { role: "user", content: "a", timestamp: 1000 });
    await store.appendTurn(s2.id, { role: "user", content: "b", timestamp: 2000 });
    await store.appendTurn(s3.id, { role: "user", content: "c", timestamp: 3000 });
    await store.pruneIfNeeded();
    const list = await store.listSessions();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id)).toContain(s2.id);
    expect(list.map((s) => s.id)).toContain(s3.id);
    expect(list.map((s) => s.id)).not.toContain(s1.id);
  });

  it("loadSession returns null for unknown id", async () => {
    const store = new ChatHistoryStore(storePath());
    const result = await store.loadSession("nonexistent");
    expect(result).toBeNull();
  });

  it("creates parent directory if it does not exist", async () => {
    const nested = join(dir, "subdir", "chats.json");
    const store = new ChatHistoryStore(nested);
    const session = await store.createSession();
    expect(session.id).toBeTruthy();
    const loaded = await store.loadSession(session.id);
    expect(loaded).not.toBeNull();
  });

  // ── renameSession (#43) ────────────────────────────────────────────────

  it("renameSession updates the title and persists it", async () => {
    const store = new ChatHistoryStore(storePath());
    const session = await store.createSession();
    const updated = await store.renameSession(session.id, "Sundsvall trip");
    expect(updated?.title).toBe("Sundsvall trip");
    const reloaded = await store.loadSession(session.id);
    expect(reloaded?.title).toBe("Sundsvall trip");
  });

  it("renameSession trims whitespace and clamps to 200 chars", async () => {
    const store = new ChatHistoryStore(storePath());
    const session = await store.createSession();
    const long = "x".repeat(300);
    const updated = await store.renameSession(session.id, `   ${long}   `);
    expect(updated?.title).toHaveLength(200);
  });

  it("renameSession rejects an empty / whitespace title", async () => {
    const store = new ChatHistoryStore(storePath());
    const session = await store.createSession();
    expect(await store.renameSession(session.id, "")).toBeNull();
    expect(await store.renameSession(session.id, "   ")).toBeNull();
    const reloaded = await store.loadSession(session.id);
    expect(reloaded?.title).toBe("New chat");
  });

  it("renameSession returns null for unknown id", async () => {
    const store = new ChatHistoryStore(storePath());
    const result = await store.renameSession("does-not-exist", "Anything");
    expect(result).toBeNull();
  });

  it("renameSession bumps updatedAt so the renamed chat surfaces as recent", async () => {
    const store = new ChatHistoryStore(storePath());
    const older = await store.createSession();
    await new Promise((r) => setTimeout(r, 5));
    const newer = await store.createSession();
    let list = await store.listSessions();
    expect(list[0].id).toBe(newer.id);

    await new Promise((r) => setTimeout(r, 5));
    await store.renameSession(older.id, "Renamed");
    list = await store.listSessions();
    expect(list[0].id).toBe(older.id);
  });
});
