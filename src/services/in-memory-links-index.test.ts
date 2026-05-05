import { describe, expect, it } from "vitest";
import { InMemoryLinksIndex, parseLinks } from "./in-memory-links-index";

describe("parseLinks", () => {
  it("extracts plain wikilinks", () => {
    expect(parseLinks("see [[Alpha]] and [[Beta]]")).toEqual([
      { raw: "Alpha" },
      { raw: "Beta" },
    ]);
  });

  it("strips alias, heading, and block fragments at parse time only as raw", () => {
    expect(parseLinks("[[Note|Alias]] [[Note#Heading]] [[Note^block]]")).toEqual([
      { raw: "Note|Alias" },
      { raw: "Note#Heading" },
      { raw: "Note^block" },
    ]);
  });

  it("ignores embeds (![[...]])", () => {
    expect(parseLinks("![[image.png]] and [[Real]]")).toEqual([{ raw: "Real" }]);
  });

  it("recognizes markdown links to .md files only", () => {
    const got = parseLinks(
      "[a](folder/a.md) [b](b.md#section) [c](https://x.com) [d](image.png)",
    );
    expect(got).toEqual([{ raw: "folder/a.md" }, { raw: "b.md#section" }]);
  });

  it("decodes percent-encoded markdown link targets", () => {
    expect(parseLinks("[t](folder%20with%20space/note.md)")).toEqual([
      { raw: "folder with space/note.md" },
    ]);
  });

  it("ignores links inside fenced code blocks", () => {
    const md = "outside [[A]]\n```\nlink [[B]] inside fence\n```\nafter [[C]]";
    expect(parseLinks(md)).toEqual([{ raw: "A" }, { raw: "C" }]);
  });

  it("ignores links inside tilde fences", () => {
    const md = "[[A]]\n~~~\n[[B]]\n~~~\n[[C]]";
    expect(parseLinks(md)).toEqual([{ raw: "A" }, { raw: "C" }]);
  });

  it("ignores links inside inline code spans", () => {
    expect(parseLinks("real [[A]] then `[[B]]` and [[C]]")).toEqual([
      { raw: "A" },
      { raw: "C" },
    ]);
  });

  it("returns empty for content without links", () => {
    expect(parseLinks("just words and a [text](https://example.com) link")).toEqual([]);
  });
});

