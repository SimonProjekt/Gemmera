import { describe, expect, it, vi } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { dispatchToolCall, appendUnderDatedSection, patchFrontmatter, type ToolDispatchDeps } from "./tool-dispatcher";
import { InMemoryJobQueue } from "./in-memory-job-queue";
import { IngestWriter } from "./ingest-writer";

function makeDeps(overrides: Partial<ToolDispatchDeps> = {}): ToolDispatchDeps {
  const vault = new MockVaultService();
  return {
    vault,
    ingestWriter: new IngestWriter(vault),
    jobQueue: new InMemoryJobQueue(),
    index: { search: vi.fn().mockResolvedValue([]) },
    linksIndex: { neighborCount: vi.fn().mockReturnValue(0) },
    inboxFolder: "Inbox/",
    chatModel: "gemma",
    openNotePreview: vi.fn().mockResolvedValue(null),
    confirmDelete: vi.fn().mockResolvedValue("cancelled"),
    confirmRename: vi.fn().mockResolvedValue("cancelled"),
    appendSystemMessage: vi.fn(),
    ...overrides,
  };
}

const fullConfirm = {
  confirmed: true as const,
  title: "Dogs",
  folder: "Inbox/",
  tags: [],
  aliases: [],
  type: "source" as const,
  status: "inbox" as const,
  summary: "Notes on dogs.",
};

describe("dispatchToolCall — routing", () => {
  it("routes save_note with mode=create to save handler", async () => {
    const deps = makeDeps({ openNotePreview: vi.fn().mockResolvedValue(fullConfirm) });

    const result = await dispatchToolCall(
      { id: "1", name: "save_note", arguments: { mode: "create", title: "Dogs", body_markdown: "Dogs are great.", summary: "Notes on dogs." } },
      deps,
    );

    expect(result.kind).toBe("done");
    expect(await deps.vault.exists("Inbox/Dogs.md")).toBe(true);
  });

  it("appends save_note with mode=append under today's heading", async () => {
    const vault = new MockVaultService({ "Inbox/Dogs.md": "Existing" });
    const deps = makeDeps({ vault });
    const result = await dispatchToolCall(
      { id: "2", name: "save_note", arguments: { mode: "append", path: "Inbox/Dogs.md", body_markdown: "New entry" } },
      deps,
    );
    expect(result.kind).toBe("done");
    expect(await vault.read("Inbox/Dogs.md")).toContain("New entry");
  });

  it("returns unknown_tool for unrecognised tool names", async () => {
    const deps = makeDeps();
    const result = await dispatchToolCall(
      { id: "3", name: "hallucinated_tool", arguments: {} },
      deps,
    );
    expect(result.kind).toBe("unknown_tool");
  });

  it("returns cancelled and posts system message when preview is dismissed", async () => {
    const appendSystemMessage = vi.fn();
    const deps = makeDeps({
      openNotePreview: vi.fn().mockResolvedValue(null),
      appendSystemMessage,
    });

    const result = await dispatchToolCall(
      { id: "4", name: "save_note", arguments: { mode: "create", title: "X", body_markdown: "" } },
      deps,
    );

    expect(result.kind).toBe("cancelled");
    expect(appendSystemMessage).toHaveBeenCalledWith("Save cancelled.");
  });
});

describe("dispatchSaveCreate — schema compliance (#52 review)", () => {
  it("emits all required rag.md frontmatter keys even when arrays are empty", async () => {
    const vault = new MockVaultService();
    const deps = makeDeps({ vault, openNotePreview: vi.fn().mockResolvedValue(fullConfirm) });

    await dispatchToolCall(
      { id: "1", name: "save_note", arguments: { mode: "create", title: "Dogs", body_markdown: "body", summary: "Notes on dogs." } },
      deps,
    );

    const content = await vault.read("Inbox/Dogs.md");
    // All 12 schema keys must appear. Arrays must render as `[]` (not be omitted).
    for (const key of ["title:", "type:", "status:", "source:", "tags: []", "aliases: []", "entities: []", "related: []", "summary:", "cowork:"]) {
      expect(content).toContain(key);
    }
    // Nested cowork keys.
    for (const key of ["  source:", "  run_id:", "  model:", "  version:", "  confidence:"]) {
      expect(content).toContain(key);
    }
  });

  it("stamps cowork.model from deps.chatModel and a tool-call run_id", async () => {
    const vault = new MockVaultService();
    const deps = makeDeps({
      vault,
      chatModel: "gemma4:e4b",
      openNotePreview: vi.fn().mockResolvedValue(fullConfirm),
    });

    await dispatchToolCall(
      { id: "1", name: "save_note", arguments: { mode: "create", title: "Dogs", summary: "Notes." } },
      deps,
    );

    const content = await vault.read("Inbox/Dogs.md");
    expect(content).toContain('model: "gemma4:e4b"');
    expect(content).toMatch(/run_id: "tool-call-\d+"/);
  });
});

