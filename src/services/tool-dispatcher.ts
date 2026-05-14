import type {
  ClassifierDecision,
  IndexService,
  IntentLabel,
  JobQueue,
  LLMToolCall,
  LinksIndex,
  NoteSpec,
  Tool,
  VaultService,
} from "../contracts";
import { composeFile, type IngestWriter } from "./ingest-writer";
import { runDestructiveOp } from "./destructive-op-machine";
import { createSynthesisNote } from "./synthesis-writer";
import type { NotePreviewOpts, NotePreviewResult } from "../ui/note-preview-modal";

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
  openNotePreview: (opts: NotePreviewOpts) => Promise<NotePreviewResult | null>;
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

export interface ToolSelectionRoute {
  needsDisambiguation?: boolean;
  decision?: Pick<ClassifierDecision, "fallbackReason">;
}

/**
 * Selects the tool schemas to pass to the LLM for a given intent.
 *
 * Currently called only from `runChat` (the meta / fallback path). The ask,
 * capture, and mixed intents route through their own orchestrators
 * (runAsk / runCapture / runMixed) which do not call llm.chat with tools,
 * so those branches are ready for a future unified turn runner.
 */
export function selectToolsForIntent(
  intent: IntentLabel | null | undefined,
  route?: ToolSelectionRoute | null,
): Tool[] {
  if (route?.needsDisambiguation || route?.decision?.fallbackReason) {
    return [];
  }

  switch (intent) {
    case "ask":
      return [...READ_TOOLS];
    case "capture":
      return [...WRITE_TOOLS];
    case "mixed":
      return [...ALL_TOOLS];
    case "meta":
      return [];
    default:
      return [];
  }
}

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
    // ── Read tools (#65) ──
    case "search_notes":
      return dispatchSearchNotes(
        call.arguments as { query: string; top_k?: number },
        deps,
      );
    case "get_note":
      return dispatchGetNote(call.arguments as { path: string }, deps);
    case "find_related_notes":
      return dispatchFindRelated(call.arguments as { path: string }, deps);
    case "list_folder":
      return dispatchListFolder(call.arguments as { folder?: string }, deps);
    default:
      return { kind: "unknown_tool" };
  }
}

