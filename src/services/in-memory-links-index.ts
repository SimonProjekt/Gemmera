import type { MutableLinksIndex, NoteLink, RawLink } from "../contracts/links-index";

/**
 * Pure in-memory LinksIndex.
 *
 * Five maps:
 *   notes:               Set<path>                       — every upserted path, even if it has no links
 *   forward:             path → NoteLink[]               — outgoing edges, including unresolved
 *   reverse:             path → Set<sourcePath>          — resolved backlinks (no self-loops)
 *   byBasename:          basenameLower → Set<path>       — for resolving bare `[[Target]]` references
 *   unresolvedByTarget:  rawLower → Set<sourcePath>      — pending promotion when target arrives
 *
 * The store is the source of truth for resolution. As notes are upserted
 * or removed, previously-unresolved links promote to resolved (or vice
 * versa); `unresolvedByTarget` is the index that lets this happen in
 * amortized O(edges-affected) instead of O(all edges).
 *
 * Single-writer, synchronous. Callers (the service wrapper) serialize
 * through the runner's event loop; no internal locking needed.
 */
export class InMemoryLinksIndex implements MutableLinksIndex {
  private notes = new Set<string>();
  private forward = new Map<string, NoteLink[]>();
  private reverse = new Map<string, Set<string>>();
  private byBasename = new Map<string, Set<string>>();
  private unresolvedByTarget = new Map<string, Set<string>>();

  outgoing(path: string): readonly NoteLink[] {
    return this.forward.get(path) ?? EMPTY;
  }

  backlinks(path: string): string[] {
    const set = this.reverse.get(path);
    if (!set) return [];
    return [...set].sort();
  }

  neighborCount(path: string): number {
    const out = this.forward.get(path);
    const ins = this.reverse.get(path);
    const seen = new Set<string>();
    if (out) for (const l of out) if (l.resolved && l.target && l.target !== path) seen.add(l.target);
    if (ins) for (const s of ins) if (s !== path) seen.add(s);
    return seen.size;
  }

  size(): number {
    return this.notes.size;
  }

  upsert(path: string, rawLinks: RawLink[]): void {
    // Track the path itself (so basename resolution works even before its links arrive).
    if (!this.notes.has(path)) {
      this.notes.add(path);
      addToSet(this.byBasename, basenameLower(path), path);
      // A previously-unresolved link to this note can now resolve.
      this.promoteIncoming(path);
    }

    const oldLinks = this.forward.get(path) ?? [];
    // Tear down the old edges before installing the new ones.
    for (const link of oldLinks) {
      if (link.resolved && link.target) {
        removeFromSet(this.reverse, link.target, path);
      } else {
        removeFromSet(this.unresolvedByTarget, normalizeRaw(link.raw), path);
      }
    }

    // Resolve and install new edges.
    const resolved: NoteLink[] = [];
    for (const { raw } of rawLinks) {
      const target = this.resolve(raw);
      if (target && target !== path) {
        resolved.push({ raw, target, resolved: true });
        addToSet(this.reverse, target, path);
      } else if (target === path) {
        // Self-link — record the edge but don't add to reverse.
        resolved.push({ raw, target, resolved: true });
      } else {
        resolved.push({ raw, target: null, resolved: false });
        addToSet(this.unresolvedByTarget, normalizeRaw(raw), path);
      }
    }
    this.forward.set(path, resolved);
  }

  remove(path: string): void {
    if (!this.notes.has(path)) return;

    // Drop our outgoing edges.
    const out = this.forward.get(path) ?? [];
    for (const link of out) {
      if (link.resolved && link.target) {
        removeFromSet(this.reverse, link.target, path);
      } else {
        removeFromSet(this.unresolvedByTarget, normalizeRaw(link.raw), path);
      }
    }
    this.forward.delete(path);

    // Anyone whose resolved link pointed to us is now unresolved again.
    const incoming = this.reverse.get(path);
    if (incoming) {
      for (const source of incoming) {
        const links = this.forward.get(source);
        if (!links) continue;
        for (const link of links) {
          if (link.resolved && link.target === path) {
            link.resolved = false;
            link.target = null;
            addToSet(this.unresolvedByTarget, normalizeRaw(link.raw), source);
          }
        }
      }
      this.reverse.delete(path);
    }

    this.notes.delete(path);
    removeFromSet(this.byBasename, basenameLower(path), path);
  }

