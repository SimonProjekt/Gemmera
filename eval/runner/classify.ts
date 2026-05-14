#!/usr/bin/env tsx
/**
 * Classifier eval runner — drives dev's `classifyTurn` orchestrator
 * against the hand-labeled golden set, emits a confusion matrix +
 * per-class P/R/F1 + P50/P95 latency, and (optionally) gates against
 * a committed baseline JSON.
 *
 * Modes:
 *   --mock              In-process scripted LLM, no network.  Used in CI.
 *   (default)           Real `OllamaLLMService` against a live daemon.
 *   --model=<tag>       Override the chat-model tag (live mode only).
 *   --compare <path>    Compare against a baseline JSON; non-zero exit
 *                       on a P0 regression (rise in ask→capture FPR).
 *   --save-baseline <p> Write the run's headline metrics to <path>.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ClassifierEventWriter,
  ClassifierDecisionRow,
  ClassifierDisambiguationRow,
  IntentLabel,
} from "../../src/contracts/classifier";
import type {
  ChatOptions,
  LLMReachability,
  LLMResponse,
  LLMService,
} from "../../src/contracts/llm";
import { FilePromptLoader } from "../../src/services/file-prompt-loader";
import { OllamaLLMService } from "../../src/services/ollama-llm";
import { classifyTurn } from "../../src/services/classifier-orchestrator";
import { loadGoldenSet, toClassifyTurnInput } from "../classifier-golden/loader";

const LABELS: IntentLabel[] = ["capture", "ask", "mixed", "meta"];

// ─── CLI args ─────────────────────────────────────────────────────────

const useMock = process.argv.includes("--mock");
const modelArg = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1];
const model = modelArg ?? "gemma4:e4b";

function flagValue(flag: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
  if (eq) return eq;
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const compareArg = flagValue("--compare");
const saveBaselineArg = flagValue("--save-baseline");

// ─── Mock LLM ─────────────────────────────────────────────────────────

/**
 * Tiny scripted `LLMService` used by `--mock`.  Inspects the user message
 * the orchestrator hands to `chat()` and emits a fixed JSON classifier
 * payload.  The orchestrator rejects unparseable / out-of-taxonomy
 * outputs, so we always emit valid JSON.
 *
 * The keyword routing here mirrors the heuristic the previous PR
 * shipped as `MockClassifierService`; the difference is that this mock
 * goes through the *real* orchestrator pipeline (skip router → LLM →
 * retries → thresholds → events), giving CI real-pipeline coverage.
 */
class ScriptedClassifierLLM implements LLMService {
  async isReachable(): Promise<LLMReachability> {
    return "running";
  }
  async listModels(): Promise<string[]> {
    return ["mock:latest"];
  }
  async pickDefaultModel(): Promise<string> {
    return "mock:latest";
  }

  async chat(opts: ChatOptions): Promise<LLMResponse> {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
    const promptBody = lastUser?.content ?? "";

    // The classifier prompt template is mostly few-shot prose. The actual
    // turn-under-classification is everything after the "## Current input"
    // header up to the next blank-blank gap; pattern-matching across the
    // whole prompt body would always trip on the few-shot keywords.
    const text = extractCurrentInput(promptBody);

    let label: IntentLabel = "ask";
    let confidence = 0.78;
    let rationale = "Default: treating as a question.";

    const saveVerb = String.raw`(?:spara|save|lagra|store|capture|anteckna|notera|skriv ner|arkivera|lägg\s+(?:till|in)|add|put|create.*note)`;
    const retrieveVerb = String.raw`(?:berätta|tell|find|hitta|sök|search|show|visa|sammanfatta|summari[sz]e|relaterade|related|ge mig|give me|översikt|overview|vad jag vet|what i know)`;
    const isMixed =
      new RegExp(`\\b${saveVerb}\\b[\\s\\S]*\\b(?:och|and|also)\\b[\\s\\S]*\\b${retrieveVerb}\\b`, "i").test(text) ||
      new RegExp(`\\b${retrieveVerb}\\b[\\s\\S]*\\b(?:och|and|also)\\b[\\s\\S]*\\b${saveVerb}\\b`, "i").test(text);

    if (isMixed) {
      label = "mixed";
      confidence = 0.82;
      rationale = "Save-and-retrieve in one message.";
    } else if (
      /\b(hur (gör|fungerar|använder|byter|ändrar|raderar)|hjälp|hjälpa|vad kan du|vilka kommandon|inställning(ar)?|skillnaden mellan|hur fungerar sökningen|how (do|can) i|what can you|help|help me|settings?|configure|delete a note|difference between)\b/i.test(
        text,
      )
    ) {
      label = "meta";
      confidence = 0.88;
      rationale = "Question about the app itself.";
    } else if (
      /\b(spara|save|lagra|anteckna|notera|skriv ner|arkivera|lägg\s+(till|in)|skapa.*anteckning|create.*note|store|capture)\b/i.test(
        text,
      )
    ) {
      label = "capture";
      confidence = 0.9;
      rationale = "Explicit save / capture keyword.";
    } else if (
      /\b(vad|hur|när|var|vem|varför|berätta|sök|hitta|visa|recap|what|how|when|where|who|why|tell me|find|show|recall|search|list)\b/i.test(
        text,
      ) ||
      /\?$/.test(text)
    ) {
      label = "ask";
      confidence = 0.82;
      rationale = "Question or retrieval phrasing.";
    }

    return { content: JSON.stringify({ label, confidence, rationale }) };
  }
}

