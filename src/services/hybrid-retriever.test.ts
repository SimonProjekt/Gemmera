import { describe, expect, it } from "vitest";
import type { BM25Hit, Chunk, Embedder, LinksIndex, NoteLink, SearchHit } from "../contracts";
import { HybridRetriever } from "./hybrid-retriever";

const DIM = 4;

function makeChunk(path: string, ord: number, hash: string): Chunk {
  return {
    path,
    ord,
    headingPath: ["H"],
    text: `text-${hash}`,
    textForEmbed: `H > text-${hash}`,
    tokenCount: 1,
    contentHash: hash,
  };
}

class FakeEmbedder implements Embedder {
  readonly model = "fake";
  readonly dim = DIM;
  async embed(reqs: { id: string; text: string }[]) {
    return reqs.map((r) => ({ id: r.id, vec: new Float32Array(DIM) }));
  }
}

function fakeVectorStore(hits: SearchHit[]) {
  return {
    async search(_q: Float32Array, _topK: number): Promise<SearchHit[]> {
      return [...hits];
    },
  };
}

function fakeBM25(hits: BM25Hit[]) {
  return {
    search: () => [...hits],
  };
}

function fakeLinks(out: Record<string, NoteLink[]> = {}, back: Record<string, string[]> = {}) {
  const idx: LinksIndex = {
    outgoing: (p) => out[p] ?? [],
    backlinks: (p) => back[p] ?? [],
    neighborCount: () => 0,
    size: () => Object.keys(out).length,
  };
  return idx;
}

function fakeStore(table: Record<string, Chunk[]>) {
  return {
    async getChunksByHash(h: string): Promise<Chunk[]> {
      return table[h] ?? [];
    },
  };
}

