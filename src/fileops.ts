import { App } from "obsidian";
import { CreateFileModal } from "./CreateFileModal";
import { AppendFileModal } from "./AppendFileModal";
import { showSaveUndoNotice } from "./notices";

const CREATE_RE = /:::create\s+(\S+\.md)\n([\s\S]*?):::/g;
const APPEND_RE = /:::append\s+(\S+\.md)\n([\s\S]*?):::/g;

export interface FileOp {
  type: "create" | "append";
  filename: string;
  content: string;
}

export function parseFileOps(text: string): FileOp[] {
  const ops: FileOp[] = [];
  for (const m of text.matchAll(CREATE_RE)) {
    ops.push({ type: "create", filename: m[1], content: m[2].trim() });
  }
  for (const m of text.matchAll(APPEND_RE)) {
    ops.push({ type: "append", filename: m[1], content: m[2].trim() });
  }
  return ops;
}

export async function handleFileOps(app: App, ops: FileOp[], inboxFolder = "Inbox/"): Promise<void> {
  for (const op of ops) {
    const filename = qualifyPath(op.filename, inboxFolder);
    if (op.type === "create") {
      new CreateFileModal(app, filename, op.content, async (fname, content) => {
        const existing = app.vault.getAbstractFileByPath(fname);
        if (existing) {
          console.warn(`Gemmera: ${fname} finns redan, hoppar över skapande`);
          return;
        }
        await app.vault.create(fname, content);
        showSaveUndoNotice(app, fname);
      }).open();
    } else if (op.type === "append") {
      new AppendFileModal(app, filename, op.content, async (fname, content) => {
        const file = app.vault.getFileByPath(fname);
        if (!file) {
          console.warn(`Gemmera: ${fname} hittades inte för append`);
          return;
        }
        await app.vault.append(file, "\n" + content);
        showSaveUndoNotice(app, fname);
      }).open();
    }
  }
}

function qualifyPath(filename: string, inbox: string): string {
  if (filename.includes("/") || filename.includes("\\")) return filename;
  const base = inbox.endsWith("/") ? inbox : inbox + "/";
  return base + filename;
}
