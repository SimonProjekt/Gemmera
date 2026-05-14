import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  SearchHit,
  VectorStore,
  VectorStoreMetadata,
} from "../contracts";

interface ManifestRow {
  contentHash: string;
  slot: number;
}

interface Manifest {
  version: 1;
  model: string;
  dim: number;
  rows: ManifestRow[];
  /** Slot indexes freed by delete() and available for reuse. */
  freeList: number[];
}

const FLOAT_BYTES = 4;

/**
 * Two-file vector store: `<base>.bin` holds Float32 vectors at fixed
 * `dim*4` strides; `<base>.json` carries the manifest (model, dim,
 * contentHash → slot map, free list). Manifest writes are tmp+rename
 * for crash safety; bin writes append-or-overwrite at a known offset.
 *
 * Crash semantics:
 *  - mid-bin-write, pre-manifest: the new slot is unreferenced; on
 *    next load it shows up as wasted space. compact() reclaims.
 *  - mid-manifest-write: the .tmp is discarded; old manifest still
 *    valid. The bin's last slot may also be unreferenced — same as
 *    above.
 */
export class BinaryVectorStore implements VectorStore {
  private cache: { manifest: Manifest; vectors: Float32Array[] } | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly binPath: string,
    private readonly jsonPath: string,
    private readonly model: string,
    private readonly dim: number,
  ) {}

  metadata(): VectorStoreMetadata {
    return { model: this.model, dim: this.dim };
  }

  async has(contentHash: string): Promise<boolean> {
    const { manifest } = await this.load();
    return manifest.rows.some((r) => r.contentHash === contentHash);
  }

  async upsert(contentHash: string, vec: Float32Array): Promise<void> {
    if (vec.length !== this.dim) {
      throw new Error(`vector dim mismatch: got ${vec.length}, expected ${this.dim}`);
    }
    return this.run(async () => {
      const state = await this.load();
      const existing = state.manifest.rows.find((r) => r.contentHash === contentHash);
      const slot = existing
        ? existing.slot
        : state.manifest.freeList.pop() ?? state.vectors.length;

      // Make sure the in-memory vector array can hold this slot.
      while (state.vectors.length <= slot) {
        state.vectors.push(new Float32Array(this.dim));
      }
      state.vectors[slot] = new Float32Array(vec); // copy: callers may reuse buffers

      if (!existing) state.manifest.rows.push({ contentHash, slot });

      await this.flush(state.manifest, state.vectors);
    });
  }

  async delete(contentHash: string): Promise<void> {
    return this.run(async () => {
      const state = await this.load();
      const idx = state.manifest.rows.findIndex((r) => r.contentHash === contentHash);
      if (idx === -1) return;
      const slot = state.manifest.rows[idx].slot;
      state.manifest.rows.splice(idx, 1);
      state.manifest.freeList.push(slot);
      // Do not shrink vectors array; the slot is parked on the free list and
      // will be reused on the next upsert.
      await this.flush(state.manifest, state.vectors);
    });
  }

  async search(queryVec: Float32Array, topK: number): Promise<SearchHit[]> {
    if (queryVec.length !== this.dim) {
      throw new Error(`query dim mismatch: got ${queryVec.length}, expected ${this.dim}`);
    }
    if (topK <= 0) return [];
    const { manifest, vectors } = await this.load();
    if (manifest.rows.length === 0) return [];

    const scored: SearchHit[] = manifest.rows.map((row) => ({
      contentHash: row.contentHash,
      score: dot(queryVec, vectors[row.slot]),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async count(): Promise<number> {
    const { manifest } = await this.load();
    return manifest.rows.length;
  }

  async reset(): Promise<void> {
    return this.run(async () => {
      this.cache = {
        manifest: { version: 1, model: this.model, dim: this.dim, rows: [], freeList: [] },
        vectors: [],
      };
      await this.flush(this.cache.manifest, this.cache.vectors);
    });
  }

  // --- internals ---

  private async load(): Promise<{ manifest: Manifest; vectors: Float32Array[] }> {
    if (this.cache) return this.cache;

    let manifest: Manifest;
    try {
      const raw = await readFile(this.jsonPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<Manifest>;
      if (parsed.model !== this.model || parsed.dim !== this.dim) {
        // Model or dim changed; on-disk vectors are incomparable. Reset.
        manifest = freshManifest(this.model, this.dim);
        this.cache = { manifest, vectors: [] };
        await this.writeNow(manifest, []);
        return this.cache;
      }
      manifest = {
        version: 1,
        model: parsed.model,
        dim: parsed.dim,
        rows: parsed.rows ?? [],
        freeList: parsed.freeList ?? [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      manifest = freshManifest(this.model, this.dim);
    }

    const vectors = await this.loadVectors(manifest);
    this.cache = { manifest, vectors };
    return this.cache;
  }

  private async loadVectors(manifest: Manifest): Promise<Float32Array[]> {
    if (manifest.rows.length === 0) return [];
    let buffer: Buffer;
    try {
      buffer = await readFile(this.binPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const stride = this.dim * FLOAT_BYTES;
    const maxSlot = Math.max(...manifest.rows.map((r) => r.slot), -1);
    const vectors: Float32Array[] = new Array(maxSlot + 1);
    for (const row of manifest.rows) {
      const start = row.slot * stride;
      // Float32Array view over the slice; copy so we don't pin the whole buffer.
      const view = new Float32Array(buffer.buffer, buffer.byteOffset + start, this.dim);
      vectors[row.slot] = new Float32Array(view);
    }
    // Fill any free-list gaps with zero vectors so indexing is safe.
    for (let i = 0; i <= maxSlot; i++) {
      if (!vectors[i]) vectors[i] = new Float32Array(this.dim);
    }
    return vectors;
  }

  /** Serialize writes so back-to-back upserts don't race on tmp+rename. */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(op);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async flush(manifest: Manifest, vectors: Float32Array[]): Promise<void> {
    await this.writeNow(manifest, vectors);
  }

  private async writeNow(manifest: Manifest, vectors: Float32Array[]): Promise<void> {
    await mkdir(dirname(this.binPath), { recursive: true });

    // Bin file: write enough capacity for every slot referenced. Free-list
    // slots get zero-filled; we never persist garbage.
    const stride = this.dim * FLOAT_BYTES;
    const maxSlot = manifest.rows.reduce((m, r) => Math.max(m, r.slot), -1);
    const capacity = Math.max(maxSlot + 1, vectors.length);
    const out = Buffer.alloc(capacity * stride);
    for (let i = 0; i < capacity; i++) {
      const v = vectors[i] ?? new Float32Array(this.dim);
      const view = new Float32Array(out.buffer, out.byteOffset + i * stride, this.dim);
      view.set(v);
    }
    const binTmp = `${this.binPath}.tmp`;
    await writeFile(binTmp, out);
    await rename(binTmp, this.binPath);

    const jsonTmp = `${this.jsonPath}.tmp`;
    await writeFile(jsonTmp, JSON.stringify(manifest), "utf8");
    await rename(jsonTmp, this.jsonPath);
  }

  // Test-only escape hatch so the on-disk file size can be verified.
  async _binSize(): Promise<number> {
    try {
      const s = await stat(this.binPath);
      return s.size;
    } catch {
      return 0;
    }
  }
}

function freshManifest(model: string, dim: number): Manifest {
  return { version: 1, model, dim, rows: [], freeList: [] };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
