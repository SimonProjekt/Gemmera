import { describe, it, expect } from "vitest";
import { OllamaClassifierService } from "./ollama-classifier";

describe("OllamaClassifierService skip conditions", () => {
  const svc = new OllamaClassifierService();

  it("returns skip ask for empty message", async () => {
    const d = await svc.classify({ messageText: "" });
    expect(d.source).toBe("skip");
    expect(d.label).toBe("ask");
    expect(d.skipReason).toBe("empty");
  });

  it("returns skip ask for ?-prefixed message", async () => {
    const d = await svc.classify({ messageText: "? vad vet jag om X?" });
    expect(d.source).toBe("skip");
    expect(d.label).toBe("ask");
    expect(d.skipReason).toBe("leading-question-mark");
  });

  it("returns skip capture for attachment-only message", async () => {
    const d = await svc.classify({ messageText: "", attachmentKinds: ["image/png"] });
    expect(d.source).toBe("skip");
    expect(d.label).toBe("capture");
    expect(d.skipReason).toBe("attachment-only");
  });

  it("does not skip for empty message with attachments and text", async () => {
    // This message has both text and attachments, so it should go through LLM path.
    // It will fail because Ollama isn't running — but that means we test the fallback.
    const d = await svc.classify({
      messageText: "save this",
      attachmentKinds: ["image/png"],
    });
    expect(d.failed).toBe(true);
    expect(d.label).toBe("ask");
  });

  it("falls back silently on timeout/error with failed flag", async () => {
    // Without Ollama running, classify will fail after timeout/connection error.
    const d = await svc.classify({ messageText: "a normal message" });
    expect(d.failed).toBe(true);
    expect(d.label).toBe("ask");
    expect(d.confidence).toBe(0);
    expect(d.source).toBe("llm");
  });
});
