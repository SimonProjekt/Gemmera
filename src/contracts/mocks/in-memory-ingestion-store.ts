import type { Chunk } from "../chunker";
import type { IngestionMeta, IngestionStore, NoteState } from "../ingestion";

export class InMemoryIngestionStore implements IngestionStore {
  private notes = new Map<string, NoteState>();
  private chunks = new Map<string, Chunk[]>();
  private meta: Partial<IngestionMeta> = {};

  async get(path: string): Promise<NoteState | null> {
    return this.notes.get(path) ?? null;
  }

  async getChunks(path: string): Promise<Chunk[]> {
    return this.chunks.get(path) ?? [];
  }

  async upsert(state: NoteState, chunks: Chunk[]): Promise<void> {
    this.notes.set(state.path, state);
    this.chunks.set(state.path, chunks);
  }

  async upsertMetadata(state: NoteState): Promise<void> {
    this.notes.set(state.path, state);
  }

  async delete(path: string): Promise<void> {
    this.notes.delete(path);
    this.chunks.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const state = this.notes.get(from);
    if (!state) return;
    const chunks = this.chunks.get(from) ?? [];
    this.notes.set(to, { ...state, path: to });
    this.chunks.set(to, chunks.map((c) => ({ ...c, path: to })));
    this.notes.delete(from);
    this.chunks.delete(from);
  }

  async list(): Promise<string[]> {
    return [...this.notes.keys()];
  }

  async isHashReferenced(contentHash: string): Promise<boolean> {
    for (const chunks of this.chunks.values()) {
      for (const c of chunks) {
        if (c.contentHash === contentHash) return true;
      }
    }
    return false;
  }

  async getMeta<K extends keyof IngestionMeta>(key: K): Promise<IngestionMeta[K] | null> {
    const value = this.meta[key];
    return value === undefined ? null : (value as IngestionMeta[K]);
  }

  async setMeta<K extends keyof IngestionMeta>(key: K, value: IngestionMeta[K]): Promise<void> {
    this.meta[key] = value;
  }

  async getChunksByHash(contentHash: string): Promise<Chunk[]> {
    const out: Chunk[] = [];
    for (const chunks of this.chunks.values()) {
      for (const c of chunks) {
        if (c.contentHash === contentHash) out.push(c);
      }
    }
    return out;
  }

  async findByBodyHash(hash: string): Promise<string[]> {
    const out: string[] = [];
    for (const state of this.notes.values()) {
      if (state.bodyHash === hash) out.push(state.path);
    }
    return out;
  }
}
