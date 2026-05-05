import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Chunk, IngestionStore, NoteState } from "../contracts";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { JsonIngestionStore } from "./json-ingestion-store";

const state = (path: string): NoteState => ({
  path,
  contentHash: "c-fixed",
  bodyHash: "b-fixed",
  mtime: 42,
  frontmatter: "tags: [t]",
});

const chunks = (path: string): Chunk[] => [
  {
    path,
    ord: 0,
    headingPath: ["t"],
    text: "first",
    textForEmbed: "t\n\nfirst",
    tokenCount: 1,
    contentHash: "h0",
  },
  {
    path,
    ord: 1,
    headingPath: ["t", "sub"],
    text: "second",
    textForEmbed: "t > sub\n\nsecond",
    tokenCount: 1,
    contentHash: "h1",
  },
];

describe.each<[string, () => Promise<{ store: IngestionStore; cleanup: () => Promise<void> }>]>([
  [
    "InMemoryIngestionStore",
    async () => ({ store: new InMemoryIngestionStore(), cleanup: async () => undefined }),
  ],
  [
    "JsonIngestionStore",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "gemmera-rename-"));
      const store = new JsonIngestionStore(join(dir, "state.json"));
      return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  ],
])("%s.rename", (_name, factory) => {
  let store: IngestionStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ store, cleanup } = await factory());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("re-keys state and chunks without touching content hashes", async () => {
    await store.upsert(state("a.md"), chunks("a.md"));
    await store.rename("a.md", "moved/b.md");

    const moved = await store.get("moved/b.md");
    expect(moved).toMatchObject({
      path: "moved/b.md",
      contentHash: "c-fixed",
      bodyHash: "b-fixed",
      frontmatter: "tags: [t]",
    });
    const movedChunks = await store.getChunks("moved/b.md");
    expect(movedChunks).toHaveLength(2);
    expect(movedChunks.map((c) => c.path)).toEqual(["moved/b.md", "moved/b.md"]);
    // chunk content/hash invariant: rename must not re-embed.
    expect(movedChunks.map((c) => c.contentHash)).toEqual(["h0", "h1"]);
  });

  it("removes the old key after rename", async () => {
    await store.upsert(state("a.md"), chunks("a.md"));
    await store.rename("a.md", "b.md");
    expect(await store.get("a.md")).toBeNull();
    expect(await store.getChunks("a.md")).toEqual([]);
  });

  it("is a no-op when the source path is unknown", async () => {
    await store.rename("ghost.md", "elsewhere.md");
    expect(await store.get("elsewhere.md")).toBeNull();
  });
});
