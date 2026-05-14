import { describe, expect, it } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { IngestWriter } from "./ingest-writer";
import { buildSynthesisSpec, createSynthesisNote } from "./synthesis-writer";

describe("buildSynthesisSpec", () => {
  it("derives title from the question and strips trailing punctuation", () => {
    const spec = buildSynthesisSpec({
      question: "What is Gemmera?",
      answer: "A local RAG plugin.",
      citations: ["Notes/about.md"],
      model: "gemma4:e4b",
      runId: "run-1",
    });
    expect(spec.title).toBe("What is Gemmera");
  });

  it("truncates long titles to 80 chars with an ellipsis", () => {
    const long = "Q ".repeat(80).trim() + "?";
    const spec = buildSynthesisSpec({
      question: long,
      answer: "x",
      citations: [],
      model: "m",
      runId: "r",
    });
    expect(spec.title.length).toBeLessThanOrEqual(80);
    expect(spec.title.endsWith("...")).toBe(true);
  });

  it("stamps cowork.source as 'synthesis' so notes are distinguishable from ingest", () => {
    const spec = buildSynthesisSpec({
      question: "q",
      answer: "a",
      citations: [],
      model: "gemma4:e4b",
      runId: "run-42",
    });
    expect(spec.cowork.source).toBe("synthesis");
    expect(spec.cowork.run_id).toBe("run-42");
    expect(spec.cowork.model).toBe("gemma4:e4b");
  });

  it("places citations in `related` and as wikilinks in body Sources section", () => {
    const spec = buildSynthesisSpec({
      question: "q",
      answer: "a",
      citations: ["Notes/a.md", "Notes/b.md"],
      model: "m",
      runId: "r",
    });
    expect(spec.related).toEqual(["Notes/a.md", "Notes/b.md"]);
    expect(spec.body_markdown).toContain("## Sources");
    expect(spec.body_markdown).toContain("[[Notes/a]]");
    expect(spec.body_markdown).toContain("[[Notes/b]]");
  });

  it("omits Sources section when no citations are provided", () => {
    const spec = buildSynthesisSpec({
      question: "q",
      answer: "a",
      citations: [],
      model: "m",
      runId: "r",
    });
    expect(spec.body_markdown).not.toContain("## Sources");
  });
});

describe("createSynthesisNote", () => {
  it("writes a file with cowork frontmatter into the requested folder", async () => {
    const vault = new MockVaultService();
    const writer = new IngestWriter(vault);
    const { path, spec } = await createSynthesisNote(
      {
        question: "Why does the sky look blue?",
        answer: "Rayleigh scattering.",
        citations: ["Notes/physics.md"],
        model: "gemma4:e4b",
        runId: "run-9",
      },
      writer,
      { folder: "Synthesis/", now: () => Date.parse("2026-05-14T00:00:00Z") },
    );

    expect(path.startsWith("Synthesis/2026-05-14 ")).toBe(true);
    expect(path.endsWith(".md")).toBe(true);

    const content = await vault.read(path);
    expect(content).toContain("cowork_managed: true");
    expect(content).toContain("source: synthesis");
    expect(content).toContain("[[Notes/physics]]");
    expect(spec.cowork.source).toBe("synthesis");
  });
});