async function dispatchSaveCreate(
  args: {
    title?: string;
    body_markdown?: string;
    tags?: string[];
    summary?: string;
  },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const result = await deps.openNotePreview({
    title: args.title ?? "New note",
    body: args.body_markdown ?? "",
    folder: deps.inboxFolder,
    tags: args.tags ?? [],
    summary: args.summary ?? "",
  });

  if (!result) {
    deps.appendSystemMessage("Save cancelled.");
    return { kind: "cancelled", message: "Save cancelled." };
  }

  const folder = result.folder.endsWith("/") ? result.folder : result.folder + "/";
  const safeName = result.title.replace(/[\\/:*?"<>|]/g, "_");
  const path = await findUniquePath(deps.vault, folder, safeName);

  // Build a complete NoteSpec satisfying frontmatter.schema.json. Routing
  // through `composeFile` (the same serializer the ingest pipeline uses)
  // guarantees every required key is emitted — `tags` / `aliases` /
  // `entities` / `related` always render as `[]` rather than being omitted
  // when empty, and `cowork` is stamped consistently with synthesis notes.
  const spec: NoteSpec = {
    title: result.title,
    type: result.type,
    tags: result.tags,
    aliases: result.aliases,
    source: "manual",
    entities: [],
    related: [],
    status: result.status,
    summary: result.summary,
    key_points: [],
    body_markdown: args.body_markdown ?? "",
    cowork: {
      source: "synthesis",
      run_id: `tool-call-${Date.now()}`,
      model: deps.chatModel,
      version: "0.0.1",
      confidence: "medium",
    },
  };

  await deps.vault.create(path, composeFile(spec));
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

// ── Read tool handlers (#65) ──────────────────────────────────────────────────

async function dispatchSearchNotes(
  args: { query: string; top_k?: number },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const results = await deps.index.search(args.query, { topK: args.top_k ?? 5 });
  if (results.length === 0) {
    return { kind: "done", summary: `No notes found for "${args.query}".` };
  }
  const citations = results.map((r) => r.path);
  const lines = results.map((r) => `- **${r.basename}**: ${r.snippet.slice(0, 80)}…`);
  return {
    kind: "done",
    summary: `Found ${results.length} note(s) for "${args.query}":\n${lines.join("\n")}`,
    citations,
  };
}

async function dispatchGetNote(
  args: { path: string },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const exists = await deps.vault.exists(args.path);
  if (!exists) {
    return { kind: "cancelled", message: `Note not found: ${args.path}` };
  }
  const content = await deps.vault.read(args.path);
  const max = 2000;
  const truncated = content.length > max;
  const visible = truncated
    ? `${content.slice(0, max)}\n\n[...truncated at ${max} chars; full note is ${content.length} chars]`
    : content;
  return {
    kind: "done",
    summary: `Read **${args.path}**:\n\n${visible}`,
    citations: [args.path],
  };
}

async function dispatchFindRelated(
  args: { path: string },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const basename = args.path.split("/").pop()?.replace(/\.md$/, "") ?? args.path;
  const lexicalName = basename.replace(/[_-]+/g, " ");
  const exists = await deps.vault.exists(args.path);
  const content = exists ? await deps.vault.read(args.path) : "";
  const query = [lexicalName, content.slice(0, 500)].filter(Boolean).join("\n\n");
  const results = await deps.index.search(query, { topK: 5 });
  const related = results.filter((r) => r.path !== args.path);
  if (related.length === 0) {
    return { kind: "done", summary: `No related notes found for ${args.path}.` };
  }
  const citations = related.map((r) => r.path);
  const lines = related.map((r) => `- **${r.basename}**`);
  return {
    kind: "done",
    summary: `Notes related to **${basename}**:\n${lines.join("\n")}`,
    citations,
  };
}

async function dispatchListFolder(
  args: { folder?: string },
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  const files = await deps.vault.listMarkdownFiles();
  const folder = args.folder ? (args.folder.endsWith("/") ? args.folder : args.folder + "/") : "";
  const filtered = folder
    ? files.filter((f) => f.path.startsWith(folder))
    : files;

  if (filtered.length === 0) {
    return { kind: "done", summary: folder ? `No notes in ${folder}.` : "Vault is empty." };
  }
  const citations = filtered.map((f) => f.path);
  const lines = filtered.slice(0, 20).map((f) => `- ${f.basename}`);
  const suffix = filtered.length > 20 ? `\n…and ${filtered.length - 20} more` : "";
  return {
    kind: "done",
    summary: `${filtered.length} note(s) in ${folder || "vault"}:\n${lines.join("\n")}${suffix}`,
    citations,
  };
}

// ── Tool definitions (for LLMService.chat) ────────────────────────────────────

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
      summary: {
        type: "string",
        description: "1–2 sentence summary for the frontmatter (mode=create). The user can edit before saving; required field — prompted in the modal if empty.",
      },
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

export const SEARCH_NOTES_TOOL = {
  name: "search_notes",
  description: "Full-text search across the vault. Returns scored results with snippets.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      top_k: { type: "number", description: "Max results to return (default 5)" },
    },
  },
} as const;

export const GET_NOTE_TOOL = {
  name: "get_note",
  description: "Read the full content of a note by path.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" } },
  },
} as const;

export const FIND_RELATED_TOOL = {
  name: "find_related_notes",
  description: "Find notes semantically related to the given note path.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" } },
  },
} as const;

export const LIST_FOLDER_TOOL = {
  name: "list_folder",
  description: "List all Markdown notes in a vault folder (or the whole vault).",
  parameters: {
    type: "object",
    properties: { folder: { type: "string", description: "Folder path, e.g. 'Inbox/'" } },
  },
} as const;

export const READ_TOOLS = [
  SEARCH_NOTES_TOOL,
  GET_NOTE_TOOL,
  FIND_RELATED_TOOL,
  LIST_FOLDER_TOOL,
] as const;

export const ALL_TOOLS = [...WRITE_TOOLS, ...READ_TOOLS] as const;
