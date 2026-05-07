import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassifyOptions, IntentLabel } from "../../src/contracts/classifier";

export interface GoldenExample {
  id: string;
  input: {
    messageText: string;
    attachmentKinds?: string[];
    activeFileName?: string | null;
    activeFileTitle?: string | null;
    recentTurns?: Array<{ userText: string; label: IntentLabel }>;
  };
  expectedLabel: IntentLabel;
  notes?: string;
}

export function loadGoldenSet(): GoldenExample[] {
  const raw = readFileSync(join(__dirname, "examples.json"), "utf-8");
  return JSON.parse(raw) as GoldenExample[];
}

export function toClassifyOptions(ex: GoldenExample, model?: string): ClassifyOptions {
  return {
    messageText: ex.input.messageText,
    model,
    attachmentKinds: ex.input.attachmentKinds ?? [],
    activeFileName: ex.input.activeFileName ?? undefined,
    activeFileTitle: ex.input.activeFileTitle ?? undefined,
    recentTurns: ex.input.recentTurns ?? [],
  };
}