describe("appendUnderDatedSection", () => {
  it("adds today's heading when the note lacks one", () => {
    const updated = appendUnderDatedSection("Existing", "New entry", new Date("2026-05-14T12:00:00Z"));
    expect(updated).toBe("Existing\n\n## 2026-05-14\n\nNew entry");
  });

  it("does not duplicate today's heading", () => {
    const updated = appendUnderDatedSection("Existing\n\n## 2026-05-14\n\nFirst", "Second", new Date("2026-05-14T12:00:00Z"));
    expect(updated).toBe("Existing\n\n## 2026-05-14\n\nFirst\n\nSecond");
  });
});

describe("patchFrontmatter", () => {
  it("escapes regex metacharacters in frontmatter keys", () => {
    const updated = patchFrontmatter("---\nfoo.bar: old\nfooXbar: keep\n---\nBody", { "foo.bar": "new" });
    expect(updated).toContain('foo.bar: "new"');
    expect(updated).toContain("fooXbar: keep");
  });

  it("returns null for unclosed frontmatter", () => {
    expect(patchFrontmatter("---\ntitle: Broken\nBody", { title: "New" })).toBeNull();
  });
});

describe("dispatchToolCall — collision handling", () => {
  it("suffixes (2) when the base path already exists", async () => {
    const vault = new MockVaultService({ "Inbox/Dogs.md": "existing" });
    const deps = makeDeps({ vault, openNotePreview: vi.fn().mockResolvedValue(fullConfirm) });

    const result = await dispatchToolCall(
      { id: "5", name: "save_note", arguments: { mode: "create", title: "Dogs", body_markdown: "", summary: "Notes on dogs." } },
      deps,
    );

    expect(result.kind).toBe("done");
    expect(await vault.exists("Inbox/Dogs (2).md")).toBe(true);
    expect(await vault.exists("Inbox/Dogs.md")).toBe(true); // original untouched
  });
});

describe("dispatchToolCall — read tools", () => {
  it("marks get_note summaries when content is truncated", async () => {
    const vault = new MockVaultService({ "Long.md": "x".repeat(2001) });
    const result = await dispatchToolCall(
      { id: "6", name: "get_note", arguments: { path: "Long.md" } },
      makeDeps({ vault }),
    );

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.summary).toContain("Read **Long.md**");
    expect(result.summary).toContain("[...truncated at 2000 chars; full note is 2001 chars]");
    expect(result.citations).toEqual(["Long.md"]);
  });

  it("uses tokenized basename and note content for find_related_notes", async () => {
    const vault = new MockVaultService({ "notes/vandringsnoter_sundsvall_harnosand.md": "Bridge route and ferry notes" });
    const search = vi.fn().mockResolvedValue([
      { path: "notes/related.md", basename: "related", snippet: "route", score: 1 },
    ]);
    const result = await dispatchToolCall(
      { id: "7", name: "find_related_notes", arguments: { path: "notes/vandringsnoter_sundsvall_harnosand.md" } },
      makeDeps({ vault, index: { search } }),
    );

    expect(result.kind).toBe("done");
    expect(search).toHaveBeenCalledWith(expect.stringContaining("vandringsnoter sundsvall harnosand"), { topK: 5 });
    expect(search).toHaveBeenCalledWith(expect.stringContaining("Bridge route"), { topK: 5 });
  });
});