function extractCurrentInput(promptBody: string): string {
  const marker = "## Current input";
  const i = promptBody.indexOf(marker);
  const rest = i >= 0 ? promptBody.slice(i + marker.length) : promptBody;
  const m = rest.match(/Message:\s*([\s\S]*?)(?:\n\s*\n|$)/);
  return (m?.[1] ?? rest).trim();
}

// ─── No-op event writer ───────────────────────────────────────────────

class NoopEventWriter implements ClassifierEventWriter {
  async writeDecision(_row: ClassifierDecisionRow): Promise<void> {}
  async writeDisambiguation(_row: ClassifierDisambiguationRow): Promise<void> {}
}

// ─── Result row ───────────────────────────────────────────────────────

interface Result {
  id: string;
  expected: IntentLabel;
  actual: IntentLabel;
  confidence: number;
  latencyMs: number;
  passed: boolean;
  notes?: string;
  rationale: string;
  source: string;
  needsDisambiguation: boolean;
  fallback: boolean;
}

// ─── Runner ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const llm: LLMService = useMock ? new ScriptedClassifierLLM() : new OllamaLLMService();
  const promptLoader = new FilePromptLoader(resolve(__dirname, "..", "..", "prompts"));
  const eventWriter = new NoopEventWriter();

  const examples = loadGoldenSet();
  console.log(
    `\nClassifier eval — ${examples.length} examples, model: ${useMock ? "mock" : model}\n`,
  );

  const results: Result[] = [];

  for (const ex of examples) {
    process.stdout.write(`  ${ex.id} … `);
    const input = toClassifyTurnInput(ex);
    const route = await classifyTurn(
      input,
      { llm, promptLoader, eventWriter },
      `eval-${ex.id}`,
    );

    // Empty-message / null-label decisions count as a fail against the
    // expected label; the golden set has no empty-message cases today,
    // but encode the behaviour defensively.
    const actual: IntentLabel = route.label ?? "ask";
    const passed = route.label === ex.expectedLabel;

    const out = route.decision.output;
    results.push({
      id: ex.id,
      expected: ex.expectedLabel,
      actual,
      confidence: out?.confidence ?? (route.decision.source === "skip" ? 1 : 0),
      latencyMs: route.decision.latencyMs,
      passed,
      notes: ex.notes,
      rationale: out?.rationale ?? route.decision.skipReason ?? "(no rationale)",
      source: route.decision.source,
      needsDisambiguation: route.needsDisambiguation,
      fallback: route.decision.fallbackReason !== null,
    });
    console.log(passed ? `✓ ${actual}` : `✗ got ${actual}, expected ${ex.expectedLabel}`);
  }

  report(results);
}

// ─── Metrics + report ─────────────────────────────────────────────────

