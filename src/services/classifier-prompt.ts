import { promises as fs } from "fs";
import { join } from "path";
import { ClassifierInput } from "../contracts/classifier";

/** Canonical version ID for intent-classifier prompt. Stamped into every
 *  `classifier_decision` event row so eval regressions trace to the
 *  exact prompt revision. Must match the `version:` header in
 *  `prompts/intent-classifier.md`. */
export const INTENT_CLASSIFIER_PROMPT_VERSION = "0.1.0";

/**
 * Assemble the full classifier prompt by rendering a template body with
 * values from `input`. The `body` parameter is the raw prompt file
 * content (system instructions + few-shot examples + placeholders) as
 * loaded by the FilePromptLoader or from disk.
 *
 * Placeholders:
 *   {{messageText}}     — the (possibly truncated) user message
 *   {{attachmentList}}  — bullet list of attachments, or empty line
 *   {{activeFileLine}}  — "Active file: title (filename)", or empty line
 *   {{recentTurnList}}  — numbered recent turns, or empty line
 */
export function assembleClassifierPrompt(
  input: ClassifierInput,
  body: string,
): string {
  return body
    .replace("{{messageText}}", input.messageText)
    .replace("{{attachmentList}}", renderAttachmentList(input))
    .replace("{{activeFileLine}}", renderActiveFile(input))
    .replace("{{recentTurnList}}", renderRecentTurns(input));
}

/** Load the prompt file from the `prompts/` directory next to the
 *  project root. Returns the raw file content including the version
 *  header line. */
export async function loadClassifierPromptBody(): Promise<string> {
  return fs.readFile(
    join(process.cwd(), "prompts", "intent-classifier.md"),
    "utf-8",
  );
}

// ─── section renderers ────────────────────────────────────────────────

function renderAttachmentList(input: ClassifierInput): string {
  if (input.attachments.length === 0) return "";
  return (
    "Attachments:\n" +
    input.attachments.map((a) => `- ${a.kind}: ${a.filename}`).join("\n")
  );
}

function renderActiveFile(input: ClassifierInput): string {
  if (!input.activeFile) return "";
  return `Active file: ${input.activeFile.title} (${input.activeFile.filename})`;
}

function renderRecentTurns(input: ClassifierInput): string {
  if (input.recentTurns.length === 0) return "";
  return (
    "Recent conversation:\n" +
    input.recentTurns
      .map((t) => `- User: "${t.text}" → ${t.intent}`)
      .join("\n")
  );
}
