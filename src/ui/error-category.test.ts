import { describe, expect, it } from "vitest";
import { categorizeError, userMessageForCategory } from "./error-category";

describe("categorizeError", () => {
  it("classifies AbortError as timeout", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(categorizeError(err)).toBe("timeout");
  });

  it("classifies timeout message as timeout", () => {
    expect(categorizeError(new Error("request timeout exceeded"))).toBe("timeout");
  });

  it("classifies ECONNREFUSED as ollama_down", () => {
    expect(categorizeError(new Error("ECONNREFUSED"))).toBe("ollama_down");
  });

  it("classifies failed to fetch as ollama_down", () => {
    expect(categorizeError(new Error("Failed to fetch"))).toBe("ollama_down");
  });

  it("classifies network error as ollama_down", () => {
    expect(categorizeError(new Error("network error"))).toBe("ollama_down");
  });

  it("classifies model not found as model_missing", () => {
    expect(categorizeError(new Error("model not found"))).toBe("model_missing");
  });

  it("classifies pull model error as model_missing", () => {
    expect(categorizeError(new Error("pull model gemma:latest failed"))).toBe("model_missing");
  });

  it("classifies no such model as model_missing", () => {
    expect(categorizeError(new Error("no such model"))).toBe("model_missing");
  });

  it("returns unknown for unrecognised errors", () => {
    expect(categorizeError(new Error("something completely different"))).toBe("unknown");
  });

  it("handles non-Error string values", () => {
    expect(categorizeError("network error")).toBe("ollama_down");
  });

  it("handles non-Error non-string values", () => {
    expect(categorizeError(42)).toBe("unknown");
  });
});

describe("userMessageForCategory", () => {
  it("returns Ollama message for ollama_down", () => {
    expect(userMessageForCategory("ollama_down", "raw")).toContain("Ollama");
  });

  it("returns timed out message for timeout", () => {
    expect(userMessageForCategory("timeout", "raw")).toContain("timed out");
  });

  it("returns model message for model_missing", () => {
    expect(userMessageForCategory("model_missing", "raw")).toContain("Model not found");
  });

  it("includes rawMessage in unknown fallback", () => {
    expect(userMessageForCategory("unknown", "exploded")).toContain("exploded");
  });
});
