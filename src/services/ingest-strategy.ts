import { createHash } from "node:crypto";
import type {
  IngestStrategy,
  IngestionStore,
  LLMService,
  NoteSpec,
  PromptLoader,
  RetrievalHit,
  Retriever,
} from "../contracts";

export interface IngestStrategyDeps {
  llm: LLMService;
  promptLoader: PromptLoader;
  retriever: Retriever;
  store: IngestionStore;
  /** Cosine / fused-score above which we treat a candidate as a near-dupe. */
  dedupThreshold?: number;
  /** topK passed to retriever. Defaults to 5. */
  topK?: number;
}

const DEFAULT_DEDUP_THRESHOLD = 0.85;

/**
 * Decide whether the candidate becomes a new note, an append, or asks the
 * user about deduplication.
 *
 * Order of decisions:
 *   1. Deterministic: if any chunk in the store has the same content hash
 *      as the candidate body, return `dedup_ask` for that chunk's note.
 *      No LLM call needed — the answer is binary.
 *   2. Retrieve top-k similar; if no hits, return `create`.
 *   3. If the top hit's score exceeds the dedup threshold, return
 *      `dedup_ask` with that note as target.
 *   4. Otherwise consult the LLM (`dedup-decider` prompt) for a fuzzy
 *      decision among `new`, `append`, `ask_user`. The LLM call is the
 *      heaviest path; for v1 we keep the schema permissive and fall back
 *      to `create` on any parse failure.
 */
export async function decideStrategy(
  spec: NoteSpec,
  deps: IngestStrategyDeps,
  signal?: AbortSignal,
): Promise<{ strategy: IngestStrategy; topHits: RetrievalHit[] }> {
  const threshold = deps.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
  const topK = deps.topK ?? 5;

  // 1. Exact-hash dedup short-circuit. The pipeline stores `bodyHash =
  //    sha256(body_after_frontmatter_strip)` per note, so hashing the
  //    candidate body the same way matches existing notes whose body is
  //    byte-identical regardless of frontmatter or chunk boundaries.
  const bodyHash = sha256(spec.body_markdown);
  const exactMatches = await deps.store.findByBodyHash(bodyHash);
  if (exactMatches.length > 0) {
    return {
      strategy: { kind: "dedup_ask", target: exactMatches[0], similarity: 1 },
      topHits: [],
    };
  }

  // 2. Retrieve top-k similar.
  const query = `${spec.title}\n\n${spec.summary}\n\n${spec.body_markdown.slice(0, 2000)}`;
  let hits: RetrievalHit[] = [];
  try {
    hits = await deps.retriever.retrieve(query, { topK });
  } catch {
    // Empty index or retriever transport error — treat as cold vault.
    hits = [];
  }

  if (hits.length === 0) {
    return { strategy: { kind: "create", related: spec.related }, topHits: [] };
  }

  // 3. Threshold-based dedup_ask.
  const top = hits[0];
  if (top.score >= threshold) {
    return {
      strategy: { kind: "dedup_ask", target: top.path, similarity: top.score },
      topHits: hits,
    };
  }

  // 4. LLM-driven fuzzy decision. Permissive parsing — anything off-schema
  //    falls back to `create` so a flaky model can't block ingestion.
  const llmDecision = await consultLlm(spec, hits, deps, signal);
  if (llmDecision) return { strategy: llmDecision, topHits: hits };

  // Default: create with related links populated from top hits.
  const related = unique([...spec.related, ...hits.slice(0, 3).map((h) => h.path)]);
  return { strategy: { kind: "create", related }, topHits: hits };
}

async function consultLlm(
  spec: NoteSpec,
  hits: RetrievalHit[],
  deps: IngestStrategyDeps,
  signal?: AbortSignal,
): Promise<IngestStrategy | null> {
  let promptBody = "";
  try {
    const loaded = await deps.promptLoader.load("dedup-decider");
    promptBody = loaded.body;
  } catch {
    // Prompt missing — skip LLM step.
    return null;
  }

  const userPrompt = JSON.stringify(
    {
      candidate: {
        title: spec.title,
        summary: spec.summary,
        type: spec.type,
        tags: spec.tags,
      },
      similar: hits.slice(0, 5).map((h) => ({
        path: h.path,
        title: h.title,
        score: h.score,
        snippet: h.text.slice(0, 400),
      })),
    },
    null,
    2,
  );

  let raw = "";
  try {
    const response = await deps.llm.chat({
      messages: [
        { role: "system", content: promptBody + STRATEGY_HINT },
        { role: "user", content: userPrompt },
      ],
      format: "json",
      stream: false,
      signal,
    });
    raw = response.content?.trim() ?? "";
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return interpret(parsed, hits, spec);
}

const STRATEGY_HINT = `

Return ONLY a JSON object with this shape:
{ "strategy": "new" | "append" | "ask_user", "targetPath"?: string, "reason": string }

Rules:
- "new" when the candidate is genuinely distinct from the similar notes.
- "append" only when one similar note clearly belongs as the parent and the
  candidate would naturally extend it. Provide its path in "targetPath".
- "ask_user" when there's a near-duplicate but you're not sure whether to
  append or branch off. Provide the closest match in "targetPath".
`;

function interpret(
  raw: unknown,
  hits: RetrievalHit[],
  spec: NoteSpec,
): IngestStrategy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const strategy = r.strategy;
  const target = typeof r.targetPath === "string" ? r.targetPath : undefined;

  if (strategy === "append" && target) return { kind: "append", target };
  if (strategy === "ask_user" && target) {
    const score = hits.find((h) => h.path === target)?.score ?? 0;
    return { kind: "dedup_ask", target, similarity: score };
  }
  if (strategy === "new") {
    const related = unique([...spec.related, ...hits.slice(0, 3).map((h) => h.path)]);
    return { kind: "create", related };
  }
  return null;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
