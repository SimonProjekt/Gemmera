import type { LLMToolCall, VaultService } from "../contracts";
import type { NotePreviewResult } from "../ui/note-preview-modal";

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface ToolDispatchDeps {
  vault: VaultService;
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
  | { kind: "done"; summary: string; citations?: string[] }
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
      if (!args.mode || args.mode === "create") {
        return dispatchSaveNoteCreate(args, deps);
      }
      return { kind: "unknown_tool" };
    }
    default:
      return { kind: "unknown_tool" };
  }
}

// ── save_note (create) ────────────────────────────────────────────────────────

async function dispatchSaveNoteCreate(
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findUniquePath(vault: VaultService, folder: string, name: string): Promise<string> {
  const base = `${folder}${name}.md`;
  if (!await vault.exists(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${folder}${name} (${i}).md`;
    if (!await vault.exists(candidate)) return candidate;
  }
  return `${folder}${name} (${Date.now()}).md`;
}

/** Build a YAML frontmatter block. Strings are JSON-escaped (valid YAML double-quoted scalars). */
export function buildFrontmatter(title: string, tags: string[]): string {
  const lines = ["---", `title: ${JSON.stringify(title)}`];
  if (tags.length > 0) {
    lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`);
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
