const OLLAMA_BASE = "http://127.0.0.1:11434";

export type OllamaStatus = "running" | "installed" | "missing";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

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

export async function pickGemmaModel(): Promise<string> {
  const models = await listModels();
  const gemma = models.find((m) => m.startsWith("gemma"));
  return gemma ?? "gemma3:latest";
}

export async function chat(
  model: string,
  history: Message[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: history, stream: true }),
    signal,
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as { message?: { content: string }; done: boolean };
      if (chunk.message?.content) {
        full += chunk.message.content;
        onToken(chunk.message.content);
      }
    }
  }

  return full;
}