function report(results: Result[]): void {
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;

  // confusion[predicted][expected]
  const confusion: Record<IntentLabel, Record<IntentLabel, number>> = {
    capture: { capture: 0, ask: 0, mixed: 0, meta: 0 },
    ask:     { capture: 0, ask: 0, mixed: 0, meta: 0 },
    mixed:   { capture: 0, ask: 0, mixed: 0, meta: 0 },
    meta:    { capture: 0, ask: 0, mixed: 0, meta: 0 },
  };
  for (const r of results) confusion[r.actual][r.expected]++;

  const precision = (label: IntentLabel): number => {
    const tp = confusion[label][label];
    const denom = LABELS.reduce((s, l) => s + confusion[label][l], 0);
    return denom === 0 ? 0 : tp / denom;
  };
  const recall = (label: IntentLabel): number => {
    const tp = confusion[label][label];
    const denom = LABELS.reduce((s, l) => s + confusion[l][label], 0);
    return denom === 0 ? 0 : tp / denom;
  };
  const f1 = (label: IntentLabel): number => {
    const p = precision(label);
    const r = recall(label);
    return p + r === 0 ? 0 : (2 * p * r) / (p + r);
  };

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const idx = Math.ceil((p / 100) * latencies.length) - 1;
    return latencies[Math.max(0, idx)];
  };

  const pct = (n: number): string => `${Math.round(n * 100)}%`;

  const failures = results.filter((r) => !r.passed);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(__dirname, "..", "runs", ts);
  mkdirSync(outDir, { recursive: true });

  const md: string[] = [
    `# Classifier Eval — ${new Date().toISOString()}`,
    "",
    `**Model:** ${useMock ? "mock" : model}  `,
    `**Examples:** ${total}  `,
    `**Passed:** ${passedCount} / ${total} (${pct(passedCount / total)})`,
    "",
    "## Confusion matrix",
    "",
    "Rows = predicted, columns = expected.",
    "",
    `|           | ${LABELS.map((l) => l.padEnd(7)).join(" | ")} |`,
    `|-----------|${LABELS.map(() => "---------").join("|")}|`,
    ...LABELS.map(
      (actual) =>
        `| ${actual.padEnd(9)} | ${LABELS.map((expected) =>
          String(confusion[actual][expected]).padEnd(7),
        ).join(" | ")} |`,
    ),
    "",
    "## Per-class metrics",
    "",
    "| Class   | Precision | Recall | F1   |",
    "|---------|-----------|--------|------|",
    ...LABELS.map(
      (l) =>
        `| ${l.padEnd(7)} | ${pct(precision(l)).padEnd(9)} | ${pct(recall(l)).padEnd(6)} | ${pct(f1(l)).padEnd(4)} |`,
    ),
    "",
    "## Latency",
    "",
    `- P50: ${percentile(50)}ms`,
    `- P95: ${percentile(95)}ms`,
    `- Min: ${latencies[0]}ms`,
    `- Max: ${latencies[latencies.length - 1]}ms`,
  ];

  if (failures.length > 0) {
    md.push("", "## Failures", "");
    for (const r of failures) {
      md.push(
        `**${r.id}** — expected \`${r.expected}\`, got \`${r.actual}\` (${pct(r.confidence)})  `,
        `> ${r.rationale}`,
        r.notes ? `> *${r.notes}*` : "",
        "",
      );
    }
  }

  const totalAsk = results.filter((r) => r.expected === "ask").length;
  const askCaptureFalsePositives = confusion["capture"]["ask"];
  const askCaptureFpr = totalAsk === 0 ? 0 : askCaptureFalsePositives / totalAsk;

  const json = {
    timestamp: new Date().toISOString(),
    model: useMock ? "mock" : model,
    total,
    passed: passedCount,
    accuracy: passedCount / total,
    confusion,
    perClass: Object.fromEntries(
      LABELS.map((l) => [l, { precision: precision(l), recall: recall(l), f1: f1(l) }]),
    ),
    latency: {
      p50: percentile(50),
      p95: percentile(95),
      min: latencies[0],
      max: latencies[latencies.length - 1],
    },
    derived: { totalAsk, askCaptureFalsePositives, askCaptureFpr },
    failures: failures.map((r) => ({
      id: r.id,
      expected: r.expected,
      actual: r.actual,
      confidence: r.confidence,
      rationale: r.rationale,
      notes: r.notes,
    })),
    results,
  };

  writeFileSync(join(outDir, "report.md"), md.join("\n"));
  writeFileSync(join(outDir, "report.json"), JSON.stringify(json, null, 2));

  if (saveBaselineArg) {
    const baseline = {
      _comment:
        "Committed mock-classifier baseline. Regenerate with: npm run eval:classifier:mock -- --save-baseline eval/classifier-golden/baseline-mock.json",
      model: useMock ? "mock" : model,
      generatedAt: new Date().toISOString(),
      totalExamples: total,
      totalAsk,
      askCaptureFalsePositives,
      askCaptureFpr,
      accuracy: passedCount / total,
      capturePrecision: precision("capture"),
      captureRecall: recall("capture"),
    };
    writeFileSync(resolve(saveBaselineArg), JSON.stringify(baseline, null, 2));
    console.log(`\nBaseline saved → ${saveBaselineArg}`);
  }

  console.log(`\nResults → ${outDir}/`);
  console.log(`Accuracy: ${passedCount}/${total} (${pct(passedCount / total)})`);
  console.log(`P50: ${percentile(50)}ms  P95: ${percentile(95)}ms`);
  if (failures.length > 0) {
    console.log(`\nFailures (${failures.length}):`);
    for (const r of failures) {
      console.log(
        `  ${r.id}: expected ${r.expected}, got ${r.actual} — "${r.notes ?? r.rationale}"`,
      );
    }
  }

  if (compareArg) {
    const baseline = JSON.parse(readFileSync(resolve(compareArg), "utf-8")) as {
      askCaptureFpr: number;
      accuracy: number;
    };

    let p0 = false;
    if (askCaptureFpr > baseline.askCaptureFpr) {
      console.error(
        `\n[P0 REGRESSION] ask→capture false-positive rate rose: ${pct(baseline.askCaptureFpr)} → ${pct(askCaptureFpr)}`,
      );
      p0 = true;
    }

    const accuracyDrop = baseline.accuracy - passedCount / total;
    if (accuracyDrop > 0.05) {
      console.warn(
        `\n[P1 REGRESSION] Overall accuracy dropped ${pct(accuracyDrop)} vs baseline (${pct(baseline.accuracy)} → ${pct(passedCount / total)})`,
      );
    }

    if (!p0) {
      console.log("\n✓ No P0 regressions detected.");
    } else {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
