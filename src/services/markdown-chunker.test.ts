import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  CHUNK_CEILING_TOKENS,
  type ChunkerInput,
  type HeadingRef,
} from "../contracts";
import { MarkdownChunker } from "./markdown-chunker";

const chunker = new MarkdownChunker();

const lines = (...rows: string[]) => rows.join("\n");

function makeInput(content: string, headings: HeadingRef[] = []): ChunkerInput {
  return { path: "Notes/test.md", title: "test", content, headings };
}

function hsAt(content: string, ...specs: Array<[number, string]>): HeadingRef[] {
  // Locate each heading by its raw header line "#... text" at the start of a line.
  return specs.map(([level, text]) => {
    const needle = `${"#".repeat(level)} ${text}`;
    const offset = content.indexOf(needle);
    if (offset === -1) throw new Error(`heading not found: ${needle}`);
    return { level, text, offset };
  });
}

describe("MarkdownChunker", () => {
  it("returns no chunks for an empty file", () => {
    expect(chunker.chunk(makeInput(""))).toEqual([]);
  });

  it("returns no chunks for a frontmatter-only file", () => {
    const content = lines("---", "title: Tom", "tags: [test]", "---", "");
    expect(chunker.chunk(makeInput(content))).toEqual([]);
  });

  it("emits one chunk for a short file with no headings", () => {
    const content = "Bara lite text.\n\nEn paragraf till.";
    const out = chunker.chunk(makeInput(content));
    expect(out).toHaveLength(1);
    expect(out[0].headingPath).toEqual(["test"]);
    expect(out[0].text).toContain("paragraf till");
    expect(out[0].textForEmbed.startsWith("test\n\n")).toBe(true);
  });

  it("emits one chunk under a single H1", () => {
    const content = lines("# Inledning", "", "Här är en kort text.");
    const out = chunker.chunk(makeInput(content, hsAt(content, [1, "Inledning"])));
    expect(out).toHaveLength(1);
    expect(out[0].headingPath).toEqual(["test", "Inledning"]);
    expect(out[0].textForEmbed.startsWith("test > Inledning\n\n")).toBe(true);
  });

  it("emits one chunk per H1 > H2 > H2 section with correct heading paths", () => {
    const content = lines(
      "# Vandring",
      "",
      "Inledning till resan.",
      "",
      "## Dag 1",
      "",
      "Vi gick från Sundsvall till en liten stuga.",
      "",
      "## Dag 2",
      "",
      "Regn hela dagen, men vyerna var värda det.",
    );
    const out = chunker.chunk(
      makeInput(
        content,
        hsAt(content, [1, "Vandring"], [2, "Dag 1"], [2, "Dag 2"]),
      ),
    );
    expect(out).toHaveLength(3);
    expect(out[0].headingPath).toEqual(["test", "Vandring"]);
    expect(out[1].headingPath).toEqual(["test", "Vandring", "Dag 1"]);
    expect(out[2].headingPath).toEqual(["test", "Vandring", "Dag 2"]);
    expect(out[1].text).toContain("Sundsvall");
    expect(out[2].text).toContain("Regn");
  });

  it("respects the ceiling by paragraph-splitting an oversize section", () => {
    const para = "Lorem ipsum dolor sit amet, ".repeat(50); // ~1450 chars
    const longBody = Array.from({ length: 12 }, () => para).join("\n\n");
    const content = lines("# Stor sektion", "", longBody);
    const out = chunker.chunk(makeInput(content, hsAt(content, [1, "Stor sektion"])));
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.tokenCount).toBeLessThanOrEqual(CHUNK_CEILING_TOKENS);
    }
    // Every chunk preserves the heading prefix.
    for (const c of out) {
      expect(c.textForEmbed.startsWith("test > Stor sektion\n\n")).toBe(true);
    }
  });

  it("emits an oversize code fence as its own atomic chunk", () => {
    const codeBody = "fn main() { println!(\"hi\"); }\n".repeat(200); // ~6000 chars
    const fence = "```rust\n" + codeBody + "```";
    const content = lines("# Kod", "", "Här är ett exempel:", "", fence, "", "Slutkommentar.");
    const out = chunker.chunk(makeInput(content, hsAt(content, [1, "Kod"])));
    const fenceChunk = out.find((c) => c.text.startsWith("```rust"));
    expect(fenceChunk).toBeDefined();
    // The fence chunk is allowed to exceed the ceiling (atomic).
    expect(fenceChunk!.text).toContain("println!");
    expect(fenceChunk!.text).toMatch(/```$/);
  });

  it("is deterministic — same input produces identical chunks and hashes", () => {
    const content = lines(
      "# A",
      "",
      "första paragraf.",
      "",
      "## B",
      "",
      "andra paragraf.",
    );
    const headings = hsAt(content, [1, "A"], [2, "B"]);
    const a = chunker.chunk(makeInput(content, headings));
    const b = chunker.chunk(makeInput(content, headings));
    expect(b).toEqual(a);
    expect(a[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("strips frontmatter before chunking", () => {
    const content = lines(
      "---",
      "title: Test",
      "---",
      "# Riktig rubrik",
      "",
      "Brödtext.",
    );
    // Heading offset is in the raw file, after the frontmatter.
    const offset = content.indexOf("# Riktig");
    const out = chunker.chunk(
      makeInput(content, [{ level: 1, text: "Riktig rubrik", offset }]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).not.toContain("title:");
    expect(out[0].headingPath).toEqual(["test", "Riktig rubrik"]);
  });
});

describe("MarkdownChunker — Jonas vault fixture", () => {
  it("chunks projektanteckningar_bokhylla.md preserving structure", () => {
    const path = join(
      __dirname,
      "..",
      "..",
      "demo-vault",
      "raw",
      "projektanteckningar_bokhylla.md",
    );
    const content = readFileSync(path, "utf8");
    // Hand-locate the headings we know are in the file.
    const headings = hsAt(
      content,
      [1, "bokhylla — projektanteckningar"],
      [2, "Vad det gör"],
      [2, "Kommandon (nuläge)"],
    ).filter((h, _, all) => all.findIndex((x) => x.offset === h.offset) === all.indexOf(h));

    const out = chunker.chunk({
      path: "demo-vault/raw/projektanteckningar_bokhylla.md",
      title: "bokhylla",
      content,
      headings,
    });

    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      // Heading prefix is always present.
      expect(c.textForEmbed.startsWith("bokhylla")).toBe(true);
      // tokenCount ≤ ceiling unless it's an oversize atomic code fence.
      const isOversizeCode = c.text.startsWith("```") && c.text.endsWith("```");
      if (!isOversizeCode) {
        expect(c.tokenCount).toBeLessThanOrEqual(CHUNK_CEILING_TOKENS);
      }
      // Hash is well-formed.
      expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Ord values are 0..n-1 contiguous.
    expect(out.map((c) => c.ord)).toEqual(out.map((_, i) => i));
  });

  it("uses the conservative chars-per-token estimate", () => {
    // Sanity: a 4-char string is ~1 token under our heuristic.
    const out = chunker.chunk(makeInput("abcd"));
    expect(out[0].tokenCount).toBe(Math.ceil(4 / CHARS_PER_TOKEN));
  });
});
