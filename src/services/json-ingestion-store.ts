import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Chunk, IngestionStore, NoteState } from "../contracts";

interface StoreShape {
  version: 1;
  notes: Record<string, NoteState>;
  chunks: Record<string, Chunk[]>;
}

const EMPTY: StoreShape = { version: 1, notes: {}, chunks: {} };

/**
 * JSON-backed ingestion store. Single file, full-rewrite on each upsert via
 * tmp+rename so a crash mid-write leaves either the prior or new state — never
 * a torn file. Replace with DuckDB once the index DB lands; same contract.
 */
export class JsonIngestionStore implements IngestionStore {
  private cache: StoreShape | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(path: string): Promise<NoteState | null> {
    const data = await this.load();
    return data.notes[path] ?? null;
  }

  async getChunks(path: string): Promise<Chunk[]> {
    const data = await this.load();
    return data.chunks[path] ?? [];
  }

  async upsert(state: NoteState, chunks: Chunk[]): Promise<void> {
    const data = await this.load();
    data.notes[state.path] = state;
    data.chunks[state.path] = chunks;
    await this.flush(data);
  }

  async upsertMetadata(state: NoteState): Promise<void> {
    const data = await this.load();
    data.notes[state.path] = state;
    await this.flush(data);
  }

  async delete(path: string): Promise<void> {
    const data = await this.load();
    delete data.notes[path];
    delete data.chunks[path];
    await this.flush(data);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = await this.load();
    const state = data.notes[from];
    if (!state) return;
    const chunks = data.chunks[from] ?? [];
    data.notes[to] = { ...state, path: to };
    data.chunks[to] = chunks.map((c) => ({ ...c, path: to }));
    delete data.notes[from];
    delete data.chunks[from];
    await this.flush(data);
  }

  async list(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data.notes);
  }

  async isHashReferenced(contentHash: string): Promise<boolean> {
    const data = await this.load();
    for (const chunks of Object.values(data.chunks)) {
      for (const c of chunks) {
        if (c.contentHash === contentHash) return true;
      }
    }
    return false;
  }

  private async load(): Promise<StoreShape> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      this.cache = {
        version: 1,
        notes: parsed.notes ?? {},
        chunks: parsed.chunks ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.cache = { ...EMPTY, notes: {}, chunks: {} };
    }
    return this.cache;
  }

  /** Serialize writes so concurrent upserts don't race on tmp+rename. */
  private flush(data: StoreShape): Promise<void> {
    const next = this.writeChain.then(() => this.writeNow(data));
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async writeNow(data: StoreShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(data), "utf8");
    await rename(tmp, this.filePath);
  }
}
