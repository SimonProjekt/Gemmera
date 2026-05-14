import type { NoteSpec } from "../contracts";
import type { IngestWriter } from "./ingest-writer";

export interface SynthesisInput {
  question: string;
  answer: string;
  citations: string[];
  model: string;
  runId: string;
  version?: string;
}

export interface SynthesisOptions {
  folder?: string;
  now?: () => number;
}

/**
 * Writes a "synthesis" note produced by the query tool loop (#14). The note
 * uses the same frontmatter contract as ingest output (planning/rag.md
 * §"Frontmatter contract") but stamps `cowork.source: "synthesis"` so it can
 * be distinguished from ingest-authored notes.
 *
 * Citation paths are preserved as wikilinks in a `## Sources` section and
 * also written to `related` so the link-graph indexer picks them up.
 */
export async function createSynthesisNote(
  input: SynthesisInput,
  writer: IngestWriter,
  opts: SynthesisOptions = {},
): Promise<{ path: string; spec: NoteSpec }> {
  const spec = buildSynthesisSpec(input);
  const { path } = await writer.writeNew(spec, {
    folder: opts.folder,
    now: opts.now,
  });
  return { path, spec };
}

export function buildSynthesisSpec(input: SynthesisInput): NoteSpec {
  const title = deriveTitle(input.question);
  const body = composeBody(input.question, input.answer, input.citations);
  return {
    title,
    type: "evergreen",
    tags: ["synthesis"],
    aliases: [],
    source: "manual",
    entities: [],
    related: [...input.citations],
    status: "inbox",
    summary: input.question,
    key_points: [],
    body_markdown: body,
    cowork: {
      source: "synthesis",
      run_id: input.runId,
      model: input.model,
      version: input.version ?? "0.0.1",
      confidence: "medium",
    },
  };
}

function deriveTitle(question: string): string {
  const cleaned = question.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Synthesis";
  const stripped = cleaned.replace(/[?!.]+$/, "");
  return stripped.length > 80 ? `${stripped.slice(0, 77)}...` : stripped;
}

function composeBody(question: string, answer: string, citations: string[]): string {
  const parts = [`## Question`, "", question, "", `## Answer`, "", answer];
  if (citations.length > 0) {
    parts.push("", `## Sources`, "");
    for (const path of citations) {
      const display = path.replace(/\.md$/, "");
      parts.push(`- [[${display}]]`);
    }
  }
  return parts.join("\n");
}
