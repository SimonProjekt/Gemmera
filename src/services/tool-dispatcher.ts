import type {
  IndexService,
  JobQueue,
  LLMToolCall,
  LinksIndex,
  VaultService,
} from "../contracts";
import type { IngestWriter } from "./ingest-writer";
import { runDestructiveOp } from "./destructive-op-machine";
import { createSynthesisNote } from "./synthesis-writer";
import type { NotePreviewResult } from "../ui/note-preview-modal";

export interface ToolDispatchDeps {
  vault: VaultService;
  ingestWriter: IngestWriter;
  jobQueue: JobQueue;
  index: IndexService;
  linksIndex: Pick<LinksIndex, "neighborCount">;
  /** Default folder for new notes (e.g. "Inbox/"). */
  inboxFolder: string;
  /** Model tag, used when creating synthesis notes. */
  chatModel: string;
  /** UI callback: note preview modal for create. Returns null on cancel. */
  openNotePreview: (opts: {
    title: string;
    body: string;
    folder: string;
    tags: string[];
  }) => Promise<NotePreviewResult | null>;
  /**
   * UI callback: mandatory delete confirmation (non-overridable).
   * Resolves "confirmed" or "cancelled".
   */
  confirmDelete: (path: string, preview: string) => Promise<"confirmed" | "cancelled">;
  /**
   * UI callback: rename/move preview. May be auto-confirmed by the caller
   * when the user has disabled "Always preview" (rename is safe + reversible).
   */
  confirmRename: (from: string, to: string, linkCount: number) => Promise<"confirmed" | "cancelled">;
  /** Append a system-level message to the chat thread. */
  appendSystemMessage: (text: string) => void;
}

export type ToolResult =
  | { kind: "done"; summary: string; citations?: string[] }
  | { kind: "cancelled"; message: string }
  | { kind: "unknown_tool" };

export async function dispatchToolCall(
  call: LLMToolCall,
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  switch (call.name) {
    case "save_note": {
      const args = call.arguments as { mode?: string; title?: string; path?: string; body_markdown?: string; tags?: string[] };
      if (!args.mode || args.mode === "create") {
        return dispatchSaveCreate(args, deps);
      }
      if (args.mode === "append") {
        return dispatchSaveAppend(args, deps);
      }
      return { kind: "unknown_tool" };
    }
    case "update_frontmatter":
      return dispatchUpdateFrontmatter(
        call.arguments as { path: string; updates: Record<string, unknown> },
        deps,
      );
    case "rename_or_move_note":
      return dispatchRename(
        call.arguments as { from: string; to: string },
        deps,
      );
    case "delete_note":
      return dispatchDelete(call.arguments as { path: string }, deps);
    case "create_synthesis_note":
      return dispatchSynthesis(
        call.arguments as { question: string; answer: string; citations?: string[] },
        deps,
      );
    default:
      return { kind: "unknown_tool" };
  }
}

