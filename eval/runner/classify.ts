#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntentLabel } from "../../src/contracts/classifier";
import { MockClassifierService } from "../../src/services/mock-classifier";
import { OllamaClassifierService } from "../../src/services/ollama-classifier";
import { loadGoldenSet, toClassifyOptions } from "../classifier-golden/loader";

const LABELS: IntentLabel[] = ["capture", "ask", "mixed", "meta"];

// ── CLI args ──────────────────────────────────────────────────────────────────

const useMock = process.argv.includes("--mock");
const modelArg = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1];
const model = modelArg ?? "gemma3:latest";

// ── Types ─────────────────────────────────────────────────────────────────────

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
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const svc = useMock ? new MockClassifierService() : new OllamaClassifierService();
  const examples = loadGoldenSet();

  console.log(`\nClassifier eval — ${examples.length} examples, model: ${useMock ? "mock" : model}\n`);

  const results: Result[] = [];

  for (const ex of examples) {
    process.stdout.write(`  ${ex.id} … `);
    const decision = await svc.classify(toClassifyOptions(ex, model));
    const passed = decision.label === ex.expectedLabel;
    results.push({
      id: ex.id,
      expected: ex.expectedLabel,
      actual: decision.label,
      confidence: decision.confidence,
      latencyMs: decision.latencyMs,
      passed,
      notes: ex.notes,
      rationale: decision.rationale,
      source: decision.source,
    });
    console.log(passed ? `✓ ${decision.label}` : `✗ got ${decision.label}, expected ${ex.expectedLabel}`);
  }

  report(results);
}

// ── Metrics + report ──────────────────────────────────────────────────────────

function report(results: Result[]): void {
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;

  // confusion[actual][expected]
  const confusion: Record<IntentLabel, Record<IntentLabel, number>> = {
    capture: { capture: 0, ask: 0, mixed: 0, meta: 0 },
    ask:     { capture: 0, ask: 0, mixed: 0, meta: 0 },
    mixed:   { capture: 0, ask: 0, mixed: 0, meta: 0 },
    meta:    { capture: 0, ask: 0, mixed: 0, meta: 0 },
  };
  for (const r of results) confusion[r.actual][r.expected]++;

  function precision(label: IntentLabel): number {
    const tp = confusion[label][label];
    const denom = LABELS.reduce((s, l) => s + confusion[label][l], 0);
    return denom === 0 ? 0 : tp / denom;
  }

  function recall(label: IntentLabel): number {
    const tp = confusion[label][label];
    const denom = LABELS.reduce((s, l) => s + confusion[l][label], 0);
    return denom === 0 ? 0 : tp / denom;
  }

  function f1(label: IntentLabel): number {
    const p = precision(label);
    const r = recall(label);
    return p + r === 0 ? 0 : (2 * p * r) / (p + r);
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  function percentile(p: number): number {
    const idx = Math.ceil((p / 100) * latencies.length) - 1;
    return latencies[Math.max(0, idx)];
  }

  function pct(n: number): string {
    return `${Math.round(n * 100)}%`;
  }

  const failures = results.filter((r) => !r.passed);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(__dirname, "..", "runs", ts);
  mkdirSync(outDir, { recursive: true });

  // Markdown
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
        `| ${actual.padEnd(9)} | ${LABELS.map((expected) => String(confusion[actual][expected]).padEnd(7)).join(" | ")} |`,
    ),
    "",
    "## Per-class metrics",
    "",
    `| Class   | Precision | Recall | F1   |`,
    `|---------|-----------|--------|------|`,
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

  // JSON
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

  console.log(`\nResults → ${outDir}/`);
  console.log(`Accuracy: ${passedCount}/${total} (${pct(passedCount / total)})`);
  console.log(`P50: ${percentile(50)}ms  P95: ${percentile(95)}ms`);
  if (failures.length > 0) {
    console.log(`\nFailures (${failures.length}):`);
    for (const r of failures) {
      console.log(`  ${r.id}: expected ${r.expected}, got ${r.actual} — "${r.notes ?? r.rationale}"`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
