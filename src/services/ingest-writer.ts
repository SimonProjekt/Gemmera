import type { NoteSpec, VaultService } from "../contracts";

export interface WriteNewOptions {
  /** Folder to place the new note in. Default `Inbox/`. Trailing slash optional. */
  folder?: string;
  /** Override for tests (defaults to `Date.now`). */
  now?: () => number;
}

export interface AppendOptions {
  /** Override for tests. */
  now?: () => number;
}

/**
 * Atomic write paths for the ingest tool loop (#13). Composes the cowork
 * frontmatter block from planning/rag.md §"Frontmatter contract" and stamps
 * `cowork_managed: true` so subsequent writes know the file is app-managed.
 *
 * Append mode places the new content under a dated H2 heading (`## YYYY-MM-DD`)
 * inside the target note. Idempotency for append-on-the-same-day is not
 * promised — repeated appends accumulate paragraphs under the same heading,
 * which is the desired behavior for daily-note-style flows.
 */
export class IngestWriter {
  constructor(private readonly vault: VaultService) {}

  async writeNew(
    spec: NoteSpec,
    opts: WriteNewOptions = {},
  ): Promise<{ path: string }> {
    const folder = normalizeFolder(opts.folder ?? "Inbox/");
    const now = opts.now ?? (() => Date.now());
    const datePrefix = isoDate(now());
    const slug = slugifyTitle(spec.title);
    const baseName = `${datePrefix} ${slug}`;
    const path = await uniquePath(this.vault, folder, baseName);
    const content = composeFile(spec);
    await this.vault.create(path, content);
    return { path };
  }

  async appendUnderDatedHeading(
    targetPath: string,
    body: string,
    opts: AppendOptions = {},
  ): Promise<void> {
    const now = opts.now ?? (() => Date.now());
    if (!(await this.vault.exists(targetPath))) {
      throw new Error(`append target missing: ${targetPath}`);
    }
    const existing = await this.vault.read(targetPath);
    const heading = `## ${isoDate(now())}`;
    const trimmed = body.trim();
    const append = existing.includes(`\n${heading}\n`)
      ? `\n\n${trimmed}\n`
      : `\n\n${heading}\n\n${trimmed}\n`;
    await this.vault.append(targetPath, append);
  }
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function slugifyTitle(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|#]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "Untitled";
}

function normalizeFolder(folder: string): string {
  if (!folder) return "";
  return folder.endsWith("/") ? folder : `${folder}/`;
}

async function uniquePath(
  vault: VaultService,
  folder: string,
  baseName: string,
): Promise<string> {
  const first = `${folder}${baseName}.md`;
  if (!(await vault.exists(first))) return first;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${folder}${baseName} (${i}).md`;
    if (!(await vault.exists(candidate))) return candidate;
  }
  throw new Error(`Could not find unused path for ${baseName}`);
}

/**
 * Compose the file contents: frontmatter + body. The body MUST NOT contain
 * its own frontmatter block (the parser strips it; we re-fail here as
 * defense in depth so a buggy parser cannot corrupt the file format).
 */
function composeFile(spec: NoteSpec): string {
  const body = spec.body_markdown ?? "";
  if (/^---\s*\r?\n/.test(body)) {
    throw new Error("body_markdown must not contain its own frontmatter block");
  }
  const frontmatter = renderFrontmatter(spec);
  return `${frontmatter}\n${body.endsWith("\n") ? body : `${body}\n`}`;
}

function renderFrontmatter(spec: NoteSpec): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${yamlScalar(spec.title)}`);
  lines.push(`type: ${spec.type}`);
  lines.push(`status: ${spec.status}`);
  lines.push(`source: ${spec.source}`);
  lines.push(`cowork_managed: true`);
  lines.push(`tags: ${yamlList(spec.tags)}`);
  lines.push(`aliases: ${yamlList(spec.aliases)}`);
  lines.push(`entities: ${yamlList(spec.entities)}`);
  lines.push(`related: ${yamlList(spec.related)}`);
  if (spec.summary) lines.push(`summary: ${yamlScalar(spec.summary)}`);
  if (spec.key_points.length > 0) {
    lines.push(`key_points:`);
    for (const k of spec.key_points) lines.push(`  - ${yamlScalar(k)}`);
  }
  lines.push(`cowork:`);
  lines.push(`  source: ${spec.cowork.source}`);
  lines.push(`  run_id: ${yamlScalar(spec.cowork.run_id)}`);
  lines.push(`  model: ${yamlScalar(spec.cowork.model)}`);
  lines.push(`  version: ${yamlScalar(spec.cowork.version)}`);
  lines.push(`  confidence: ${spec.cowork.confidence}`);
  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(s: string): string {
  if (s === "" || /[:#\-?,&*!|>%@`{}\[\]\n]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function yamlList(items: string[]): string {
  if (items.length === 0) return "[]";
  return `[${items.map(yamlScalar).join(", ")}]`;
}
