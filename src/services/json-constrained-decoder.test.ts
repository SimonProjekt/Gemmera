import { describe, expect, it } from "vitest";
import {
  ChatOptions,
  LLMReachability,
  LLMResponse,
  LLMService,
} from "../contracts/llm";
import {
  benchmarkDecoder,
  JsonConstrainedDecoder,
} from "./json-constrained-decoder";
import { InMemorySchemaRegistry } from "./schema-registry";

class StaticLLM implements LLMService {
  constructor(private response: string) {}
  async chat(_opts: ChatOptions): Promise<LLMResponse> {
    return { content: this.response };
  }
  async isReachable(): Promise<LLMReachability> {
    return "running";
  }
  async listModels(): Promise<string[]> {
    return [];
  }
  async pickDefaultModel(): Promise<string> {
    return "test";
  }
}

const noteSchema = {
  type: "object",
  required: ["title"],
  properties: {
    title: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
} as const;

describe("JsonConstrainedDecoder", () => {
  it("returns the parsed value when the response is valid JSON matching the schema", async () => {
    const registry = new InMemorySchemaRegistry();
    registry.register("PARSE_CONTENT", noteSchema);
    const decoder = new JsonConstrainedDecoder(
      new StaticLLM('{"title":"hello","tags":["a"]}'),
      registry,
    );

    const result = await decoder.decode({
      stateName: "PARSE_CONTENT",
      prompt: "ignored",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ title: "hello", tags: ["a"] });
    }
  });

  it("returns the parsed value when no schema is registered for the state", async () => {
    const decoder = new JsonConstrainedDecoder(
      new StaticLLM('{"any":"shape"}'),
      new InMemorySchemaRegistry(),
    );
    const result = await decoder.decode({
      stateName: "UNKNOWN",
      prompt: "ignored",
    });
    expect(result.ok).toBe(true);
  });

  it("returns a parse failure when the response is not valid JSON", async () => {
    const decoder = new JsonConstrainedDecoder(
      new StaticLLM("not json at all"),
      new InMemorySchemaRegistry(),
    );
    const result = await decoder.decode({
      stateName: "PARSE_CONTENT",
      prompt: "ignored",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("parse");
      expect(result.raw).toBe("not json at all");
    }
  });

  it("returns a schema failure when JSON parses but violates the schema", async () => {
    const registry = new InMemorySchemaRegistry();
    registry.register("PARSE_CONTENT", noteSchema);
    const decoder = new JsonConstrainedDecoder(
      new StaticLLM('{"tags":["x"]}'),
      registry,
    );

    const result = await decoder.decode({
      stateName: "PARSE_CONTENT",
      prompt: "ignored",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "schema") {
      expect(result.errors.length).toBeGreaterThan(0);
    } else {
      throw new Error(`Expected schema failure, got ${JSON.stringify(result)}`);
    }
  });

  it("escapeHatch skips schema validation but still requires valid JSON", async () => {
    const registry = new InMemorySchemaRegistry();
    registry.register("PARSE_CONTENT", noteSchema);
    const decoder = new JsonConstrainedDecoder(
      new StaticLLM('{"tags":["x"]}'),
      registry,
      { escapeHatch: true },
    );
    const result = await decoder.decode({
      stateName: "PARSE_CONTENT",
      prompt: "ignored",
    });
    expect(result.ok).toBe(true);
  });
});

describe("benchmarkDecoder", () => {
  it("reports parseFailures, schemaFailures, and successRate across fixtures", async () => {
    const registry = new InMemorySchemaRegistry();
    registry.register("VALID", noteSchema);
    registry.register("BAD_SCHEMA", noteSchema);

    const llm = new SequencedLLM([
      '{"title":"ok"}',
      '{"tags":["x"]}',
      "not json",
    ]);
    const decoder = new JsonConstrainedDecoder(llm, registry);

    const result = await benchmarkDecoder(decoder, [
      { stateName: "VALID", prompt: "1" },
      { stateName: "BAD_SCHEMA", prompt: "2" },
      { stateName: "VALID", prompt: "3" },
    ]);

    expect(result.totalCalls).toBe(3);
    expect(result.parseFailures).toBe(1);
    expect(result.schemaFailures).toBe(1);
    expect(result.successRate).toBeCloseTo(1 / 3);
  });
});

class SequencedLLM implements LLMService {
  private i = 0;
  constructor(private responses: string[]) {}
  async chat(_opts: ChatOptions): Promise<LLMResponse> {
    return { content: this.responses[this.i++] ?? "" };
  }
  async isReachable(): Promise<LLMReachability> {
    return "running";
  }
  async listModels(): Promise<string[]> {
    return [];
  }
  async pickDefaultModel(): Promise<string> {
    return "test";
  }
}
