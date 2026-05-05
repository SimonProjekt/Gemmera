import { describe, expect, it } from "vitest";
import { InMemoryBM25Index, tokenize } from "./in-memory-bm25-index";

describe("tokenize", () => {
  it("lowercases and splits on non-letter/non-digit boundaries", () => {
    expect(tokenize("Hello, World! 42.")).toEqual(["hello", "world", "42"]);
  });

  it("preserves Swedish characters as letters", () => {
    expect(tokenize("Vandring längs Höga kusten — åska")).toEqual([
      "vandring",
      "längs",
      "höga",
      "kusten",
      "åska",
    ]);
  });

  it("returns [] for empty or whitespace-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \n\t  ")).toEqual([]);
  });

  it("treats consecutive separators as one boundary", () => {
    expect(tokenize("a   b\n\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("InMemoryBM25Index", () => {
  it("starts empty", () => {
    const idx = new InMemoryBM25Index();
    expect(idx.count()).toBe(0);
    expect(idx.search("anything", 5)).toEqual([]);
  });

  it("addDoc is idempotent for the same hash", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("h1", "hello world");
    idx.addDoc("h1", "completely different text");
    expect(idx.count()).toBe(1);
    // Content didn't actually change because the hash is the source of truth.
    const hits = idx.search("different", 5);
    expect(hits).toEqual([]);
  });

  it("ranks docs by BM25 — higher term frequency outranks lower", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("a", "alpha alpha alpha beta");
    idx.addDoc("b", "alpha gamma");
    idx.addDoc("c", "delta epsilon");
    const hits = idx.search("alpha", 5);
    expect(hits.map((h) => h.contentHash)).toEqual(["a", "b"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("rare terms outweigh common terms via IDF", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("a", "the the the rare");
    idx.addDoc("b", "the the the the the");
    idx.addDoc("c", "the the");
    const both = idx.search("rare the", 5);
    // 'a' has 'rare' (df=1, high idf) while 'b' only has 'the' (df=3, near-zero idf).
    expect(both[0].contentHash).toBe("a");
  });

  it("respects topK", () => {
    const idx = new InMemoryBM25Index();
    for (let i = 0; i < 10; i++) idx.addDoc(`h${i}`, `term doc ${i}`);
    expect(idx.search("term", 3)).toHaveLength(3);
  });

  it("returns [] when query has no recognized tokens", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("a", "hello world");
    expect(idx.search("---", 5)).toEqual([]);
    expect(idx.search("", 5)).toEqual([]);
  });

  it("returns [] when no doc contains any query token", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("a", "hello world");
    expect(idx.search("zebra", 5)).toEqual([]);
  });

  it("removeDoc evicts the doc and frees its postings", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("a", "alpha");
    idx.addDoc("b", "alpha beta");
    idx.removeDoc("a");
    expect(idx.has("a")).toBe(false);
    expect(idx.count()).toBe(1);
    const hits = idx.search("alpha", 5);
    expect(hits.map((h) => h.contentHash)).toEqual(["b"]);
  });

  it("removeDoc on unknown hash is a no-op", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("a", "alpha");
    idx.removeDoc("ghost");
    expect(idx.count()).toBe(1);
  });

  it("re-adds a doc after removal (no stale state)", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("a", "alpha");
    idx.removeDoc("a");
    idx.addDoc("a", "beta");
    expect(idx.search("alpha", 5)).toEqual([]);
    expect(idx.search("beta", 5).map((h) => h.contentHash)).toEqual(["a"]);
  });

  it("scores are non-negative", () => {
    const idx = new InMemoryBM25Index();
    for (let i = 0; i < 50; i++) idx.addDoc(`h${i}`, "the and of in");
    idx.addDoc("rare", "phoenix");
    const hits = idx.search("the phoenix", 100);
    for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(0);
  });

  it("ties break on contentHash for determinism", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("zzz", "alpha");
    idx.addDoc("aaa", "alpha");
    idx.addDoc("mmm", "alpha");
    const hits = idx.search("alpha", 5);
    expect(hits.map((h) => h.contentHash)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("doc length normalization: shorter docs outrank longer ones at equal tf", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("short", "alpha filler");
    idx.addDoc("long", "alpha " + "filler ".repeat(50));
    const hits = idx.search("alpha", 5);
    expect(hits[0].contentHash).toBe("short");
  });

  it("Swedish content can be searched in Swedish", () => {
    const idx = new InMemoryBM25Index();
    idx.addDoc("a", "Vandring längs Höga kusten i höst.");
    idx.addDoc("b", "Diskussion om migrering av databaser.");
    expect(idx.search("vandring", 5).map((h) => h.contentHash)).toEqual(["a"]);
    expect(idx.search("höga kusten", 5)[0].contentHash).toBe("a");
    expect(idx.search("migrering", 5).map((h) => h.contentHash)).toEqual(["b"]);
  });
});
