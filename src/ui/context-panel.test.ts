import { describe, expect, it } from "vitest";
import type { NoteSpec } from "../contracts/ingest";
import { MAX_SNIPPET_CHARS, mergeEditsIntoSpec, snippet, whyLabel } from "./context-panel";

describe("whyLabel", () => {
  it("maps each winning signal to a short tag", () => {
    expect(whyLabel("semantic")).toBe("semantic");
    expect(whyLabel("lexical")).toBe("keyword");
    expect(whyLabel("backlink")).toBe("linked");
    expect(whyLabel("tag")).toBe("tag");
    expect(whyLabel("recency")).toBe("recent");
  });
});

describe("snippet", () => {
  it("collapses whitespace", () => {
    expect(snippet("a   b\n\nc\td")).toBe("a b c d");
  });

  it("returns the full text when under the cap", () => {
    expect(snippet("short")).toBe("short");
  });

  it("truncates with an ellipsis when over the cap", () => {
    const long = "x".repeat(MAX_SNIPPET_CHARS + 50);
    const out = snippet(long);
    expect(out.length).toBe(MAX_SNIPPET_CHARS + 1); // +1 for the ellipsis char
    expect(out.endsWith("…")).toBe(true);
  });

  it("trims leading and trailing whitespace before counting", () => {
    expect(snippet("   hello   ")).toBe("hello");
  });
});

describe("mergeEditsIntoSpec (inline preview #55)", () => {
  const base: NoteSpec = {
    title: "orig",
    type: "source",
    tags: ["a"],
    aliases: [],
    source: "chat-paste",
    entities: ["E1"],
    related: ["Notes/X.md"],
    status: "inbox",
    summary: "orig summary",
    key_points: ["k1"],
    body_markdown: "## orig\n\nbody",
    cowork: {
      source: "ingest",
      run_id: "run-1",
      model: "test-model",
      version: "0.0.1",
      confidence: "high",
    },
  };

  it("overrides editable fields, preserves the rest", () => {
    const out = mergeEditsIntoSpec(base, {
      title: "renamed",
      type: "evergreen",
      status: "processed",
      tags: ["new-tag"],
      aliases: ["Alt"],
      summary: "edited summary",
    });
    expect(out.title).toBe("renamed");
    expect(out.type).toBe("evergreen");
    expect(out.status).toBe("processed");
    expect(out.tags).toEqual(["new-tag"]);
    expect(out.aliases).toEqual(["Alt"]);
    expect(out.summary).toBe("edited summary");
    // Non-editable fields carry through unchanged.
    expect(out.source).toBe("chat-paste");
    expect(out.entities).toEqual(["E1"]);
    expect(out.related).toEqual(["Notes/X.md"]);
    expect(out.key_points).toEqual(["k1"]);
    expect(out.body_markdown).toBe("## orig\n\nbody");
    expect(out.cowork).toEqual(base.cowork);
  });

  it("does not mutate the base spec", () => {
    const snapshot = JSON.stringify(base);
    mergeEditsIntoSpec(base, {
      title: "x",
      type: "source",
      status: "inbox",
      tags: [],
      aliases: [],
      summary: "s",
    });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});
