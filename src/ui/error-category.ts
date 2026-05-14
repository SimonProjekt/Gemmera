export type ErrorCategory = "ollama_down" | "timeout" | "model_missing" | "unknown";

export function categorizeError(err: unknown): ErrorCategory {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  if (msg.includes("timeout")) return "timeout";
  if (msg.includes("econnrefused") || msg.includes("failed to fetch") || msg.includes("network error")) {
    return "ollama_down";
  }
  if (msg.includes("not found") || msg.includes("pull model") || msg.includes("no such model")) {
    return "model_missing";
  }
  return "unknown";
}

export function userMessageForCategory(category: ErrorCategory, rawMessage: string): string {
  switch (category) {
    case "ollama_down": return "Ollama is not responding. Make sure Ollama is running and try again.";
    case "timeout": return "The request timed out. Please try again.";
    case "model_missing": return "Model not found. Check your Ollama installation.";
    default: return `Something went wrong: ${rawMessage}`;
  }
}
