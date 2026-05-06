import type { LLMService, NoteSpec, PromptLoader } from "../contracts";

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
 */
export async function parseContent(
  text: string,
  instruction: string | undefined,
  deps: IngestParserDeps,
  signal?: AbortSignal,
): Promise<ParseResult> {
  if (!text.trim()) return { ok: false, reason: "empty", raw: "" };

  const prompt = await deps.promptLoader.load("ingest-parser");
  const userPrompt = composeUserPrompt(text, instruction);

  const response = await deps.llm.chat({
    messages: [
      { role: "system", content: prompt.body + SCHEMA_HINT },
      { role: "user", content: userPrompt },
    ],
    format: "json",
    stream: false,
    signal,
  });

  const raw = response.content?.trim() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "parse_failed", raw };
  }

  const spec = coerceSpec(parsed, {
    runId: (deps.runId ?? defaultRunId)(),
    model: deps.model ?? "gemma3:latest",
    version: deps.version ?? "0.0.1",
  });
  if (!spec) return { ok: false, reason: "schema_failed", raw };

  return { ok: true, spec };
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
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `run_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}
