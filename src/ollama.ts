const OLLAMA_BASE = "http://127.0.0.1:11434";

export type OllamaStatus = "running" | "installed" | "missing";

export async function detectOllama(): Promise<OllamaStatus> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return "running";
  } catch {
    // not reachable — fall through
  }
  return "missing";
}

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) throw new Error("Ollama not reachable");
  const data = await res.json() as { models: { name: string }[] };
  return data.models.map((m) => m.name);
}
