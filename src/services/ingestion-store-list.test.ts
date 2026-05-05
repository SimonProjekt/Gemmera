import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IngestionStore, NoteState } from "../contracts";
import { InMemoryIngestionStore } from "../contracts/mocks/in-memory-ingestion-store";
import { JsonIngestionStore } from "./json-ingestion-store";

const state = (path: string): NoteState => ({
  path,
  contentHash: "c",
  bodyHash: "b",
  mtime: 0,
  frontmatter: null,
});

describe.each<[string, () => Promise<{ store: IngestionStore; cleanup: () => Promise<void> }>]>([
  [
    "InMemoryIngestionStore",
    async () => ({ store: new InMemoryIngestionStore(), cleanup: async () => undefined }),
  ],
  [
    "JsonIngestionStore",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "gemmera-list-"));
      const store = new JsonIngestionStore(join(dir, "state.json"));
      return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  ],
])("%s.list", (_name, factory) => {
  let store: IngestionStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ store, cleanup } = await factory());
  });

  afterEach(async () => {
    await cleanup();
  });

  it("returns an empty array for a fresh store", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("returns every known path", async () => {
    await store.upsert(state("a.md"), []);
    await store.upsert(state("nested/b.md"), []);
    expect((await store.list()).sort()).toEqual(["a.md", "nested/b.md"]);
  });

  it("drops entries after delete", async () => {
    await store.upsert(state("a.md"), []);
    await store.upsert(state("b.md"), []);
    await store.delete("a.md");
    expect(await store.list()).toEqual(["b.md"]);
  });

  it("reflects rename in the listing", async () => {
    await store.upsert(state("a.md"), []);
    await store.rename("a.md", "moved/b.md");
    expect(await store.list()).toEqual(["moved/b.md"]);
  });
});
