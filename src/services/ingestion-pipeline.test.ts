import { describe, expect, it } from "vitest";
import { MockVaultService } from "../contracts/mocks/mock-vault";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { MarkdownChunker } from "./markdown-chunker";
import { HashGatedIngestionPipeline } from "./ingestion-pipeline";

function setup(files: Record<string, string>, epoch = () => 0) {
  const vault = new MockVaultService(files);
  const store = new InMemoryIngestionStore();
  const pipeline = new HashGatedIngestionPipeline(
    vault,
    new MarkdownChunker(),
    store,
    epoch,
  );
  return { vault, store, pipeline };
}

const body = (...rows: string[]) => rows.join("\n");

describe("HashGatedIngestionPipeline", () => {
  it("rechunks a new note and persists state with chunks", async () => {
    const { pipeline, store } = setup({
      "Notes/a.md": body("# Title", "", "Some content."),
    });

    const decision = await pipeline.ingest("Notes/a.md");

    expect(decision.kind).toBe("rechunk");
    if (decision.kind !== "rechunk") return;
    expect(decision.chunks.length).toBeGreaterThan(0);

    const persisted = await store.get("Notes/a.md");
    expect(persisted?.contentHash).toBe(decision.state.contentHash);
    expect(await store.getChunks("Notes/a.md")).toEqual(decision.chunks);
  });

  it("skips a re-ingest when content is unchanged", async () => {
    const { pipeline, store } = setup({
      "Notes/a.md": body("# Title", "", "Some content."),
    });

    await pipeline.ingest("Notes/a.md");
    const chunksBefore = await store.getChunks("Notes/a.md");

    const decision = await pipeline.ingest("Notes/a.md");
    expect(decision.kind).toBe("skip");
    expect(await store.getChunks("Notes/a.md")).toEqual(chunksBefore);
  });

  it("treats frontmatter-only edits as metadata-only and does not change chunks", async () => {
    const { vault, pipeline, store } = setup({
      "Notes/a.md": body("---", "tags: [x]", "---", "# Title", "", "Body text."),
    });

    const first = await pipeline.ingest("Notes/a.md");
    expect(first.kind).toBe("rechunk");
    if (first.kind !== "rechunk") return;
    const chunksBefore = first.chunks;

    // Mutate only the frontmatter.
    vault.setFile(
      "Notes/a.md",
      body("---", "tags: [y]", "---", "# Title", "", "Body text."),
    );

    const second = await pipeline.ingest("Notes/a.md");
    expect(second.kind).toBe("metadata-only");

    const persisted = await store.get("Notes/a.md");
    expect(persisted?.frontmatter).toContain("tags: [y]");
    // Chunks must not have been rewritten.
    expect(await store.getChunks("Notes/a.md")).toEqual(chunksBefore);
  });

  it("re-chunks when body changes even if frontmatter is identical", async () => {
    const { vault, pipeline } = setup({
      "Notes/a.md": body("---", "tags: [x]", "---", "# Title", "", "Body one."),
    });

    const first = await pipeline.ingest("Notes/a.md");
    expect(first.kind).toBe("rechunk");

    vault.setFile(
      "Notes/a.md",
      body("---", "tags: [x]", "---", "# Title", "", "Body two."),
    );

    const second = await pipeline.ingest("Notes/a.md");
    expect(second.kind).toBe("rechunk");
    if (first.kind !== "rechunk" || second.kind !== "rechunk") return;
    expect(second.state.bodyHash).not.toBe(first.state.bodyHash);
    // Prior chunks captured before upsert overwrites — embedder uses these
    // to evict orphaned vectors.
    expect(second.priorChunks).toEqual(first.chunks);
  });

  it("reports an empty priorChunks list on first ingest", async () => {
    const { pipeline } = setup({ "Notes/a.md": body("# Title", "", "Body.") });
    const decision = await pipeline.ingest("Notes/a.md");
    expect(decision.kind).toBe("rechunk");
    if (decision.kind !== "rechunk") return;
    expect(decision.priorChunks).toEqual([]);
  });

  it("persists provided mtime", async () => {
    const { pipeline, store } = setup({ "Notes/a.md": "hello" });
    await pipeline.ingest("Notes/a.md", { mtime: 1234567890 });
    const persisted = await store.get("Notes/a.md");
    expect(persisted?.mtime).toBe(1234567890);
  });

  it("re-processes a hash-clean note when its lastEpoch is below currentEpoch (rebuild)", async () => {
    let epoch = 0;
    const { pipeline, store } = setup(
      { "Notes/a.md": "hello world" },
      () => epoch,
    );

    const first = await pipeline.ingest("Notes/a.md");
    expect(first.kind).toBe("rechunk");
    expect((await store.get("Notes/a.md"))?.lastEpoch).toBe(0);

    // Same content, same epoch → skip.
    const stable = await pipeline.ingest("Notes/a.md");
    expect(stable.kind).toBe("skip");

    // Bump epoch (simulate rebuild). The hash gate must release.
    epoch = 100;
    const rebuilt = await pipeline.ingest("Notes/a.md");
    expect(rebuilt.kind).not.toBe("skip");
    expect((await store.get("Notes/a.md"))?.lastEpoch).toBe(100);
  });
});
