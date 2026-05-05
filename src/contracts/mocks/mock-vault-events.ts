import type { VaultEventSource } from "../vault-events";

type CreateCb = (path: string) => void;
type ModifyCb = (path: string) => void;
type DeleteCb = (path: string) => void;
type RenameCb = (oldPath: string, newPath: string) => void;
type MetaCb = (path: string) => void;

export class MockVaultEventSource implements VaultEventSource {
  private creates = new Set<CreateCb>();
  private modifies = new Set<ModifyCb>();
  private deletes = new Set<DeleteCb>();
  private renames = new Set<RenameCb>();
  private metas = new Set<MetaCb>();

  onCreate(cb: CreateCb): () => void {
    this.creates.add(cb);
    return () => this.creates.delete(cb);
  }
  onModify(cb: ModifyCb): () => void {
    this.modifies.add(cb);
    return () => this.modifies.delete(cb);
  }
  onDelete(cb: DeleteCb): () => void {
    this.deletes.add(cb);
    return () => this.deletes.delete(cb);
  }
  onRename(cb: RenameCb): () => void {
    this.renames.add(cb);
    return () => this.renames.delete(cb);
  }
  onMetadataChange(cb: MetaCb): () => void {
    this.metas.add(cb);
    return () => this.metas.delete(cb);
  }

  emitCreate(path: string): void {
    for (const cb of this.creates) cb(path);
  }
  emitModify(path: string): void {
    for (const cb of this.modifies) cb(path);
  }
  emitDelete(path: string): void {
    for (const cb of this.deletes) cb(path);
  }
  emitRename(oldPath: string, newPath: string): void {
    for (const cb of this.renames) cb(oldPath, newPath);
  }
  emitMetadataChange(path: string): void {
    for (const cb of this.metas) cb(path);
  }

  listenerCount(): number {
    return (
      this.creates.size +
      this.modifies.size +
      this.deletes.size +
      this.renames.size +
      this.metas.size
    );
  }
}
