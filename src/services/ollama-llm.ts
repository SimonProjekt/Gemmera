import type {
  ChatMessage,
  ChatOptions,
  LLMReachability,
  LLMResponse,
  LLMService,
} from "../contracts";

const DEFAULT_BASE = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "gemma3:latest";

interface OllamaChunk {
  message?: { content: string };
  done: boolean;
}

export class OllamaLLMService implements LLMService {
  constructor(private readonly baseUrl: string = DEFAULT_BASE) {}

  async isReachable(): Promise<LLMReachability> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok ? "running" : "missing";
    } catch {
      return "missing";
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error("Ollama not reachable");
    const data = (await res.json()) as { models: { name: string }[] };
    return data.models.map((m) => m.name);
  }

  async pickDefaultModel(): Promise<string> {
    try {
      const models = await this.listModels();
      return models.find((m) => m.startsWith("gemma")) ?? DEFAULT_MODEL;
    } catch {
      return DEFAULT_MODEL;
    }
  }

  async chat(opts: ChatOptions): Promise<LLMResponse> {
    const { messages, model = DEFAULT_MODEL, onToken, signal } = opts;
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: messages.map(toOllamaMessage),
        stream: true,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineAt: number;
      while ((newlineAt = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as OllamaChunk;
        const token = chunk.message?.content ?? "";
        if (token) {
          full += token;
          onToken?.(token);
        }
      }
    }

    return { content: full };
  }
}

function toOllamaMessage(msg: ChatMessage): { role: string; content: string } {
  // Ollama only accepts user/assistant/system; collapse tool messages to user.
  const role = msg.role === "tool" ? "user" : msg.role;
  return { role, content: msg.content };
}
