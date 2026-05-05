/**
 * Minimal event surface the indexer needs from the host vault. Lets us test
 * the bridge wiring without an Obsidian runtime — see MockVaultEventSource
 * under contracts/mocks/.
 *
 * Each `on*` returns an unsubscribe function, matching Obsidian's EventRef
 * lifecycle in spirit.
 */
export interface VaultEventSource {
  onCreate(cb: (path: string) => void): () => void;
  onModify(cb: (path: string) => void): () => void;
  onDelete(cb: (path: string) => void): () => void;
  onRename(cb: (oldPath: string, newPath: string) => void): () => void;
  onMetadataChange(cb: (path: string) => void): () => void;
}
