import { describe, expect, it } from "vitest";
import { validateNotePreview } from "./note-preview-modal";

const base = {
  title: "Dogs",
  folder: "Inbox/",
  type: "source",
  status: "inbox",
  tags: "pet, animal",
  aliases: "Canine",
};

describe("validateNotePreview", () => {
  it("returns the parsed result for valid input", () => {
    const out = validateNotePreview(base, "Inbox/");
    expect("value" in out).toBe(true);
    if (!("value" in out)) return;
    expect(out.value).toEqual({
      confirmed: true,
      title: "Dogs",
      folder: "Inbox/",
      type: "source",
      status: "inbox",
      tags: ["pet", "animal"],
      aliases: ["Canine"],
    });
  });

  it("rejects an empty title", () => {
    const out = validateNotePreview({ ...base, title: "   " }, "Inbox/");
    expect("error" in out && out.error).toMatch(/title/i);
  });

  it("rejects a title longer than 120 chars", () => {
    const out = validateNotePreview({ ...base, title: "x".repeat(121) }, "Inbox/");
    expect("error" in out && out.error).toMatch(/120/);
  });

  it("rejects an out-of-enum type", () => {
    const out = validateNotePreview({ ...base, type: "bogus" }, "Inbox/");
    expect("error" in out && out.error).toMatch(/type/i);
  });

  it("rejects an out-of-enum status", () => {
    const out = validateNotePreview({ ...base, status: "bogus" }, "Inbox/");
    expect("error" in out && out.error).toMatch(/status/i);
  });

  it("falls back to the default folder when blank", () => {
    const out = validateNotePreview({ ...base, folder: "  " }, "Inbox/");
    expect("value" in out && out.value.folder).toBe("Inbox/");
  });

  it("trims and drops empty CSV entries", () => {
    const out = validateNotePreview({ ...base, tags: " a, , b ,", aliases: "" }, "Inbox/");
    if (!("value" in out)) throw new Error("expected value");
    expect(out.value.tags).toEqual(["a", "b"]);
    expect(out.value.aliases).toEqual([]);
  });
});
