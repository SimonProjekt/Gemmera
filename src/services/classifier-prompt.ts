import { ClassifierInput } from "../contracts/classifier";

/**
 * Assemble the full classifier prompt by rendering a template body with
 * values from `input`. The `body` parameter is the prompt body returned
 * by `FilePromptLoader.load("intent-classifier")` (header stripped, body
 * trimmed). The resolved `version` from the same `LoadedPrompt` is what
 * gets stamped into `classifier_decision` rows.
 *
 * Placeholders:
 *   {{messageText}}     — the (possibly truncated) user message
 *   {{attachmentList}}  — bullet list of attachments, or empty line
 *   {{activeFileLine}}  — "Active file: title (filename)", or empty line
 *   {{recentTurnList}}  — numbered recent turns, or empty line
 *
 * Substitution uses a function-form replace so user input containing
 * `$&`, `$1`, etc. is not interpreted as a regex backreference.
 */
export function assembleClassifierPrompt(
  input: ClassifierInput,
  body: string,
): string {
  const substitutions: Record<string, string> = {
    messageText: input.messageText,
    attachmentList: renderAttachmentList(input),
    activeFileLine: renderActiveFile(input),
    recentTurnList: renderRecentTurns(input),
  };
  return body.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(substitutions, key)
      ? substitutions[key]
      : match,
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
