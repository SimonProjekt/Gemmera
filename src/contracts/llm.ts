export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls?: LLMToolCall[];
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  tools?: Tool[];
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export type LLMReachability = "running" | "missing";

export interface LLMService {
  chat(opts: ChatOptions): Promise<LLMResponse>;
  isReachable(): Promise<LLMReachability>;
  listModels(): Promise<string[]>;
  pickDefaultModel(): Promise<string>;
}
