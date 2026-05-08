import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AttachmentKind,
  IntentLabel,
} from "../../src/contracts/classifier";
import type { ClassifyTurnInput } from "../../src/services/classifier-orchestrator";

export interface GoldenExample {
  id: string;
  input: {
    messageText: string;
    attachmentKinds?: AttachmentKind[];
    activeFileName?: string | null;
    activeFileTitle?: string | null;
    recentTurns?: Array<{ userText: string; label: IntentLabel }>;
    ctrlEnter?: boolean;
  };
  expectedLabel: IntentLabel;
  notes?: string;
}

export function loadGoldenSet(): GoldenExample[] {
  const raw = readFileSync(join(__dirname, "examples.json"), "utf-8");
  return JSON.parse(raw) as GoldenExample[];
}

export function toClassifyTurnInput(ex: GoldenExample): ClassifyTurnInput {
  const kinds = ex.input.attachmentKinds ?? [];
  return {
    messageText: ex.input.messageText,
    attachments: kinds.map((kind, i) => ({
      kind,
      filename: `attachment-${i}.${kind}`,
    })),
    activeFile:
      ex.input.activeFileName
        ? {
            filename: ex.input.activeFileName,
            title: ex.input.activeFileTitle ?? ex.input.activeFileName,
          }
        : null,
    recentTurns: (ex.input.recentTurns ?? []).map((t) => ({
      text: t.userText,
      intent: t.label,
    })),
    ctrlEnter: ex.input.ctrlEnter,
  };
}
