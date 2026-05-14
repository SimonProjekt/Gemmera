import { describe, expect, it, vi } from "vitest";
import { createLLMService } from "./index";
import { MockLLMService } from "./mock-llm";
import { OllamaLLMService } from "./ollama-llm";

vi.mock("obsidian", () => ({ Notice: vi.fn() }));

describe("createLLMService", () => {
  it("returns MockLLMService when backend is 'mock'", async () => {
    const svc = await createLLMService("mock");
    expect(svc).toBeInstanceOf(MockLLMService);
  });

  it("returns OllamaLLMService when Ollama is reachable", async () => {
    vi.spyOn(OllamaLLMService.prototype, "isReachable").mockResolvedValueOnce("running");
    const svc = await createLLMService("ollama");
    expect(svc).toBeInstanceOf(OllamaLLMService);
  });

  it("falls back to MockLLMService and shows a Notice when Ollama is unreachable", async () => {
    const { Notice } = await import("obsidian");
    vi.spyOn(OllamaLLMService.prototype, "isReachable").mockResolvedValueOnce("missing");
    const svc = await createLLMService("ollama");
    expect(svc).toBeInstanceOf(MockLLMService);
    expect(Notice).toHaveBeenCalledOnce();
  });
});
