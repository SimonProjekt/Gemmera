import { describe, it, expect } from "vitest";
import { MockClassifierService } from "./mock-classifier";

describe("MockClassifierService", () => {
  const svc = new MockClassifierService();

  it("routes leading ? to ask with high confidence", async () => {
    const d = await svc.classify({ messageText: "? vad vet jag om X?" });
    expect(d.label).toBe("ask");
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("routes save keywords to capture", async () => {
    const d = await svc.classify({ messageText: "spara detta som en anteckning" });
    expect(d.label).toBe("capture");
  });

  it("routes help questions to meta", async () => {
    const d = await svc.classify({ messageText: "hur använder jag Gemmera?" });
    expect(d.label).toBe("meta");
  });

  it("defaults to ask for unrecognized input", async () => {
    const d = await svc.classify({ messageText: "lite slumpmässig text" });
    expect(d.label).toBe("ask");
  });

  it("returns source llm and a promptVersion", async () => {
    const d = await svc.classify({ messageText: "anything" });
    expect(d.source).toBe("llm");
    expect(typeof d.promptVersion).toBe("string");
    expect(typeof d.latencyMs).toBe("number");
  });

  it("returns source skip and skipReason for ?-prefix", async () => {
    const d = await svc.classify({ messageText: "? vad är klockan" });
    expect(d.source).toBe("skip");
    expect(d.skipReason).toBe("leading-question-mark");
  });

  it("returns source skip for empty message", async () => {
    const d = await svc.classify({ messageText: "" });
    expect(d.source).toBe("skip");
    expect(d.skipReason).toBe("empty");
  });

  it("returns source skip for attachment-only message", async () => {
    const d = await svc.classify({ messageText: "", attachmentKinds: ["image/png"] });
    expect(d.source).toBe("skip");
    expect(d.label).toBe("capture");
    expect(d.skipReason).toBe("attachment-only");
  });
});
