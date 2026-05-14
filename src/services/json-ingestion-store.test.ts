import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Chunk, NoteState } from "../contracts";
import { JsonIngestionStore } from "./json-ingestion-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemmera-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const state = (path: string, contentHash: string, bodyHash: string): NoteState => ({
  path,
  contentHash,
  bodyHash,
  mtime: 1,
  frontmatter: null,
});

const chunk = (path: string, ord: number): Chunk => ({
  path,
  ord,
  headingPath: ["t"],
  text: `c${ord}`,
  textForEmbed: `t\n\nc${ord}`,
  tokenCount: 1,
  contentHash: `h${ord}`,
});

describe("JsonIngestionStore", () => {
  it("returns null for missing notes and creates the file lazily on write", async () => {
    const file = join(dir, "nested", "state.json");
    const store = new JsonIngestionStore(file);
    expect(await store.get("a.md")).toBeNull();

    await store.upsert(state("a.md", "c", "b"), [chunk("a.md", 0)]);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted.notes["a.md"].contentHash).toBe("c");
    expect(persisted.chunks["a.md"]).toHaveLength(1);
  });

  it("round-trips through a fresh store instance", async () => {
    const file = join(dir, "state.json");
    const a = new JsonIngestionStore(file);
    await a.upsert(state("a.md", "c", "b"), [chunk("a.md", 0), chunk("a.md", 1)]);

    const b = new JsonIngestionStore(file);
    expect(await b.get("a.md")).toMatchObject({ contentHash: "c", bodyHash: "b" });
    expect(await b.getChunks("a.md")).toHaveLength(2);
  });

  it("upsertMetadata leaves chunks untouched", async () => {
    const file = join(dir, "state.json");
    const store = new JsonIngestionStore(file);
    await store.upsert(state("a.md", "c1", "b1"), [chunk("a.md", 0)]);
    await store.upsertMetadata({ ...state("a.md", "c2", "b1"), frontmatter: "tags: [y]" });
    expect(await store.getChunks("a.md")).toHaveLength(1);
    expect((await store.get("a.md"))?.frontmatter).toBe("tags: [y]");
  });

  it("does not leave a tmp file behind after a successful write", async () => {
    const file = join(dir, "state.json");
    const store = new JsonIngestionStore(file);
    await store.upsert(state("a.md", "c", "b"), [chunk("a.md", 0)]);
    const entries = await readdir(dir);
    expect(entries).toContain("state.json");
    expect(entries).not.toContain("state.json.tmp");
  });
});
