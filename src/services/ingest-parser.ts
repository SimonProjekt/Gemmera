import type { LLMService, NoteSpec, PromptLoader } from "../contracts";
import { RetryBudget, withInfraRetry, withJsonRetry } from "./retry-policy";

export interface IngestParserDeps {
  llm: LLMService;
  promptLoader: PromptLoader;
  /** Override for tests so the test doesn't depend on real time/randomness. */
  runId?: () => string;
  model?: string;
  version?: string;
}

export type ParseResult =
  | { ok: true; spec: NoteSpec }
  | { ok: false; reason: "parse_failed" | "schema_failed" | "empty"; raw: string };

/**
 * Calls the ingest-parser prompt with `format: "json"` and produces a
 * structured `NoteSpec`. The cowork-block fields (run_id, model, version)
 * are filled in by the orchestrator after parsing — the LLM only produces
 * the user-derived fields.
 *
 * Validation is intentionally permissive on optional list fields (defaults
 * to `[]`) but strict on the required scalars (`title`, `type`, `source`,
 * `body_markdown`). A parse miss returns a typed `ParseResult` so the
 * orchestrator can decide between retry and error-state.
 *
 * Retry policy (#51):
 * - Ollama connection refused → 1 infra retry after 500 ms (does not consume budget).
 * - Invalid JSON → 1 retry via `budget`; second failure → parse_failed.
 * - Schema-valid but rule-violating → 1 retry with error feedback via `budget`;
 *   second failure → schema_failed.
 * When `budget` is omitted a zero-slot budget is used (no retries, existing behaviour).
 */
export async function parseContent(
  text: string,
  instruction: string | undefined,
  deps: IngestParserDeps,
  signal?: AbortSignal,
  budget?: RetryBudget,
): Promise<ParseResult> {
  if (!text.trim()) return { ok: false, reason: "empty", raw: "" };

  const prompt = await deps.promptLoader.load("ingest-parser");
  const userPrompt = composeUserPrompt(text, instruction);
  const b = budget ?? new RetryBudget(0);
  const coworkDefaults = {
    runId: (deps.runId ?? defaultRunId)(),
    model: deps.model ?? "gemma3:latest",
    version: deps.version ?? "0.0.1",
  };

  // Infra-wrapped LLM call. On Ollama connection refused, retries once after
  // 500 ms then throws; the throw propagates out of parseContent and the
  // orchestrator enters TOOL_FAILED.
  const callLlm = (systemContent: string) => async (s?: AbortSignal): Promise<string> => {
    const resp = await withInfraRetry(
      () => deps.llm.chat({
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userPrompt },
        ],
        format: "json",
        stream: false,
        signal: s,
      }),
      500,
      s,
    );
    return resp.content?.trim() ?? "";
  };

  const systemContent = prompt.body + SCHEMA_HINT;

  // Step 1 — JSON parse retry.
  // Invalid JSON → 1 retry (budget slot consumed); second failure → parse_failed.
  const jsonResult = await withJsonRetry(
    callLlm(systemContent),
    safeJsonParse,
    b,
    signal,
  );
  if (!jsonResult.ok) {
    return { ok: false, reason: "parse_failed", raw: "" };
  }

  // Step 2 — Schema validation retry.
  // Valid JSON but missing required fields → 1 retry with explicit error feedback
  // appended; second failure → schema_failed.
  let spec = coerceSpec(jsonResult.value, coworkDefaults);
  if (!spec) {
    if (b.consume()) {
      const hint = buildSchemaHint(jsonResult.value);
      const retrySystem = systemContent + `\n\nYour previous response failed validation: ${hint}`;
      const raw2 = await callLlm(retrySystem)(signal);
      const parsed2 = safeJsonParse(raw2);
      if (parsed2 !== null) spec = coerceSpec(parsed2, coworkDefaults);
    }
    if (!spec) return { ok: false, reason: "schema_failed", raw: "" };
  }

  return { ok: true, spec };
}

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildSchemaHint(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "Response was not a JSON object.";
  const r = raw as Record<string, unknown>;
  const missing: string[] = [];
  if (!r.title || typeof r.title !== "string") missing.push("title (required string)");
  if (!r.type) missing.push(`type (must be one of: source, evergreen, project, meeting, person, concept)`);
  if (!r.body_markdown || typeof r.body_markdown !== "string") missing.push("body_markdown (required string)");
  return missing.length > 0
    ? `Missing or invalid required fields: ${missing.join("; ")}.`
    : "One or more field values did not match the required schema.";
}

function composeUserPrompt(text: string, instruction?: string): string {
  if (instruction) {
    return `Instruction: ${instruction}\n\nContent:\n${text}`;
  }
  return text;
}

const SCHEMA_HINT = `

Return ONLY a JSON object with this shape:
{
  "title": string,
  "type": "source"|"evergreen"|"project"|"meeting"|"person"|"concept",
  "tags": string[],
  "aliases": string[],
  "source": "chat-paste"|"pdf"|"webpage"|"image"|"audio"|"manual",
  "entities": string[],
  "related": string[],
  "status": "inbox"|"processed"|"linked"|"archived",
  "summary": string,
  "key_points": string[],
  "body_markdown": string,
  "confidence": "high"|"medium"|"low"
}

Rules:
- "title" is short (≤ 80 chars) and never empty.
- "body_markdown" must NOT contain its own frontmatter block (no leading ---).
- "tags", "aliases", "entities", "related", "key_points" are arrays (use [] if none).
- Default "source" is "chat-paste" unless the input clearly originates elsewhere.
- Default "status" is "inbox".
`;

interface CoworkDefaults {
  runId: string;
  model: string;
  version: string;
}

function coerceSpec(raw: unknown, cowork: CoworkDefaults): NoteSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const title = stringOrNull(r.title);
  const type = enumOr<NoteSpec["type"]>(r.type, [
    "source",
    "evergreen",
    "project",
    "meeting",
    "person",
    "concept",
  ]);
  const source = enumOr<NoteSpec["source"]>(r.source, [
    "chat-paste",
    "pdf",
    "webpage",
    "image",
    "audio",
    "manual",
  ]) ?? "chat-paste";
  const status = enumOr<NoteSpec["status"]>(r.status, [
    "inbox",
    "processed",
    "linked",
    "archived",
  ]) ?? "inbox";
  const body = stringOrNull(r.body_markdown);
  if (!title || !type || !body) return null;
  if (/^---\s*\r?\n/.test(body)) return null;

  const confidence = enumOr<"high" | "medium" | "low">(r.confidence, [
    "high",
    "medium",
    "low",
  ]) ?? "medium";

  return {
    title: title.slice(0, 120),
    type,
    tags: stringList(r.tags),
    aliases: stringList(r.aliases),
    source,
    entities: stringList(r.entities),
    related: stringList(r.related),
    status,
    summary: stringOrNull(r.summary) ?? "",
    key_points: stringList(r.key_points),
    body_markdown: body,
    cowork: {
      source: "ingest",
      run_id: cowork.runId,
      model: cowork.model,
      version: cowork.version,
      confidence,
    },
  };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function enumOr<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : null;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function defaultRunId(): string {
  return crypto.randomUUID();
}