describe("InMemoryLinksIndex", () => {
  it("starts empty", () => {
    const idx = new InMemoryLinksIndex();
    expect(idx.size()).toBe(0);
    expect(idx.outgoing("a.md")).toEqual([]);
    expect(idx.backlinks("a.md")).toEqual([]);
    expect(idx.neighborCount("a.md")).toBe(0);
  });

  it("registers a path even when it has no links, so basename resolution finds it", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("notes/A.md", []);
    idx.upsert("b.md", [{ raw: "A" }]);
    expect(idx.outgoing("b.md")).toEqual([
      { raw: "A", target: "notes/A.md", resolved: true },
    ]);
    expect(idx.backlinks("notes/A.md")).toEqual(["b.md"]);
  });

  it("resolves bare wikilinks against basenames (case-insensitive)", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("Folder/Alpha.md", []);
    idx.upsert("source.md", [{ raw: "alpha" }]);
    expect(idx.outgoing("source.md")[0]).toMatchObject({
      target: "Folder/Alpha.md",
      resolved: true,
    });
  });

  it("resolves full-path wikilinks with or without .md", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("a/b/note.md", []);
    idx.upsert("src.md", [{ raw: "a/b/note" }, { raw: "a/b/note.md" }]);
    const out = idx.outgoing("src.md");
    expect(out.every((l) => l.target === "a/b/note.md" && l.resolved)).toBe(true);
  });

  it("strips alias/heading/block fragments before resolving", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("Target.md", []);
    idx.upsert("src.md", [
      { raw: "Target|Alias" },
      { raw: "Target#Heading" },
      { raw: "Target^blk" },
    ]);
    for (const l of idx.outgoing("src.md")) expect(l.target).toBe("Target.md");
  });

  it("ranks basename collisions by shortest path then alphabetical", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("z/note.md", []);
    idx.upsert("a/note.md", []);
    idx.upsert("note.md", []); // shortest
    idx.upsert("src.md", [{ raw: "Note" }]);
    expect(idx.outgoing("src.md")[0].target).toBe("note.md");

    const idx2 = new InMemoryLinksIndex();
    idx2.upsert("z/note.md", []);
    idx2.upsert("a/note.md", []);
    idx2.upsert("src.md", [{ raw: "Note" }]); // tie at length 9 → alphabetical
    expect(idx2.outgoing("src.md")[0].target).toBe("a/note.md");
  });

  it("records unresolved links as targets=null and promotes them when the target arrives", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("src.md", [{ raw: "Future" }]);
    expect(idx.outgoing("src.md")[0]).toMatchObject({ target: null, resolved: false });
    expect(idx.backlinks("Future.md")).toEqual([]);

    idx.upsert("Future.md", []);
    expect(idx.outgoing("src.md")[0]).toMatchObject({
      target: "Future.md",
      resolved: true,
    });
    expect(idx.backlinks("Future.md")).toEqual(["src.md"]);
  });

  it("handles cyclic A↔B regardless of insertion order", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", [{ raw: "B" }]); // unresolved
    idx.upsert("B.md", [{ raw: "A" }]); // promotes both
    expect(idx.outgoing("A.md")[0].resolved).toBe(true);
    expect(idx.outgoing("B.md")[0].resolved).toBe(true);
    expect(idx.backlinks("A.md")).toEqual(["B.md"]);
    expect(idx.backlinks("B.md")).toEqual(["A.md"]);
  });

  it("self-links do not appear in backlinks or neighborCount", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", [{ raw: "A" }]);
    expect(idx.outgoing("A.md")[0]).toMatchObject({ target: "A.md", resolved: true });
    expect(idx.backlinks("A.md")).toEqual([]);
    expect(idx.neighborCount("A.md")).toBe(0);
  });

  it("upsert replaces edges: stale backlinks are removed, new ones added", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", []);
    idx.upsert("B.md", []);
    idx.upsert("src.md", [{ raw: "A" }]);
    expect(idx.backlinks("A.md")).toEqual(["src.md"]);

    idx.upsert("src.md", [{ raw: "B" }]);
    expect(idx.backlinks("A.md")).toEqual([]);
    expect(idx.backlinks("B.md")).toEqual(["src.md"]);
  });

  it("remove drops outgoing edges and demotes anyone who linked to it", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", []);
    idx.upsert("src.md", [{ raw: "A" }]);
    expect(idx.outgoing("src.md")[0].resolved).toBe(true);

    idx.remove("A.md");
    expect(idx.outgoing("src.md")[0]).toMatchObject({ target: null, resolved: false });
    expect(idx.backlinks("A.md")).toEqual([]);
    expect(idx.size()).toBe(1);
  });

  it("remove of an unknown path is a no-op", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", []);
    idx.remove("ghost.md");
    expect(idx.size()).toBe(1);
  });

  it("rename moves outgoing edges and rewrites resolved backlinks to the new path", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", []);
    idx.upsert("src.md", [{ raw: "A" }]);
    idx.rename("A.md", "Renamed.md");

    expect(idx.outgoing("src.md")[0]).toMatchObject({
      raw: "A", // raw text never rewrites
      target: "Renamed.md",
      resolved: true,
    });
    expect(idx.backlinks("Renamed.md")).toEqual(["src.md"]);
    expect(idx.backlinks("A.md")).toEqual([]);
  });

  it("rename moves a self-link target to the new path", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", [{ raw: "A" }]);
    idx.rename("A.md", "B.md");
    expect(idx.outgoing("B.md")[0]).toMatchObject({ target: "B.md", resolved: true });
  });

  it("rename to a basename that other unresolved links wanted promotes them", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("src.md", [{ raw: "Target" }]); // unresolved
    idx.upsert("placeholder.md", []);
    idx.rename("placeholder.md", "Target.md");
    expect(idx.outgoing("src.md")[0]).toMatchObject({
      target: "Target.md",
      resolved: true,
    });
  });

  it("neighborCount counts deduped 1-hop in+out, excluding self", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", []);
    idx.upsert("B.md", []);
    idx.upsert("hub.md", [{ raw: "A" }, { raw: "B" }, { raw: "hub" }]);
    idx.upsert("X.md", [{ raw: "hub" }]);
    idx.upsert("Y.md", [{ raw: "hub" }]);
    // out: A, B (self-link to hub excluded). in: X, Y. total 4.
    expect(idx.neighborCount("hub.md")).toBe(4);
  });

  it("neighborCount dedupes a path that is both incoming and outgoing", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("A.md", [{ raw: "B" }]);
    idx.upsert("B.md", [{ raw: "A" }]);
    expect(idx.neighborCount("A.md")).toBe(1);
  });

  it("backlinks() returns sorted, unique sources", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("T.md", []);
    idx.upsert("z.md", [{ raw: "T" }]);
    idx.upsert("a.md", [{ raw: "T" }]);
    idx.upsert("m.md", [{ raw: "T" }]);
    expect(idx.backlinks("T.md")).toEqual(["a.md", "m.md", "z.md"]);
  });

  it("size counts every upserted path even if it has no links", () => {
    const idx = new InMemoryLinksIndex();
    idx.upsert("a.md", []);
    idx.upsert("b.md", []);
    idx.upsert("c.md", [{ raw: "a" }, { raw: "b" }]);
    expect(idx.size()).toBe(3);
  });
});
