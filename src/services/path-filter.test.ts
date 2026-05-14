import { describe, expect, it } from "vitest";
import { DefaultPathFilter } from "./path-filter";

describe("DefaultPathFilter", () => {
  const filter = new DefaultPathFilter();

  it("accepts plain markdown files", () => {
    expect(filter.shouldIndex("Notes/foo.md")).toBe(true);
    expect(filter.shouldIndex("foo.md")).toBe(true);
  });

  it("rejects non-markdown files", () => {
    expect(filter.shouldIndex("foo.txt")).toBe(false);
    expect(filter.shouldIndex("image.png")).toBe(false);
    expect(filter.shouldIndex("Notes/")).toBe(false);
  });

  it.each(["obsidian", "git", "coworkmd", "trash"])(
    "rejects files under .%s/",
    (dir) => {
      expect(filter.shouldIndex(`.${dir}/cache.md`)).toBe(false);
      expect(filter.shouldIndex(`.${dir}/sub/file.md`)).toBe(false);
    },
  );

  it("normalizes leading ./ and / before checking", () => {
    expect(filter.shouldIndex("./.obsidian/workspace.json")).toBe(false);
    expect(filter.shouldIndex("/.git/HEAD.md")).toBe(false);
  });

  it("defers to a user-ignore matcher when provided", () => {
    const f = new DefaultPathFilter({
      matches: (p) => p.startsWith("Drafts/"),
    });
    expect(f.shouldIndex("Notes/keep.md")).toBe(true);
    expect(f.shouldIndex("Drafts/skip.md")).toBe(false);
  });
});
