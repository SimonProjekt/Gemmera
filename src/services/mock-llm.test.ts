import { describe, expect, it } from "vitest";
import { MockLLMService } from "./mock-llm";

describe("MockLLMService", () => {
  it("matches the 'create' branch and emits a save_note tool call", async () => {
    const llm = new MockLLMService();
    const res = await llm.chat({
      messages: [{ role: "user", content: "Skapa en anteckning om Jonas" }],
    });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls?.[0].name).toBe("save_note");
    expect(res.content).toBe("");
  });

  it("matches the 'search' branch with prose content", async () => {
    const llm = new MockLLMService();
    const res = await llm.chat({
      messages: [{ role: "user", content: "Sök efter dagboksanteckningar" }],
    });
    expect(res.content).toMatch(/hittade/i);
    expect(res.toolCalls).toBeUndefined();
  });

  it("falls back to plain chat reply", async () => {
    const llm = new MockLLMService();
    const res = await llm.chat({
      messages: [{ role: "user", content: "hej" }],
    });
    expect(res.content).toMatch(/mock/i);
  });

  it("streams tokens that accumulate into the full response", async () => {
    const llm = new MockLLMService();
    const tokens: string[] = [];
    const res = await llm.chat({
      messages: [{ role: "user", content: "hej" }],
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join("")).toBe(res.content);
  });

  it("respects an aborted signal mid-stream", async () => {
    const llm = new MockLLMService();
    const ctrl = new AbortController();
    ctrl.abort();
    const tokens: string[] = [];
    await llm.chat({
      messages: [{ role: "user", content: "hej" }],
      onToken: (t) => tokens.push(t),
      signal: ctrl.signal,
    });
    expect(tokens).toHaveLength(0);
  });

  it("reports as reachable", async () => {
    const llm = new MockLLMService();
    expect(await llm.isReachable()).toBe("running");
  });
});
