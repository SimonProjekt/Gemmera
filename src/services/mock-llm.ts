import type {
  ChatMessage,
  ChatOptions,
  LLMReachability,
  LLMResponse,
  LLMService,
  LLMToolCall,
} from "../contracts";

export interface ScriptedReply {
  match: (lastUserMessage: string, history: ChatMessage[]) => boolean;
  content: string;
  toolCalls?: LLMToolCall[];
}

const DEFAULT_SCRIPT: ScriptedReply[] = [
  {
    match: (text) => /create|skapa/i.test(text),
    content: "",
    toolCalls: [
      {
        id: "mock-1",
        name: "save_note",
        arguments: { path: "Notes/Mock.md", content: "Mock note body." },
      },
    ],
  },
  {
    match: (text) => /search|sök/i.test(text),
    content: "Här är vad jag hittade i din vault (mock).",
  },
  {
    match: () => true,
    content: "Hej! Detta är ett mock-svar.",
  },
];

export class MockLLMService implements LLMService {
  constructor(private readonly script: ScriptedReply[] = DEFAULT_SCRIPT) {}

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
    const reply =
      this.script.find((r) => r.match(lastUser?.content ?? "", opts.messages)) ??
      this.script[this.script.length - 1];

    if (reply.content && opts.onToken) {
      for (const token of tokenize(reply.content)) {
        if (opts.signal?.aborted) break;
        opts.onToken(token);
      }
    }

    return { content: reply.content, toolCalls: reply.toolCalls };
  }
}

function tokenize(text: string): string[] {
  // Split into word-ish tokens preserving whitespace, so callers can verify
  // accumulation == full content.
  return text.match(/\S+\s*|\s+/g) ?? [text];
}
