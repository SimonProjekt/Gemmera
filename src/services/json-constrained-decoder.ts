import Ajv, { ValidateFunction } from "ajv";
import {
  ConstrainedDecodeResult,
  ConstrainedDecoder,
  JsonSchema,
  SchemaRegistry,
} from "../contracts/constrained-decoder";
import { LLMService } from "../contracts/llm";

export interface JsonConstrainedDecoderOptions {
  // When true, schema validation is skipped. JSON parsing still applies.
  // Debug-only escape hatch — never enable in user-facing builds.
  escapeHatch?: boolean;
}

// Composes a structured-output prompt and validates the model response
// against the schema registered for the calling state. Schema instructions
// are included in the system message; native Ollama `format: "json"` wiring
// is deferred until LLMService grows that field.
export class JsonConstrainedDecoder implements ConstrainedDecoder {
  private ajv = new Ajv({ allErrors: true });
  // Keyed by schema identity (not stateName) so re-registering a schema
  // for the same state automatically misses the cache and recompiles.
  private validators = new WeakMap<JsonSchema, ValidateFunction>();

  constructor(
    private llm: LLMService,
    private registry: SchemaRegistry,
    private options: JsonConstrainedDecoderOptions = {},
  ) {
    if (options.escapeHatch) {
      const env =
        typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
      if (env === "production") {
        throw new Error(
          "JsonConstrainedDecoder.escapeHatch must not be enabled in production builds",
        );
      }
      // eslint-disable-next-line no-console
      console.warn(
        "JsonConstrainedDecoder: escapeHatch enabled — schema validation skipped (debug-only)",
      );
    }
  }

  async decode(opts: {
    stateName: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<ConstrainedDecodeResult> {
    const schema = this.registry.get(opts.stateName);
    const response = await this.llm.chat({
      messages: [
        { role: "system", content: composeSystemPrompt(schema) },
        { role: "user", content: opts.prompt },
      ],
      signal: opts.signal,
    });
    const raw = response.content;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        reason: "parse",
        raw,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (schema && !this.options.escapeHatch) {
      const validator = this.getValidator(schema);
      if (!validator(parsed)) {
        return {
          ok: false,
          reason: "schema",
          raw,
          errors: validator.errors ?? [],
        };
      }
    }

    return { ok: true, value: parsed, raw };
  }

  private getValidator(schema: JsonSchema): ValidateFunction {
    const cached = this.validators.get(schema);
    if (cached) return cached;
    const validator = this.ajv.compile(schema);
    this.validators.set(schema, validator);
    return validator;
  }
}

// TODO(format-json): once LLMService.ChatOptions grows native
// `format: "json"` (with optional schema constraint for newer Ollama
// versions), drop the inlined schema from the system message and pass
// it on the chat options instead. Inlining bloats every call.
function composeSystemPrompt(schema: JsonSchema | undefined): string {
  if (!schema) {
    return "Respond with valid JSON only. No preamble, no commentary, no code fences.";
  }
  return [
    "Respond with valid JSON only. No preamble, no commentary, no code fences.",
    "The JSON must conform to this schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n\n");
}

// Benchmark utility — runs each fixture through the decoder and reports
// the schema-failure rate. A stand-in metric for the eval suite (see
// planning/tool-loop.md "Retry policy").
export interface BenchmarkFixture {
  stateName: string;
  prompt: string;
}

export interface BenchmarkResult {
  totalCalls: number;
  parseFailures: number;
  schemaFailures: number;
  successRate: number;
}

export async function benchmarkDecoder(
  decoder: ConstrainedDecoder,
  fixtures: BenchmarkFixture[],
): Promise<BenchmarkResult> {
  let parseFailures = 0;
  let schemaFailures = 0;
  for (const f of fixtures) {
    const result = await decoder.decode({
      stateName: f.stateName,
      prompt: f.prompt,
    });
    if (!result.ok) {
      if (result.reason === "parse") parseFailures += 1;
      else if (result.reason === "schema") schemaFailures += 1;
    }
  }
  const failures = parseFailures + schemaFailures;
  return {
    totalCalls: fixtures.length,
    parseFailures,
    schemaFailures,
    successRate:
      fixtures.length === 0
        ? 1
        : (fixtures.length - failures) / fixtures.length,
  };
}
