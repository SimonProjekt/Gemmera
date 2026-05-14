import { describe, expect, it } from "vitest";
import { extractWikilinks } from "./view";

describe("extractWikilinks", () => {
  it("extracts simple wikilinks", () => {
    const text = "See [[My Note]] for details.";
    expect(extractWikilinks(text)).toEqual(["My Note"]);
  });

  it("extracts multiple wikilinks", () => {
    const text = "[[Note A]] and [[Note B]] are related.";
    expect(extractWikilinks(text)).toEqual(["Note A", "Note B"]);
  });

  it("deduplicates wikilinks", () => {
    const text = "[[Note A]] refers to [[Note A]] again.";
    expect(extractWikilinks(text)).toEqual(["Note A"]);
  });

  it("handles wikilinks with display text", () => {
    const text = "Check [[My Note|the note]] for more.";
    expect(extractWikilinks(text)).toEqual(["My Note"]);
  });

  it("returns empty array when no wikilinks", () => {
    const text = "No links here, just plain text.";
    expect(extractWikilinks(text)).toEqual([]);
  });

  it("ignores malformed wikilinks", () => {
    const text = "[[broken and [[also broken";
    expect(extractWikilinks(text)).toEqual([]);
  });

  it("extracts wikilinks with .md extension", () => {
    const text = "See [[notes/my-file.md]] for details.";
    expect(extractWikilinks(text)).toEqual(["notes/my-file.md"]);
  });
});