async function dispatchSaveCreate(
  args: { title?: string; body_markdown?: string; tags?: string[] },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const result = await deps.openNotePreview({
    title: args.title ?? "New note",
    body: args.body_markdown ?? "",
    folder: deps.inboxFolder,
    tags: args.tags ?? [],
  });

  if (!result) {
    deps.appendSystemMessage("Save cancelled.");
    return { kind: "cancelled", message: "Save cancelled." };
  }

  const folder = result.folder.endsWith("/") ? result.folder : result.folder + "/";
  const safeName = result.title.replace(/[\\/:*?"<>|]/g, "_");
  const path = await findUniquePath(deps.vault, folder, safeName);

  const frontmatter = buildFrontmatter(result.title, result.tags);
  const content = `${frontmatter}\n${args.body_markdown ?? ""}`;

  await deps.vault.create(path, content);
  return { kind: "done", summary: `Saved **${result.title}** to ${path}` };
}

async function dispatchSaveAppend(
  args: { path?: string; body_markdown?: string },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const path = args.path;
  if (!path) return { kind: "unknown_tool" };

  const exists = await deps.vault.exists(path);
  if (!exists) {
    deps.appendSystemMessage(`Note not found: ${path}`);
    return { kind: "cancelled", message: `Note not found: ${path}` };
  }

  const raw = await deps.vault.read(path);
  const updated = appendUnderDatedSection(raw, args.body_markdown ?? "");
  await deps.vault.modify(path, updated);
  return { kind: "done", summary: `Appended to **${path}**` };
}

async function dispatchUpdateFrontmatter(
  args: { path: string; updates: Record<string, unknown> },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const exists = await deps.vault.exists(args.path);
  if (!exists) {
    deps.appendSystemMessage(`Note not found: ${args.path}`);
    return { kind: "cancelled", message: `Note not found: ${args.path}` };
  }

  const raw = await deps.vault.read(args.path);
  const updated = patchFrontmatter(raw, args.updates);
  if (updated === null) {
    const message = `Could not update frontmatter in ${args.path}: unclosed frontmatter block.`;
    deps.appendSystemMessage(message);
    return { kind: "cancelled", message };
  }
  await deps.vault.modify(args.path, updated);
  return { kind: "done", summary: `Updated frontmatter in **${args.path}**` };
}

async function dispatchRename(
  args: { from: string; to: string },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const outcome = await runDestructiveOp(
    { kind: "rename", from: args.from, to: args.to, affectedLinkCount: deps.linksIndex.neighborCount(args.from) },
    {
      vault: deps.vault,
      jobQueue: deps.jobQueue,
      confirmDelete: deps.confirmDelete,
      confirmRename: deps.confirmRename,
    },
  );

  if (outcome.kind === "cancelled") {
    deps.appendSystemMessage("Rename cancelled.");
    return { kind: "cancelled", message: "Rename cancelled." };
  }
  return { kind: "done", summary: `Renamed **${args.from}** -> **${args.to}**` };
}

async function dispatchDelete(
  args: { path: string },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const outcome = await runDestructiveOp(
    { kind: "delete", path: args.path },
    {
      vault: deps.vault,
      jobQueue: deps.jobQueue,
      confirmDelete: deps.confirmDelete,
      confirmRename: deps.confirmRename,
    },
  );

  if (outcome.kind === "cancelled") {
    deps.appendSystemMessage("Delete cancelled.");
    return { kind: "cancelled", message: "Delete cancelled." };
  }
  return { kind: "done", summary: `Deleted **${args.path}** (moved to trash)` };
}

async function dispatchSynthesis(
  args: { question: string; answer: string; citations?: string[] },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const { path } = await createSynthesisNote(
    {
      question: args.question,
      answer: args.answer,
      citations: args.citations ?? [],
      model: deps.chatModel,
      runId: `tool-call-${Date.now()}`,
    },
    deps.ingestWriter,
    { folder: deps.inboxFolder },
  );
  return { kind: "done", summary: `Synthesis note saved to **${path}**` };
}

async function findUniquePath(vault: VaultService, folder: string, name: string): Promise<string> {
  const base = `${folder}${name}.md`;
  if (!await vault.exists(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${folder}${name} (${i}).md`;
    if (!await vault.exists(candidate)) return candidate;
  }
  return `${folder}${name} (${Date.now()}).md`;
}

/** Build a YAML frontmatter block. Values use JSON-compatible YAML flow scalars. */
export function buildFrontmatter(title: string, tags: string[]): string {
  const lines = ["---", `title: ${yamlValue(title)}`];
  if (tags.length > 0) {
    lines.push(`tags: [${tags.map((t) => yamlValue(t)).join(", ")}]`);
  }
  lines.push("---");
  return lines.join("\n");
}

export function appendUnderDatedSection(raw: string, body: string, now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  const text = body.trim();
  if (!text) return raw;
  const headingRe = new RegExp(`(^|\\n)## ${escapeRegExp(today)}(?:\\n|$)`);
  const separator = raw.endsWith("\n") ? "\n" : "\n\n";
  if (headingRe.test(raw)) {
    return `${raw}${separator}${text}`;
  }
  return `${raw}${separator}## ${today}\n\n${text}`;
}

export function patchFrontmatter(raw: string, updates: Record<string, unknown>): string | null {
  if (!raw.startsWith("---")) {
    const fm = Object.entries(updates)
      .map(([k, v]) => `${k}: ${yamlValue(v)}`)
      .join("\n");
    return `---\n${fm}\n---\n${raw}`;
  }

  const end = raw.indexOf("---", 3);
  if (end === -1) return null;

  const before = raw.slice(3, end);
  const after = raw.slice(end + 3);

  let fm = before;
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${escapeRegExp(key)}:.*$`, "m");
    const line = `${key}: ${yamlValue(value)}`;
    if (re.test(fm)) {
      fm = fm.replace(re, line);
    } else {
      fm += fm.endsWith("\n") ? line + "\n" : "\n" + line + "\n";
    }
  }

  return `---${fm}---${after}`;
}

function yamlValue(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const SAVE_NOTE_TOOL = {
  name: "save_note",
  description: "Create or append to a note in the vault.",
  parameters: {
    type: "object",
    required: ["mode"],
    properties: {
      mode: { type: "string", enum: ["create", "append"] },
      title: { type: "string", description: "Title for new note (mode=create)" },
      path: { type: "string", description: "Existing note path (mode=append)" },
      body_markdown: { type: "string", description: "Note body in Markdown" },
      tags: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export const UPDATE_FRONTMATTER_TOOL = {
  name: "update_frontmatter",
  description: "Update YAML frontmatter fields in an existing note.",
  parameters: {
    type: "object",
    required: ["path", "updates"],
    properties: {
      path: { type: "string" },
      updates: { type: "object" },
    },
  },
} as const;

export const RENAME_TOOL = {
  name: "rename_or_move_note",
  description: "Rename or move a note; all incoming links update automatically.",
  parameters: {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: { type: "string" },
      to: { type: "string" },
    },
  },
} as const;

export const DELETE_TOOL = {
  name: "delete_note",
  description: "Move a note to the system trash. Requires explicit confirmation.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" } },
  },
} as const;

export const SYNTHESIS_TOOL = {
  name: "create_synthesis_note",
  description: "Save a Q&A answer as a permanent synthesis note with citations.",
  parameters: {
    type: "object",
    required: ["question", "answer"],
    properties: {
      question: { type: "string" },
      answer: { type: "string" },
      citations: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export const WRITE_TOOLS = [
  SAVE_NOTE_TOOL,
  UPDATE_FRONTMATTER_TOOL,
  RENAME_TOOL,
  DELETE_TOOL,
  SYNTHESIS_TOOL,
] as const;
