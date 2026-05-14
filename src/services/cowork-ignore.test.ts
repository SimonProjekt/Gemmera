import { describe, expect, it } from "vitest";
import { CoworkIgnore, DEFAULT_COWORKIGNORE } from "./cowork-ignore";

// ── Parsing ───────────────────────────────────────────────────────────────────

describe("CoworkIgnore — parsing", () => {
  it("ignores blank lines", () => {
    const ig = new CoworkIgnore("\n\n   \n");
    expect(ig.matches("Notes/foo.md")).toBe(false);
  });

  it("ignores comment lines", () => {
    const ig = new CoworkIgnore("# this is a comment\n  # also a comment");
    expect(ig.matches("Notes/foo.md")).toBe(false);
  });

  it("tolerates CRLF line endings", () => {
    const ig = new CoworkIgnore("Templates/\r\n*.canvas\r\n");
    expect(ig.matches("Templates/x.md")).toBe(true);
    expect(ig.matches("diagram.canvas")).toBe(true);
  });
});

// ── Folder patterns ───────────────────────────────────────────────────────────

describe("CoworkIgnore — folder patterns (trailing /)", () => {
  const ig = new CoworkIgnore("Templates/");

  it("ignores the folder itself", () => {
    expect(ig.matches("Templates")).toBe(true);
  });

  it("ignores files inside the folder", () => {
    expect(ig.matches("Templates/Weekly.md")).toBe(true);
    expect(ig.matches("Templates/nested/deep.md")).toBe(true);
  });

  it("does not ignore files in other folders", () => {
    expect(ig.matches("Notes/foo.md")).toBe(false);
    expect(ig.matches("NotTemplates/foo.md")).toBe(false);
  });

  it("matches at any depth when pattern has no internal slash (gitignore semantics)", () => {
    expect(ig.matches("Sub/Templates/x.md")).toBe(true);
    expect(ig.matches("a/b/Templates/x.md")).toBe(true);
    expect(ig.matches("a/b/Templates")).toBe(true);
  });
});

describe("CoworkIgnore — anchored folder patterns", () => {
  it("leading slash anchors to vault root", () => {
    const ig = new CoworkIgnore("/Templates/");
    expect(ig.matches("Templates/x.md")).toBe(true);
    expect(ig.matches("Sub/Templates/x.md")).toBe(false);
  });

  it("internal slash anchors to vault root", () => {
    const ig = new CoworkIgnore("Archive/2024/");
    expect(ig.matches("Archive/2024/x.md")).toBe(true);
    expect(ig.matches("Outer/Archive/2024/x.md")).toBe(false);
  });

  it("glob folder pattern works at any depth", () => {
    const ig = new CoworkIgnore("Draft-*/");
    expect(ig.matches("Draft-2024/x.md")).toBe(true);
    expect(ig.matches("Sub/Draft-2024/x.md")).toBe(true);
    expect(ig.matches("DraftX/x.md")).toBe(false);
  });
});

// ── Glob patterns ─────────────────────────────────────────────────────────────

describe("CoworkIgnore — glob patterns", () => {
  const ig = new CoworkIgnore("*.canvas");

  it("ignores canvas files at root", () => {
    expect(ig.matches("diagram.canvas")).toBe(true);
  });

  it("ignores canvas files in nested folders", () => {
    expect(ig.matches("Drawings/mind-map.canvas")).toBe(true);
    expect(ig.matches("deep/nested/chart.canvas")).toBe(true);
  });

  it("does not ignore non-canvas files", () => {
    expect(ig.matches("Notes/foo.md")).toBe(false);
    expect(ig.matches("diagram.canvasX")).toBe(false);
  });
});

describe("CoworkIgnore — wildcard patterns", () => {
  it("* does not cross path separator", () => {
    const ig = new CoworkIgnore("*.excalidraw");
    expect(ig.matches("diagram.excalidraw")).toBe(true);
    expect(ig.matches("Notes/diagram.excalidraw")).toBe(true);
  });

  it("** matches across path separators", () => {
    const ig = new CoworkIgnore("Templates/**");
    expect(ig.matches("Templates/Weekly.md")).toBe(true);
    expect(ig.matches("Templates/sub/deep.md")).toBe(true);
  });
});

