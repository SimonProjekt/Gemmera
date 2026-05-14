import type { IndexService, LLMToolCall, VaultService } from "../contracts";
import type { IngestWriter } from "./ingest-writer";
import type { NotePreviewResult } from "../ui/note-preview-modal";

// ── Tool argument shapes ──────────────────────────────────────────────────────

export interface SaveNoteCreateArgs {
  mode: "create";
  title: string;
  body_markdown: string;
  tags?: string[];
}

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface ToolDispatchDeps {
  vault: VaultService;
  ingestWriter: IngestWriter;
  index: IndexService;
  /** Default folder for new notes (e.g. "Inbox/"). */
  inboxFolder: string;
  /**
   * UI callback: show the note preview modal and return the user's decision.
   * Injected from the view layer to keep this service UI-agnostic.
   */
  openNotePreview: (opts: {
    title: string;
    body: string;
    folder: string;
    tags: string[];
  }) => Promise<NotePreviewResult | null>;
  /** Append a system-level message to the chat thread. */
  appendSystemMessage: (text: string) => void;
}

// ── Result ────────────────────────────────────────────────────────────────────

export type ToolResult =
  | { kind: "done"; summary: string }
  | { kind: "cancelled"; message: string }
  | { kind: "unknown_tool" };

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Routes a single LLM tool call to its handler (#53).
 *
 * Only `save_note(mode="create")` is handled here; additional write and read
 * tools are added in subsequent issues (#62, #65).
 */
export async function dispatchToolCall(
  call: LLMToolCall,
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  switch (call.name) {
    case "save_note": {
      const args = call.arguments as { mode?: string; title?: string; body_markdown?: string; tags?: string[] };
      if (args.mode === "create" || !args.mode) {
        return dispatchSaveNoteCreate(args as SaveNoteCreateArgs, deps);
      }
      return { kind: "unknown_tool" };
    }
    default:
      return { kind: "unknown_tool" };
  }
}

// ── save_note (create) ────────────────────────────────────────────────────────

async function dispatchSaveNoteCreate(
  args: SaveNoteCreateArgs,
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
  const path = `${folder}${safeName}.md`;

  const frontmatter = buildFrontmatter(result.title, result.tags);
  const content = `${frontmatter}\n${args.body_markdown ?? ""}`;

  await deps.vault.create(path, content);
  return { kind: "done", summary: `Saved **${result.title}** to ${path}` };
}

function buildFrontmatter(title: string, tags: string[]): string {
  const lines = ["---", `title: "${title}"`];
  if (tags.length > 0) {
    lines.push(`tags: [${tags.map((t) => `"${t}"`).join(", ")}]`);
  }
  lines.push("---");
  return lines.join("\n");
}

// ── Tool definitions (for LLMService.chat calls) ──────────────────────────────

export const SAVE_NOTE_TOOL = {
  name: "save_note",
  description: "Save a new note to the vault. Use mode 'create' for new notes.",
  parameters: {
    type: "object",
    required: ["mode", "title", "body_markdown"],
    properties: {
      mode: { type: "string", enum: ["create", "append"] },
      title: { type: "string", description: "Note title (also used as filename)" },
      body_markdown: { type: "string", description: "Note body in Markdown" },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
    },
  },
} as const;
