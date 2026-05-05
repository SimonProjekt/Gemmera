/**
 * Forward + reverse map of intra-vault links, kept in sync with the
 * IngestionStore by subscribing to the same runner events EmbeddingService
 * uses. Powers the link-graph boost in the HybridRetriever (#8).
 *
 * Resolution rules (Obsidian-flavored):
 *  - `[[Target]]`            → resolved against vault paths (basename or
 *                              full path, case-insensitive). Unresolved
 *                              targets are still recorded as outgoing
 *                              links with `resolved=false`.
 *  - `[[Target|Alias]]`      → target is the part before `|`.
 *  - `[[Target#Heading]]`    → target is the part before `#`.
 *  - `[[Target^block]]`      → target is the part before `^`.
 *  - `[text](relative.md)`   → markdown links to local `.md` paths only.
 *  - URLs (`http://...`)     → ignored.
 *  - Code-fenced and inline-coded text is skipped (no false matches in
 *    code samples).
 */

export interface NoteLink {
  /** Raw target as it appears in the source (e.g. "Folder/Note", "Note#H"). */
  raw: string;
  /** Vault path the link resolves to, or null when unresolved. */
  target: string | null;
  /** True when `target` is a known vault path. */
  resolved: boolean;
}

export interface LinksIndex {
  /** Outgoing links from `path`. Empty array if path is unknown. */
  outgoing(path: string): readonly NoteLink[];
  /** Vault paths that link *to* `path`. Only resolved links are counted. */
  backlinks(path: string): string[];
  /** Convenience: count of resolved 1-hop neighbors (in + out, deduped). */
  neighborCount(path: string): number;
  /** Total notes tracked. Test/telemetry affordance. */
  size(): number;
}

/** Raw link as parsed out of a note body, before resolution. */
export interface RawLink {
  raw: string;
}

export interface MutableLinksIndex extends LinksIndex {
  /**
   * Replace outgoing links for `path`. The index resolves each `raw` against
   * its current view of the vault and updates backlinks accordingly. Calling
   * `upsert` on a path that isn't yet tracked also registers the path itself,
   * so basename resolution can find it.
   */
  upsert(path: string, links: RawLink[]): void;
  /** Drop a note entirely; removes outgoing edges and any backlinks pointing to it. */
  remove(path: string): void;
  /** Move a note's edges from `from` to `to`. Resolved targets are re-pointed. */
  rename(from: string, to: string): void;
}
