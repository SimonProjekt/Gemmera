import { describe, expect, it } from "vitest";
import { classifyLLMError } from "../llm-error";

describe("classifyLLMError", () => {
  it("returns ollama-down message when health is missing regardless of error", () => {
    expect(classifyLLMError(new Error("fetch failed"), "missing")).toContain("Ollama is not running");
    expect(classifyLLMError(new Error("anything"), "missing")).toContain("Ollama is not running");
  });

  it("returns model-not-found message for 404 errors", () => {
    expect(classifyLLMError(new Error("Ollama error: 404"), "running")).toContain("Model not found");
  });

  it("returns model-not-found message for 'model not found' text", () => {
    expect(classifyLLMError(new Error("model not found: gemma3"), "running")).toContain("Model not found");
  });

  it("returns the raw error message for other errors", () => {
    expect(classifyLLMError(new Error("timeout after 30s"), "running")).toBe("timeout after 30s");
  });

  it("handles non-Error throws gracefully", () => {
    expect(classifyLLMError("oops", "running")).toBe("An unknown error occurred.");
    expect(classifyLLMError(null, "running")).toBe("An unknown error occurred.");
  });
});