  rename(from: string, to: string): void {
    if (!this.notes.has(from)) {
      // Fall back to a fresh upsert — caller's contract is "move what you have."
      if (!this.notes.has(to)) {
        this.notes.add(to);
        addToSet(this.byBasename, basenameLower(to), to);
        this.promoteIncoming(to);
      }
      return;
    }

    // Move outgoing edges as-is. Self-links re-point to `to`.
    const out = this.forward.get(from) ?? [];
    const movedOut: NoteLink[] = out.map((l) =>
      l.target === from ? { raw: l.raw, target: to, resolved: true } : l,
    );
    this.forward.delete(from);
    this.forward.set(to, movedOut);

    // Anyone unresolved-pointing at us via raw text is unaffected — `to` may still
    // not match the raw target. Anyone *resolved*-pointing at us needs the target
    // rewritten to `to`.
    const incoming = this.reverse.get(from);
    if (incoming) {
      for (const source of incoming) {
        const links = this.forward.get(source);
        if (!links) continue;
        for (const link of links) {
          if (link.resolved && link.target === from) {
            link.target = to;
          }
        }
      }
      this.reverse.set(to, incoming);
      this.reverse.delete(from);
    }

    // Update name indexes.
    this.notes.delete(from);
    this.notes.add(to);
    removeFromSet(this.byBasename, basenameLower(from), from);
    addToSet(this.byBasename, basenameLower(to), to);

    // The basename change may resolve previously-unresolved links pointing at
    // `to`'s basename, and may strand links that pointed at `from`'s basename.
    this.demoteUnresolvedFor(from);
    this.promoteIncoming(to);
  }

  // --- internals ---

  private resolve(raw: string): string | null {
    const stripped = stripFragment(raw).trim();
    if (!stripped) return null;
    const norm = stripped.replace(/\\/g, "/");

    if (norm.includes("/")) {
      // Treat as a full vault path. Try as-is, with `.md` appended, and case-insensitively.
      const candidates = [norm, `${norm}.md`];
      for (const c of candidates) {
        if (this.notes.has(c)) return c;
      }
      const lower = norm.toLowerCase();
      for (const path of this.notes) {
        if (path.toLowerCase() === lower || path.toLowerCase() === `${lower}.md`) return path;
      }
      return null;
    }

    // Bare basename — use the basename index. Pick shortest path then alphabetical.
    const bucket = this.byBasename.get(norm.toLowerCase());
    if (!bucket || bucket.size === 0) return null;
    const sorted = [...bucket].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return sorted[0];
  }

  private promoteIncoming(path: string): void {
    // Anyone whose unresolved raw target now resolves to `path` gets promoted.
    const candidates = candidateRawKeys(path);
    for (const key of candidates) {
      const sources = this.unresolvedByTarget.get(key);
      if (!sources) continue;
      const stillUnresolved = new Set<string>();
      for (const source of sources) {
        const links = this.forward.get(source);
        if (!links) continue;
        let promotedAny = false;
        for (const link of links) {
          if (link.resolved) continue;
          if (normalizeRaw(link.raw) !== key) continue;
          const t = this.resolve(link.raw);
          if (!t) continue;
          link.target = t;
          link.resolved = true;
          if (t !== source) addToSet(this.reverse, t, source);
          promotedAny = true;
        }
        if (!promotedAny) stillUnresolved.add(source);
      }
      if (stillUnresolved.size === 0) this.unresolvedByTarget.delete(key);
      else this.unresolvedByTarget.set(key, stillUnresolved);
    }
  }

