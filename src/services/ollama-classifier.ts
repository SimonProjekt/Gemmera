import type {
  ClassifierDecision,
  ClassifierService,
  ClassifierThresholds,
  ClassifyOptions,
  IntentLabel,
} from "../contracts/classifier";
import { DEFAULT_THRESHOLDS } from "../contracts/classifier";

const PROMPT_VERSION = "v1.0";
const TIMEOUT_MS = 2000;
const DEFAULT_BASE = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "gemma3:4b";

const SYSTEM_PROMPT = `You are an intent classifier for a personal knowledge-base assistant.

Classify the user's message into exactly one of these four intents:
- capture: The user wants to save content to their knowledge base (e.g. "save this", "add a note", pasting text to store).
- ask: The user wants to retrieve information or get an answer from their knowledge base (e.g. "what did I write about X?", "find my notes on Y").
- mixed: The user wants both — save something AND get an answer in the same turn.
- meta: The user is asking about the app itself, not the knowledge base content (e.g. "how do I use this?", "what can you do?").

Return ONLY a JSON object with exactly three fields:
- "label": one of "capture", "ask", "mixed", "meta"
- "confidence": a float in [0.0, 1.0]
- "rationale": one sentence explaining the classification

Examples:

User: "Save this as my weekly review for last week."
{"label":"capture","confidence":0.95,"rationale":"Explicit request to save content with a named category."}

User: "What do I know about the book Thinking Fast and Slow?"
{"label":"ask","confidence":0.92,"rationale":"Direct question about knowledge base content."}

User: "How do I delete a note?"
{"label":"meta","confidence":0.90,"rationale":"Question about the app's functionality, not vault content."}

User: "Save these meeting notes and tell me what decisions we made last week."
{"label":"mixed","confidence":0.82,"rationale":"Requests both saving new content and querying existing content."}

User: "more detail please"
{"label":"ask","confidence":0.78,"rationale":"Follow-up requesting elaboration, likely continuing a prior query."}

User: "[image.png] add to my design references"
{"label":"capture","confidence":0.91,"rationale":"Attachment with an explicit save instruction."}`;

interface OllamaResponse {
  message?: { content: string };
  done: boolean;
}

interface ClassifierOutput {
  label: string;
  confidence: number;
  rationale: string;
}

const VALID_LABELS = new Set<string>(["capture", "ask", "mixed", "meta"]);

function parseOutput(raw: string): ClassifierOutput | null {
  try {
    const obj = JSON.parse(raw) as Partial<ClassifierOutput>;
    if (
      typeof obj.label === "string" &&
      VALID_LABELS.has(obj.label) &&
      typeof obj.confidence === "number" &&
      obj.confidence >= 0 &&
      obj.confidence <= 1 &&
      typeof obj.rationale === "string"
    ) {
      return { label: obj.label, confidence: obj.confidence, rationale: obj.rationale };
    }
    return null;
  } catch {
    return null;
  }
}

function buildUserContent(opts: ClassifyOptions): string {
  const lines: string[] = [`Message: ${opts.messageText.slice(0, 8000)}`];

  if (opts.attachmentKinds && opts.attachmentKinds.length > 0) {
    lines.push(`Attachments: ${opts.attachmentKinds.join(", ")}`);
  }
  if (opts.activeFileName) {
    const title = opts.activeFileTitle ? ` ("${opts.activeFileTitle}")` : "";
    lines.push(`Active file: ${opts.activeFileName}${title}`);
  }
  if (opts.recentTurns && opts.recentTurns.length > 0) {
    const turns = opts.recentTurns
      .slice(-3)
      .map((t) => `  [${t.label}] ${t.userText.slice(0, 200)}`)
      .join("\n");
    lines.push(`Recent turns:\n${turns}`);
  }

  return lines.join("\n");
}

function makeSkipDecision(label: IntentLabel, skipReason: string): ClassifierDecision {
  return {
    label,
    confidence: 1.0,
    rationale: skipReason,
    source: "skip",
    skipReason,
    latencyMs: 0,
    promptVersion: PROMPT_VERSION,
  };
}

export class OllamaClassifierService implements ClassifierService {
  constructor(
    private readonly thresholds: ClassifierThresholds = DEFAULT_THRESHOLDS,
    private readonly baseUrl: string = DEFAULT_BASE,
  ) {}

  async classify(opts: ClassifyOptions): Promise<ClassifierDecision> {
    const start = Date.now();
    const text = opts.messageText.trim();

    if (!text && (!opts.attachmentKinds || opts.attachmentKinds.length === 0)) {
      return makeSkipDecision("ask", "empty");
    }
    if (text.startsWith("?")) {
      return makeSkipDecision("ask", "leading-question-mark");
    }
    if (opts.attachmentKinds && opts.attachmentKinds.length > 0 && !text) {
      return makeSkipDecision("capture", "attachment-only");
    }

    const model = opts.model ?? DEFAULT_MODEL;
    const userContent = buildUserContent(opts);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const raw = await this.callOllama(model, userContent, controller.signal);
        clearTimeout(tid);
        const parsed = parseOutput(raw);
        if (parsed) {
          return {
            label: parsed.label as IntentLabel,
            confidence: parsed.confidence,
            rationale: parsed.rationale,
            source: "llm",
            latencyMs: Date.now() - start,
            promptVersion: PROMPT_VERSION,
          };
        }
        lastError = new Error("Invalid classifier output shape");
      } catch (err) {
        clearTimeout(tid);
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError.name === "AbortError") break; // timeout — don't retry
      }
    }

    // Fallback: route to ask silently — caller must NOT show disambiguation chip
    return {
      label: "ask",
      confidence: 0,
      rationale: lastError?.message ?? "Classifier failed",
      source: "llm",
      latencyMs: Date.now() - start,
      promptVersion: PROMPT_VERSION,
      failed: true,
    };
  }

  private async callOllama(model: string, userContent: string, signal: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        stream: false,
        format: "json",
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama classifier error: ${res.status}`);
    const data = (await res.json()) as OllamaResponse;
    return data.message?.content ?? "";
  }
}
