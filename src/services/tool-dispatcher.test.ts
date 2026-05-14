import { describe, expect, it, vi } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { dispatchToolCall, buildFrontmatter, appendUnderDatedSection, patchFrontmatter, type ToolDispatchDeps } from "./tool-dispatcher";
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

describe("dispatchToolCall — routing", () => {
  it("routes save_note with mode=create to save handler", async () => {
    const confirmResult = { confirmed: true as const, title: "Dogs", folder: "Inbox/", tags: [] };
    const deps = makeDeps({ openNotePreview: vi.fn().mockResolvedValue(confirmResult) });

    const result = await dispatchToolCall(
      { id: "1", name: "save_note", arguments: { mode: "create", title: "Dogs", body_markdown: "Dogs are great." } },
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
    const confirmResult = { confirmed: true as const, title: "Dogs", folder: "Inbox/", tags: [] };
    const deps = makeDeps({ vault, openNotePreview: vi.fn().mockResolvedValue(confirmResult) });

    const result = await dispatchToolCall(
      { id: "5", name: "save_note", arguments: { mode: "create", title: "Dogs", body_markdown: "" } },
      deps,
    );

    expect(result.kind).toBe("done");
    expect(await vault.exists("Inbox/Dogs (2).md")).toBe(true);
    expect(await vault.exists("Inbox/Dogs.md")).toBe(true); // original untouched
  });
});

describe("buildFrontmatter", () => {
  it("wraps title in double-quotes (valid YAML)", () => {
    const fm = buildFrontmatter("Hello world", []);
    expect(fm).toContain('title: "Hello world"');
  });

  it("escapes quotes inside title", () => {
    const fm = buildFrontmatter('Title with "quotes"', []);
    expect(fm).toContain('title: "Title with \\"quotes\\""');
  });

  it("omits tags line when tags array is empty", () => {
    const fm = buildFrontmatter("My note", []);
    expect(fm).not.toContain("tags:");
  });

  it("includes quoted tags when provided", () => {
    const fm = buildFrontmatter("My note", ["rust", "cli"]);
    expect(fm).toContain('tags: ["rust", "cli"]');
  });
});
