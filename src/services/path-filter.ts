import type { PathFilter, UserIgnoreMatcher } from "../contracts";

const HARD_IGNORE_PREFIXES = [".obsidian/", ".git/", ".coworkmd/", ".trash/"];

export const NOOP_USER_IGNORE: UserIgnoreMatcher = {
  matches: () => false,
};

/**
 * Default path filter: hard-ignores Obsidian internals and the index's own
 * directory, restricts to .md, then defers to a user-ignore matcher (which
 * the .coworkignore parser will plug into — see issue #29).
 */
export class DefaultPathFilter implements PathFilter {
  constructor(private readonly userIgnore: UserIgnoreMatcher = NOOP_USER_IGNORE) {}

  shouldIndex(path: string): boolean {
    const normalized = normalize(path);
    if (HARD_IGNORE_PREFIXES.some((p) => normalized.startsWith(p))) return false;
    if (!normalized.toLowerCase().endsWith(".md")) return false;
    if (this.userIgnore.matches(normalized)) return false;
    return true;
  }
}

function normalize(p: string): string {
  // Strip leading "./" and any leading slash; vault paths are relative.
  return p.replace(/^\.?\/+/, "");
}
