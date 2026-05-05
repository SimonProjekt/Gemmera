import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaEmbedder } from "./ollama-embedder";

interface FetchCall {
  url: string;
  body: { model: string; input: string[] };
}

function mockFetch(
  responder: (call: FetchCall) => { ok: boolean; status?: number; statusText?: string; json: unknown },
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as FetchCall["body"];
    const call = { url, body };
    calls.push(call);
    const r = responder(call);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.statusText ?? (r.ok ? "OK" : "ERR"),
      json: async () => r.json,
    } as Response;
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaEmbedder", () => {
  it("returns [] for empty input without calling fetch", async () => {
    const { calls } = mockFetch(() => ({ ok: true, json: { embeddings: [] } }));
    const e = new OllamaEmbedder({ dim: 4 });
    expect(await e.embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("posts to /api/embed with the configured model and the batch's texts", async () => {
    const { calls } = mockFetch(({ body }) => ({
      ok: true,
      json: { embeddings: body.input.map(() => [1, 0, 0, 0]) },
    }));
    const e = new OllamaEmbedder({ baseUrl: "http://h:1", model: "m1", dim: 4 });
    await e.embed([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://h:1/api/embed");
    expect(calls[0].body).toEqual({ model: "m1", input: ["alpha", "beta"] });
  });

  it("preserves request ids in result order", async () => {
    mockFetch(({ body }) => ({
      ok: true,
      json: { embeddings: body.input.map((_, i) => [i + 1, 0, 0, 0]) },
    }));
    const e = new OllamaEmbedder({ dim: 4, batchSize: 32 });
    const out = await e.embed([
      { id: "x", text: "x" },
      { id: "y", text: "y" },
      { id: "z", text: "z" },
    ]);
    expect(out.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });

  it("L2-normalizes vectors so dot product == cosine", async () => {
    mockFetch(() => ({ ok: true, json: { embeddings: [[3, 4, 0, 0]] } }));
    const e = new OllamaEmbedder({ dim: 4 });
    const [r] = await e.embed([{ id: "a", text: "a" }]);
    const norm = Math.sqrt(r.vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(r.vec[0]).toBeCloseTo(0.6, 6);
    expect(r.vec[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves a zero vector at zero (no NaN from divide-by-zero)", async () => {
    mockFetch(() => ({ ok: true, json: { embeddings: [[0, 0, 0, 0]] } }));
    const e = new OllamaEmbedder({ dim: 4 });
    const [r] = await e.embed([{ id: "a", text: "a" }]);
    for (const v of r.vec) expect(v).toBe(0);
  });

  it("splits inputs across batches of at most batchSize and preserves order", async () => {
    const { calls } = mockFetch(({ body }) => ({
      ok: true,
      json: { embeddings: body.input.map(() => [1, 0]) },
    }));
    const e = new OllamaEmbedder({ dim: 2, batchSize: 2 });
    const out = await e.embed([
      { id: "a", text: "a" },
      { id: "b", text: "b" },
      { id: "c", text: "c" },
      { id: "d", text: "d" },
      { id: "e", text: "e" },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.body.input)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("throws when Ollama returns the wrong number of embeddings", async () => {
    mockFetch(() => ({ ok: true, json: { embeddings: [[1, 0]] } }));
    const e = new OllamaEmbedder({ dim: 2 });
    await expect(
      e.embed([
        { id: "a", text: "a" },
        { id: "b", text: "b" },
      ]),
    ).rejects.toThrow(/returned 1 embeddings for 2 inputs/);
  });

  it("throws on dim mismatch, naming the model", async () => {
    mockFetch(() => ({ ok: true, json: { embeddings: [[1, 0, 0]] } }));
    const e = new OllamaEmbedder({ model: "wrong-dim", dim: 4 });
    await expect(e.embed([{ id: "a", text: "a" }])).rejects.toThrow(
      /dim 3, expected 4 for model wrong-dim/,
    );
  });

  it("throws on non-ok HTTP response", async () => {
    mockFetch(() => ({ ok: false, status: 503, statusText: "down", json: {} }));
    const e = new OllamaEmbedder({ dim: 4 });
    await expect(e.embed([{ id: "a", text: "a" }])).rejects.toThrow(/503 down/);
  });

  it("exposes model and dim from constructor opts", () => {
    const e = new OllamaEmbedder({ model: "custom", dim: 7 });
    expect(e.model).toBe("custom");
    expect(e.dim).toBe(7);
  });
});
