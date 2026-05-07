export type IntentLabel = "capture" | "ask" | "mixed" | "meta";

export interface ClassifierDecision {
  label: IntentLabel;
  confidence: number;
  rationale: string;
  source: "llm" | "skip";
  skipReason?: string;
  latencyMs: number;
  promptVersion: string;
}

export interface ClassifyOptions {
  messageText: string;
  model?: string;
  attachmentKinds?: string[];
  activeFileName?: string;
  activeFileTitle?: string;
  recentTurns?: Array<{ userText: string; label: IntentLabel }>;
}

export interface ClassifierThresholds {
  ask: number;
  capture: number;
  mixed: number;
  meta: number;
}

export const DEFAULT_THRESHOLDS: ClassifierThresholds = {
  ask: 0.70,
  capture: 0.85,
  mixed: 0.75,
  meta: 0.70,
};

export interface ClassifierService {
  classify(opts: ClassifyOptions): Promise<ClassifierDecision>;
}