// ── Negation ──────────────────────────────────────────────────────────────────

describe("CoworkIgnore — negation (last-match-wins)", () => {
  it("Templates/** + !Templates/KeepMe.md keeps the negated file", () => {
    const ig = new CoworkIgnore("Templates/**\n!Templates/KeepMe.md");
    expect(ig.matches("Templates/Weekly.md")).toBe(true);
    expect(ig.matches("Templates/KeepMe.md")).toBe(false);
  });

  it("negation of a subfolder overrides folder exclusion", () => {
    const ig = new CoworkIgnore("Archive/\n!Archive/Important/");
    expect(ig.matches("Archive/old-note.md")).toBe(true);
    expect(ig.matches("Archive/Important")).toBe(false);
    expect(ig.matches("Archive/Important/key.md")).toBe(false);
  });

  it("later rules override earlier negations", () => {
    const ig = new CoworkIgnore("*.draft\n!keep.draft\n*.draft");
    // Final rule re-ignores everything including keep.draft
    expect(ig.matches("keep.draft")).toBe(true);
  });
});

// ── Hard ignores ──────────────────────────────────────────────────────────────

describe("CoworkIgnore — hard ignores cannot be negated", () => {
  it.each(["obsidian", "git", "trash", "coworkmd"])(
    ".%s/ is always ignored",
    (dir) => {
      const ig = new CoworkIgnore(`!.${dir}/`);
      expect(ig.matches(`.${dir}/somefile.md`)).toBe(true);
      expect(ig.matches(`.${dir}`)).toBe(true);
    },
  );

  it("user negation on .obsidian does not un-ignore it", () => {
    const ig = new CoworkIgnore("!.obsidian/workspace.json");
    expect(ig.matches(".obsidian/workspace.json")).toBe(true);
  });
});

// ── reload() ─────────────────────────────────────────────────────────────────

describe("CoworkIgnore — reload()", () => {
  it("updates rules without creating a new instance", () => {
    const ig = new CoworkIgnore("");
    expect(ig.matches("Templates/Weekly.md")).toBe(false);
    ig.reload("Templates/");
    expect(ig.matches("Templates/Weekly.md")).toBe(true);
  });

  it("clears old rules on reload", () => {
    const ig = new CoworkIgnore("Templates/");
    expect(ig.matches("Templates/Weekly.md")).toBe(true);
    ig.reload(""); // no rules
    expect(ig.matches("Templates/Weekly.md")).toBe(false);
  });
});

// ── Default contents ──────────────────────────────────────────────────────────

describe("CoworkIgnore — default contents", () => {
  const ig = new CoworkIgnore(DEFAULT_COWORKIGNORE);

  it.each([
    "Templates/Weekly.md",
    "Attachments/image.png",
    "attachments/photo.jpg",
    "assets/logo.svg",
    "diagram.canvas",
    "Notes/chart.canvas",
    "sketch.excalidraw",
    "Drawings/board.excalidraw",
  ])("ignores %s by default", (path) => {
    expect(ig.matches(path)).toBe(true);
  });

  it("does not ignore regular notes", () => {
    expect(ig.matches("Notes/meeting.md")).toBe(false);
    expect(ig.matches("Inbox/todo.md")).toBe(false);
  });
});

// ── Anchored patterns ─────────────────────────────────────────────────────────

describe("CoworkIgnore — anchored patterns (pattern with /)", () => {
  it("path-specific pattern matches only that path", () => {
    const ig = new CoworkIgnore("Archive/2024/");
    expect(ig.matches("Archive/2024/note.md")).toBe(true);
    expect(ig.matches("Archive/2025/note.md")).toBe(false);
  });

  it("exact file pattern matches only that file", () => {
    const ig = new CoworkIgnore("do-not-index.md");
    expect(ig.matches("do-not-index.md")).toBe(true);
    expect(ig.matches("Notes/do-not-index.md")).toBe(true); // unanchored
  });

  it("anchored exact file does not match at other depths", () => {
    const ig = new CoworkIgnore("Private/secret.md");
    expect(ig.matches("Private/secret.md")).toBe(true);
    expect(ig.matches("Archive/Private/secret.md")).toBe(false);
  });
});