describe("HybridRetriever", () => {
  it("throws on empty query", async () => {
    const r = new HybridRetriever(new FakeEmbedder(), fakeVectorStore([]), fakeBM25([]), fakeLinks(), fakeStore({}));
    await expect(r.retrieve("")).rejects.toThrow(/empty query/);
    await expect(r.retrieve("   ")).rejects.toThrow(/empty query/);
  });

  it("returns [] for topK <= 0", async () => {
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore([{ contentHash: "h1", score: 1 }]),
      fakeBM25([]),
      fakeLinks(),
      fakeStore({ h1: [makeChunk("a.md", 0, "h1")] }),
    );
    expect(await r.retrieve("q", { topK: 0 })).toEqual([]);
  });

  it("returns [] when both indexes are empty (cold start)", async () => {
    const r = new HybridRetriever(new FakeEmbedder(), fakeVectorStore([]), fakeBM25([]), fakeLinks(), fakeStore({}));
    expect(await r.retrieve("anything")).toEqual([]);
  });

  it("returns [] when candidates exist but no chunk hydrates (stale index)", async () => {
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore([{ contentHash: "ghost", score: 1 }]),
      fakeBM25([]),
      fakeLinks(),
      fakeStore({}), // ghost hash not present in store
    );
    expect(await r.retrieve("q")).toEqual([]);
  });

  it("tags pure-semantic hits as semantic and pure-lexical hits as lexical", async () => {
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore([{ contentHash: "h_sem", score: 0.9 }]),
      fakeBM25([{ contentHash: "h_lex", score: 5 }]),
      fakeLinks(),
      fakeStore({
        h_sem: [makeChunk("sem.md", 0, "h_sem")],
        h_lex: [makeChunk("lex.md", 0, "h_lex")],
      }),
    );
    const hits = await r.retrieve("query");
    const byPath = Object.fromEntries(hits.map((h) => [h.path, h.winningSignal]));
    expect(byPath["sem.md"]).toBe("semantic");
    expect(byPath["lex.md"]).toBe("lexical");
  });

  it("when both signals contain a hash, the better-ranked signal wins the tag", async () => {
    const r = new HybridRetriever(
      new FakeEmbedder(),
      // h1 ranks 1st semantically
      fakeVectorStore([{ contentHash: "h1", score: 0.9 }, { contentHash: "h2", score: 0.5 }]),
      // h1 ranks 2nd lexically (h2 first)
      fakeBM25([{ contentHash: "h2", score: 8 }, { contentHash: "h1", score: 3 }]),
      fakeLinks(),
      fakeStore({
        h1: [makeChunk("a.md", 0, "h1")],
        h2: [makeChunk("b.md", 0, "h2")],
      }),
    );
    const hits = await r.retrieve("q");
    const byPath = Object.fromEntries(hits.map((h) => [h.path, h.winningSignal]));
    // h1: semantic rank 0 (sem contribution wins), h2: lexical rank 0 (lex contribution wins).
    expect(byPath["a.md"]).toBe("semantic");
    expect(byPath["b.md"]).toBe("lexical");
  });

  it("link-graph boost promotes a chunk whose note is linked from another candidate", async () => {
    // Semantic ranking: target_a (rank 0) > distractor (rank 1) > target_b (rank 2).
    // Without link boost, distractor would land in top-2 ahead of target_b.
    // With link boost: target_b is linked from target_a (an even-stronger semantic
    // hit), and that overlap pushes target_b above distractor.
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore([
        { contentHash: "h_a", score: 1.0 },
        { contentHash: "h_d", score: 0.95 },
        { contentHash: "h_b", score: 0.6 },
      ]),
      fakeBM25([]),
      fakeLinks(
        { "a.md": [{ raw: "B", target: "b.md", resolved: true }] },
        { "b.md": ["a.md"] },
      ),
      fakeStore({
        h_a: [makeChunk("a.md", 0, "h_a")],
        h_b: [makeChunk("b.md", 0, "h_b")],
        h_d: [makeChunk("distractor.md", 0, "h_d")],
      }),
    );
    const hits = await r.retrieve("q", { topK: 2 });
    expect(hits.map((h) => h.path)).toEqual(["a.md", "b.md"]);
    // b.md surfaced above the distractor because of the backlink from a.md.
    expect(hits[1].winningSignal).toBe("backlink");
  });

  it("self-links are not counted as candidate-graph overlap", async () => {
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore([{ contentHash: "h_a", score: 1 }]),
      fakeBM25([]),
      fakeLinks({ "a.md": [{ raw: "A", target: "a.md", resolved: true }] }, {}),
      fakeStore({ h_a: [makeChunk("a.md", 0, "h_a")] }),
    );
    const [hit] = await r.retrieve("q");
    // No other candidate paths overlap, so winning signal stays semantic.
    expect(hit.winningSignal).toBe("semantic");
  });

  it("a hash referenced from multiple paths produces one hit per chunk", async () => {
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore([{ contentHash: "shared", score: 1 }]),
      fakeBM25([]),
      fakeLinks(),
      fakeStore({
        shared: [makeChunk("a.md", 0, "shared"), makeChunk("b.md", 1, "shared")],
      }),
    );
    const hits = await r.retrieve("q");
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => `${h.path}:${h.ord}`).sort()).toEqual(["a.md:0", "b.md:1"]);
  });

  it("respects topK and sorts highest score first", async () => {
    const sem: SearchHit[] = [];
    const table: Record<string, Chunk[]> = {};
    for (let i = 0; i < 10; i++) {
      sem.push({ contentHash: `h${i}`, score: 1 - i * 0.05 });
      table[`h${i}`] = [makeChunk(`note-${i}.md`, 0, `h${i}`)];
    }
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore(sem),
      fakeBM25([]),
      fakeLinks(),
      fakeStore(table),
    );
    const hits = await r.retrieve("q", { topK: 3 });
    expect(hits).toHaveLength(3);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score);
    }
  });

  it("populates RetrievalHit fields from chunk metadata", async () => {
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore([{ contentHash: "h", score: 1 }]),
      fakeBM25([]),
      fakeLinks(),
      fakeStore({
        h: [
          {
            path: "Folder/Note.md",
            ord: 2,
            headingPath: ["Top", "Sub"],
            text: "body text",
            textForEmbed: "Top > Sub > body text",
            tokenCount: 4,
            contentHash: "h",
          },
        ],
      }),
    );
    const [hit] = await r.retrieve("q");
    expect(hit).toMatchObject({
      path: "Folder/Note.md",
      title: "Note",
      ord: 2,
      contentHash: "h",
      text: "body text",
      headingPath: ["Top", "Sub"],
    });
    expect(hit.score).toBeGreaterThan(0);
  });

  it("identical inputs produce identical output (deterministic)", async () => {
    // A shared hash maps to two chunks at the same fused score — a real tie.
    const r = new HybridRetriever(
      new FakeEmbedder(),
      fakeVectorStore([{ contentHash: "shared", score: 0.9 }]),
      fakeBM25([]),
      fakeLinks(),
      fakeStore({ shared: [makeChunk("z.md", 0, "shared"), makeChunk("a.md", 0, "shared")] }),
    );
    const r1 = await r.retrieve("q");
    const r2 = await r.retrieve("q");
    expect(r1).toEqual(r2);
    // Tie broken on path alphabetical: a.md before z.md.
    expect(r1.map((h) => h.path)).toEqual(["a.md", "z.md"]);
  });
});
