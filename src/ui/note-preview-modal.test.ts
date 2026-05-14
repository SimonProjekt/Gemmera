import { describe, expect, it } from "vitest";
import { validateNotePreview } from "./note-preview-modal";

const base = {
  title: "Dogs",
  folder: "Inbox/",
  type: "source",
  status: "inbox",
  tags: "pet, animal",
  aliases: "Canine",
  summary: "Notes about dogs.",
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
      summary: "Notes about dogs.",
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

  it("rejects an empty / whitespace summary (rag.md schema requires 1+ chars)", () => {
    const out = validateNotePreview({ ...base, summary: "   " }, "Inbox/");
    expect("error" in out && out.error).toMatch(/summary/i);
  });

  it("rejects a summary longer than 600 chars", () => {
    const out = validateNotePreview({ ...base, summary: "x".repeat(601) }, "Inbox/");
    expect("error" in out && out.error).toMatch(/600/);
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
