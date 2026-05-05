import { App } from "obsidian";
import { CreateFileModal } from "./CreateFileModal";
import { AppendFileModal } from "./AppendFileModal";

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

export async function handleFileOps(app: App, ops: FileOp[]): Promise<void> {
  for (const op of ops) {
    if (op.type === "create") {
      new CreateFileModal(app, op.filename, op.content, async (filename, content) => {
        const existing = app.vault.getAbstractFileByPath(filename);
        if (existing) {
          console.warn(`Gemmera: ${filename} finns redan, hoppar över skapande`);
          return;
        }
        await app.vault.create(filename, content);
      }).open();
    } else if (op.type === "append") {
      new AppendFileModal(app, op.filename, op.content, async (filename, content) => {
        const file = app.vault.getFileByPath(filename);
        if (!file) {
          console.warn(`Gemmera: ${filename} hittades inte för append`);
          return;
        }
        await app.vault.append(file, "\n" + content);
      }).open();
    }
  }
}
