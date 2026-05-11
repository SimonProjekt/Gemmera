import type { LLMReachability } from "./contracts";

export function classifyLLMError(err: unknown, health: LLMReachability): string {
  if (health === "missing") return "Ollama is not running — start Ollama and click Retry.";
  if (err instanceof Error) {
    if (err.message.includes("404") || /model.*not found/i.test(err.message)) {
      return "Model not found — check the model name in settings.";
    }
    return err.message;
  }
  return "An unknown error occurred.";
}
