import { describe, expect, it } from "vitest";
import { MAX_SNIPPET_CHARS, snippet, whyLabel } from "./context-panel";

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