  private demoteUnresolvedFor(removedPath: string): void {
    // After `removedPath` leaves the index under its old name, any forward
    // edge that resolved to it via basename or bare path needs revisiting.
    // Walk the reverse edges and re-resolve.
    const stranded = this.reverse.get(removedPath);
    if (!stranded) return;
    for (const source of stranded) {
      const links = this.forward.get(source);
      if (!links) continue;
      for (const link of links) {
        if (link.target !== removedPath) continue;
        const t = this.resolve(link.raw);
        if (t) {
          link.target = t;
          if (t !== source) addToSet(this.reverse, t, source);
        } else {
          link.resolved = false;
          link.target = null;
          addToSet(this.unresolvedByTarget, normalizeRaw(link.raw), source);
        }
      }
    }
    this.reverse.delete(removedPath);
  }
}

const EMPTY: readonly NoteLink[] = Object.freeze([]);

function addToSet<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function removeFromSet<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

function basenameLower(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  return file.replace(/\.md$/i, "").toLowerCase();
}

function stripFragment(raw: string): string {
  // Remove |alias, #heading, ^block fragments — target is whatever precedes them.
  const pipe = raw.indexOf("|");
  let s = pipe === -1 ? raw : raw.slice(0, pipe);
  const hash = s.indexOf("#");
  if (hash !== -1) s = s.slice(0, hash);
  const caret = s.indexOf("^");
  if (caret !== -1) s = s.slice(0, caret);
  return s;
}

function normalizeRaw(raw: string): string {
  return stripFragment(raw).trim().replace(/\\/g, "/").toLowerCase();
}

/**
 * For a newly-tracked path, list the keys in `unresolvedByTarget` that
 * could resolve to it: its basename, its full path with and without `.md`.
 */
function candidateRawKeys(path: string): string[] {
  const lower = path.toLowerCase();
  const noMd = lower.replace(/\.md$/i, "");
  return [basenameLower(path), lower, noMd];
}

// --- parser ---

const FENCE_RE = /^(?:```|~~~)/;
const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+?)\]\]/g;
const MD_LINK_RE = /(?<!!)\[[^\]\n]*?\]\(([^)\s]+)\)/g;

/**
 * Extract raw link targets from markdown content. Strips fenced code blocks
 * and inline code spans before scanning so links that appear inside code are
 * ignored. Returns one entry per occurrence (no dedup); the index dedups by
 * source path on upsert.
 *
 * Recognized:
 *  - [[Target]], [[Target|Alias]], [[Target#H]], [[Target^B]]
 *  - [text](relative.md), [text](relative.md#heading)
 *
 * Ignored: ![[...]] embeds, [text](http(s)://...), [text](mailto:...).
 */
export function parseLinks(content: string): RawLink[] {
  const stripped = stripCode(content);
  const out: RawLink[] = [];
  for (const m of stripped.matchAll(WIKILINK_RE)) {
    out.push({ raw: m[1] });
  }
  for (const m of stripped.matchAll(MD_LINK_RE)) {
    const url = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // protocol — http, mailto, etc.
    if (!/\.md(?:#|$)/i.test(url)) continue; // only intra-vault .md links
    out.push({ raw: decodeURIComponent(url) });
  }
  return out;
}

/** Replace fenced blocks and inline code spans with whitespace of equal length. */
function stripCode(content: string): string {
  // Pass 1: fenced blocks. Track the fence marker so ``` doesn't close ~~~.
  const lines = content.split(/(\r?\n)/);
  let inFence: string | null = null;
  const out: string[] = [];
  for (const line of lines) {
    if (inFence === null) {
      const m = FENCE_RE.exec(line);
      if (m) {
        inFence = m[0];
        out.push(blank(line));
        continue;
      }
      out.push(line);
    } else {
      // Inside a fence — blank everything until a closing fence on its own line.
      if (line.trimStart().startsWith(inFence)) inFence = null;
      out.push(blank(line));
    }
  }
  let s = out.join("");

  // Pass 2: inline code spans (single or multi backticks).
  s = s.replace(/`+[^`\n]*?`+/g, blank);
  return s;
}

function blank(s: string): string {
  return " ".repeat(s.length);
}
