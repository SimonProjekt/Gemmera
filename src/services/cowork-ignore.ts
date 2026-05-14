import type { UserIgnoreMatcher } from "../contracts";

// These paths are always ignored regardless of user rules.
const HARD_IGNORES = [".obsidian/", ".git/", ".trash/", ".coworkmd/"];

export const DEFAULT_COWORKIGNORE = [
  "# Gemmera ignore file — gitignore-style patterns",
  "# Files and folders matching these patterns are never indexed or retrieved.",
  "",
  "Templates/",
  "Attachments/",
  "attachments/",
  "assets/",
  "*.canvas",
  "*.excalidraw",
].join("\n");

interface Rule {
  pattern: string;
  negated: boolean;
  isDirPattern: boolean;
  /** Compiled regex for non-directory patterns. */
  regex: RegExp;
}

function parseRule(raw: string): Rule | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const negated = trimmed.startsWith("!");
  let pattern = negated ? trimmed.slice(1).trimStart() : trimmed;

  const isDirPattern = pattern.endsWith("/");
  if (isDirPattern) pattern = pattern.slice(0, -1);

  const regex = buildRegex(pattern);
  return { pattern, negated, isDirPattern, regex };
}

function buildRegex(pattern: string): RegExp {
  // A leading "/" is stripped (anchors to root in gitignore — same as having a slash)
  const stripped = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const hasSlash = stripped.includes("/");
  const regexBody = globToRegexBody(stripped);

  if (hasSlash) {
    // Anchored to root
    return new RegExp("^" + regexBody + "$");
  }
  // Unanchored: match at any depth against the path
  return new RegExp("(^|/)" + regexBody + "$");
}

function globToRegexBody(pattern: string): string {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      result += ".*";
      i += 2;
      if (pattern[i] === "/") i++; // consume slash after **
    } else if (ch === "*") {
      result += "[^/]*";
      i++;
    } else if (ch === "?") {
      result += "[^/]";
      i++;
    } else if (/[.+^${}[\]|()\\]/.test(ch)) {
      result += "\\" + ch;
      i++;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

function testRule(rule: Rule, path: string): boolean {
  if (rule.isDirPattern) {
    return path === rule.pattern || path.startsWith(rule.pattern + "/");
  }
  return rule.regex.test(path);
}

/**
 * Parses a `.coworkignore` file and implements `UserIgnoreMatcher`.
 * Evaluation is last-match-wins, consistent with gitignore. Hard-coded
 * system paths are always ignored, even if the user writes a `!` negation.
 *
 * Call `reload(newContent)` to update rules without creating a new instance.
 */
export class CoworkIgnore implements UserIgnoreMatcher {
  private rules: Rule[];

  constructor(content: string) {
    this.rules = parseLines(content);
  }

  reload(content: string): void {
    this.rules = parseLines(content);
  }

  matches(path: string): boolean {
    if (isHardIgnored(path)) return true;

    let ignored = false;
    for (const rule of this.rules) {
      if (testRule(rule, path)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }
}

function parseLines(content: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of content.split("\n")) {
    const rule = parseRule(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

function isHardIgnored(path: string): boolean {
  return HARD_IGNORES.some((h) => path === h.slice(0, -1) || path.startsWith(h));
}
