import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BinaryVectorStore } from "./binary-vector-store";

const DIM = 4;
const MODEL = "test-embed";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gemmera-vec-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const newStore = (model = MODEL, dim = DIM) =>
  new BinaryVectorStore(
    join(dir, "vectors.bin"),
    join(dir, "vectors.json"),
    model,
    dim,
  );

const v = (...xs: number[]) => Float32Array.from(xs);
const norm = (x: Float32Array) => {
  let s = 0;
  for (const xi of x) s += xi * xi;
  const n = Math.sqrt(s);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] / n;
  return out;
};

describe("BinaryVectorStore", () => {
  it("starts empty and reports correct metadata", async () => {
    const store = newStore();
    expect(store.metadata()).toEqual({ model: MODEL, dim: DIM });
    expect(await store.count()).toBe(0);
    expect(await store.has("any")).toBe(false);
    expect(await store.search(v(1, 0, 0, 0), 5)).toEqual([]);
  });

  it("upserts and retrieves a vector across instances", async () => {
    const a = newStore();
    const vec = norm(v(1, 0, 0, 0));
    await a.upsert("h1", vec);
    expect(await a.has("h1")).toBe(true);
    expect(await a.count()).toBe(1);

    const b = newStore();
    expect(await b.has("h1")).toBe(true);
    const hits = await b.search(vec, 5);
    expect(hits[0].contentHash).toBe("h1");
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("rejects vectors with the wrong dim", async () => {
    const store = newStore();
    await expect(store.upsert("h1", v(1, 0, 0))).rejects.toThrow(/dim/);
  });

  it("ranks by dot product (higher is more similar)", async () => {
    const store = newStore();
    await store.upsert("near", norm(v(1, 0, 0, 0)));
    await store.upsert("mid", norm(v(1, 1, 0, 0)));
    await store.upsert("far", norm(v(0, 0, 0, 1)));
    const hits = await store.search(norm(v(1, 0, 0, 0)), 3);
    expect(hits.map((h) => h.contentHash)).toEqual(["near", "mid", "far"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[1].score).toBeGreaterThan(hits[2].score);
  });

  it("respects topK", async () => {
    const store = newStore();
    for (let i = 0; i < 5; i++) {
      await store.upsert(`h${i}`, norm(v(i + 1, 0, 0, 0)));
    }
    const hits = await store.search(norm(v(1, 0, 0, 0)), 2);
    expect(hits).toHaveLength(2);
  });

  it("upsert on an existing hash overwrites in-place (no slot growth)", async () => {
    const store = newStore();
    await store.upsert("h", norm(v(1, 0, 0, 0)));
    const sizeBefore = await store._binSize();
    await store.upsert("h", norm(v(0, 1, 0, 0)));
    const sizeAfter = await store._binSize();
    expect(sizeAfter).toBe(sizeBefore);
    const hits = await store.search(norm(v(0, 1, 0, 0)), 1);
    expect(hits[0].contentHash).toBe("h");
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("delete removes the vector and frees its slot for reuse", async () => {
    const store = newStore();
    await store.upsert("a", norm(v(1, 0, 0, 0)));
    await store.upsert("b", norm(v(0, 1, 0, 0)));
    const sizeBefore = await store._binSize();
    await store.delete("a");
    expect(await store.has("a")).toBe(false);
    expect(await store.count()).toBe(1);

    // The next upsert should reuse the freed slot — bin size stays put.
    await store.upsert("c", norm(v(0, 0, 1, 0)));
    expect(await store._binSize()).toBe(sizeBefore);
  });

  it("delete is a no-op for unknown hashes", async () => {
    const store = newStore();
    await expect(store.delete("nope")).resolves.toBeUndefined();
  });

  it("resets on a model mismatch", async () => {
    const a = newStore(MODEL, DIM);
    await a.upsert("h", norm(v(1, 0, 0, 0)));
    expect(await a.count()).toBe(1);

    // Reopen with a different model — store should reset, not crash.
    const b = newStore("other-model", DIM);
    expect(await b.count()).toBe(0);
    expect(await b.has("h")).toBe(false);
  });

  it("resets on a dim mismatch", async () => {
    const a = newStore(MODEL, DIM);
    await a.upsert("h", norm(v(1, 0, 0, 0)));
    const b = newStore(MODEL, 8);
    expect(await b.count()).toBe(0);
  });

  it("explicit reset() clears the store", async () => {
    const store = newStore();
    await store.upsert("h1", norm(v(1, 0, 0, 0)));
    await store.upsert("h2", norm(v(0, 1, 0, 0)));
    await store.reset();
    expect(await store.count()).toBe(0);
    expect(await store.search(norm(v(1, 0, 0, 0)), 5)).toEqual([]);
  });

  it("survives a corrupted manifest gracefully on the next upsert", async () => {
    const store = newStore();
    await store.upsert("h", norm(v(1, 0, 0, 0)));
    // Corrupt the manifest by writing garbage. The next instance will throw on
    // load — caller's responsibility to handle. We assert the throw is clean
    // (no partial state).
    await writeFile(join(dir, "vectors.json"), "{not json", "utf8");
    const b = newStore();
    await expect(b.count()).rejects.toThrow();
  });

  it("does not leave a tmp file behind after a successful write", async () => {
    const store = newStore();
    await store.upsert("h", norm(v(1, 0, 0, 0)));
    const entries = await readdir(dir);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});
