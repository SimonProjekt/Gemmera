import { describe, expect, it } from "vitest";
import type { RetrievalHit } from "../contracts";
import { InMemoryLinksIndex } from "./in-memory-links-index";
import { DefaultPayloadAssembler } from "./payload-assembler";

function hit(partial: Partial<RetrievalHit> & { path: string }): RetrievalHit {
  return {
    path: partial.path,
    title: partial.title ?? partial.path.replace(/^.*\//, "").replace(/\.md$/, ""),
    ord: partial.ord ?? 0,
    contentHash: partial.contentHash ?? `h:${partial.path}:${partial.ord ?? 0}`,
    text: partial.text ?? `body of ${partial.path}`,
    headingPath: partial.headingPath ?? [],
    score: partial.score ?? 0.5,
    winningSignal: partial.winningSignal ?? "semantic",
  };
}

describe("DefaultPayloadAssembler", () => {
  it("returns an empty payload when there are no hits", () => {
    const links = new InMemoryLinksIndex();
    const assembler = new DefaultPayloadAssembler(links);
    expect(assembler.assemble("anything", [])).toEqual({ query: "anything", chunks: [] });
  });

  it("returns an empty payload when maxChunks is 0", () => {
    const links = new InMemoryLinksIndex();
    const assembler = new DefaultPayloadAssembler(links);
    const result = assembler.assemble("q", [hit({ path: "a.md" })], { maxChunks: 0 });
    expect(result.chunks).toEqual([]);
  });

  it("head-slices to maxChunks in retriever order without re-sorting", () => {
    const links = new InMemoryLinksIndex();
    const assembler = new DefaultPayloadAssembler(links);
    const hits = [
      hit({ path: "1.md", score: 0.1 }),
      hit({ path: "2.md", score: 0.9 }),
      hit({ path: "3.md", score: 0.5 }),
    ];
    const result = assembler.assemble("q", hits, { maxChunks: 2, includeNeighbors: false });
    expect(result.chunks.map((c) => c.path)).toEqual(["1.md", "2.md"]);
  });

  it("defaults to maxChunks=8", () => {
    const links = new InMemoryLinksIndex();
    const assembler = new DefaultPayloadAssembler(links);
    const hits = Array.from({ length: 12 }, (_, i) => hit({ path: `${i}.md`, ord: i }));
    const result = assembler.assemble("q", hits, { includeNeighbors: false });
    expect(result.chunks).toHaveLength(8);
  });

  it("projects hit fields and renames winningSignal to whyMatched", () => {
    const links = new InMemoryLinksIndex();
    const assembler = new DefaultPayloadAssembler(links);
    const result = assembler.assemble(
      "what is gemmera",
      [
        hit({
          path: "Projects/Gemmera.md",
          title: "Gemmera",
          ord: 3,
          headingPath: ["Overview", "Goals"],
          text: "An Obsidian plugin.",
          winningSignal: "backlink",
          score: 0.42,
        }),
      ],
      { includeNeighbors: false },
    );
    expect(result).toMatchInlineSnapshot(`
      {
        "chunks": [
          {
            "headingPath": [
              "Overview",
              "Goals",
            ],
            "path": "Projects/Gemmera.md",
            "text": "An Obsidian plugin.",
            "title": "Gemmera",
            "whyMatched": "backlink",
          },
        ],
        "query": "what is gemmera",
      }
    `);
  });

  it("omits score by default and forwards it when includeScores is true", () => {
    const links = new InMemoryLinksIndex();
    const assembler = new DefaultPayloadAssembler(links);
    const hits = [hit({ path: "a.md", score: 0.73 })];

    const noScore = assembler.assemble("q", hits, { includeNeighbors: false });
    expect(noScore.chunks[0]).not.toHaveProperty("score");

    const withScore = assembler.assemble("q", hits, {
      includeNeighbors: false,
      includeScores: true,
    });
    expect(withScore.chunks[0].score).toBe(0.73);
  });

  it("omits the neighbors field entirely when includeNeighbors is false", () => {
    const links = new InMemoryLinksIndex();
    links.upsert("a.md", [{ raw: "b" }]);
    links.upsert("b.md", []);
    const assembler = new DefaultPayloadAssembler(links);
    const result = assembler.assemble("q", [hit({ path: "a.md" })], {
      includeNeighbors: false,
    });
    expect(result.chunks[0]).not.toHaveProperty("neighbors");
  });

  it("emits an empty neighbors array when no links exist", () => {
    const links = new InMemoryLinksIndex();
    links.upsert("solo.md", []);
    const assembler = new DefaultPayloadAssembler(links);
    const result = assembler.assemble("q", [hit({ path: "solo.md" })]);
    expect(result.chunks[0].neighbors).toEqual([]);
  });

  it("resolves outgoing + backlinks, dedups by path, drops self, derives titles by basename", () => {
    const links = new InMemoryLinksIndex();
    // Vault: Notes/Hub.md links to Sub.md and Other.md.
    // Sub.md links back to Hub. Other.md links to Hub. Self-link from Hub→Hub.
    links.upsert("Notes/Hub.md", [{ raw: "Sub" }, { raw: "Other" }, { raw: "Hub" }]);
    links.upsert("Sub.md", [{ raw: "Hub" }]);
    links.upsert("Other.md", [{ raw: "Hub" }]);

    const assembler = new DefaultPayloadAssembler(links);
    const result = assembler.assemble("q", [hit({ path: "Notes/Hub.md" })]);
    // Outgoing first (Sub, Other; self skipped), then backlinks (Sub, Other
    // already deduped). Titles via basename, no .md suffix.
    expect(result.chunks[0].neighbors).toEqual(["Sub", "Other"]);
  });

  it("caps neighbors at maxNeighborsPerChunk", () => {
    const links = new InMemoryLinksIndex();
    links.upsert("hub.md", [
      { raw: "n1" },
      { raw: "n2" },
      { raw: "n3" },
      { raw: "n4" },
      { raw: "n5" },
      { raw: "n6" },
    ]);
    for (const n of ["n1", "n2", "n3", "n4", "n5", "n6"]) {
      links.upsert(`${n}.md`, []);
    }
    const assembler = new DefaultPayloadAssembler(links);
    const result = assembler.assemble("q", [hit({ path: "hub.md" })], {
      maxNeighborsPerChunk: 3,
    });
    expect(result.chunks[0].neighbors).toEqual(["n1", "n2", "n3"]);
  });

  it("memoizes neighbor lookup across chunks from the same note", () => {
    const links = new InMemoryLinksIndex();
    links.upsert("note.md", [{ raw: "neighbor" }]);
    links.upsert("neighbor.md", []);
    let outgoingCalls = 0;
    const spy = {
      outgoing: (path: string) => {
        outgoingCalls++;
        return links.outgoing(path);
      },
      backlinks: (path: string) => links.backlinks(path),
    };
    const assembler = new DefaultPayloadAssembler(spy);
    assembler.assemble("q", [
      hit({ path: "note.md", ord: 0 }),
      hit({ path: "note.md", ord: 1 }),
      hit({ path: "note.md", ord: 2 }),
    ]);
    expect(outgoingCalls).toBe(1);
  });

  it("snapshots the full payload shape with neighbors and scores enabled", () => {
    const links = new InMemoryLinksIndex();
    links.upsert("Projects/Gemmera.md", [{ raw: "RAG" }]);
    links.upsert("RAG.md", [{ raw: "Projects/Gemmera" }]);
    const assembler = new DefaultPayloadAssembler(links);
    const result = assembler.assemble(
      "what is gemmera",
      [
        hit({
          path: "Projects/Gemmera.md",
          title: "Gemmera",
          ord: 0,
          headingPath: ["Overview"],
          text: "An Obsidian plugin.",
          winningSignal: "semantic",
          score: 0.91,
        }),
        hit({
          path: "RAG.md",
          title: "RAG",
          ord: 0,
          headingPath: [],
          text: "Retrieval-augmented generation.",
          winningSignal: "lexical",
          score: 0.42,
        }),
      ],
      { includeScores: true, maxNeighborsPerChunk: 3 },
    );
    expect(result).toMatchInlineSnapshot(`
      {
        "chunks": [
          {
            "headingPath": [
              "Overview",
            ],
            "neighbors": [
              "RAG",
            ],
            "path": "Projects/Gemmera.md",
            "score": 0.91,
            "text": "An Obsidian plugin.",
            "title": "Gemmera",
            "whyMatched": "semantic",
          },
          {
            "headingPath": [],
            "neighbors": [
              "Gemmera",
            ],
            "path": "RAG.md",
            "score": 0.42,
            "text": "Retrieval-augmented generation.",
            "title": "RAG",
            "whyMatched": "lexical",
          },
        ],
        "query": "what is gemmera",
      }
    `);
  });
});
