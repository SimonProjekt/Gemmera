import type {
  ClassifierDecision,
  ClassifierService,
  ClassifyOptions,
  IntentLabel,
} from "../contracts/classifier";

export interface ScriptedClassification {
  match: (text: string) => boolean;
  label: IntentLabel;
  confidence: number;
  rationale: string;
}

const DEFAULT_SCRIPT: ScriptedClassification[] = [
  {
    match: (t) => t.startsWith("?"),
    label: "ask",
    confidence: 1.0,
    rationale: "Leading question mark prefix.",
  },
  {
    match: (t) => /spara|save|lagra|anteckna/i.test(t),
    label: "capture",
    confidence: 0.90,
    rationale: "Message contains explicit save keyword.",
  },
  {
    match: (t) => /hur|hjälp|vad kan|how|help|what can/i.test(t),
    label: "meta",
    confidence: 0.85,
    rationale: "Message appears to be about the app itself.",
  },
  {
    match: () => true,
    label: "ask",
    confidence: 0.80,
    rationale: "Default: treating as a question.",
  },
];

export class MockClassifierService implements ClassifierService {
  constructor(private readonly script: ScriptedClassification[] = DEFAULT_SCRIPT) {}

  async classify(opts: ClassifyOptions): Promise<ClassifierDecision> {
    const text = opts.messageText.trim();
    const entry = this.script.find((s) => s.match(text)) ?? this.script[this.script.length - 1];
    return {
      label: entry.label,
      confidence: entry.confidence,
      rationale: entry.rationale,
      source: "llm",
      latencyMs: 0,
      promptVersion: "mock",
    };
  }
}
