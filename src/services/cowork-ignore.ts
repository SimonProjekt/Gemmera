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
  negated: boolean;
  regex: RegExp;
}

function parseRule(raw: string): Rule | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const negated = trimmed.startsWith("!");
  let pattern = negated ? trimmed.slice(1).trimStart() : trimmed;

  const isDirPattern = pattern.endsWith("/");
  if (isDirPattern) pattern = pattern.slice(0, -1);

  return { negated, regex: buildRegex(pattern, isDirPattern) };
}

// Gitignore semantics:
//   - leading "/" or any internal "/" → anchored to vault root
//   - otherwise → unanchored, matches at any depth
//   - trailing "/" (dir pattern) also matches everything beneath the directory
function buildRegex(pattern: string, isDirPattern: boolean): RegExp {
  const leadingSlash = pattern.startsWith("/");
  const stripped = leadingSlash ? pattern.slice(1) : pattern;
  const anchored = leadingSlash || stripped.includes("/");
  const body = globToRegexBody(stripped);
  const tail = isDirPattern ? "(?:/.*)?" : "";
  return anchored
    ? new RegExp("^" + body + tail + "$")
    : new RegExp("(?:^|/)" + body + tail + "$");
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
      if (rule.regex.test(path)) {
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
