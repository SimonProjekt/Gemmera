// JSON Schema (Draft 7+). Opaque to the framework — the concrete decoder
// uses its own validator (ajv in JsonConstrainedDecoder).
export type JsonSchema = Record<string, unknown>;

export interface SchemaRegistry {
  register(stateName: string, schema: JsonSchema): void;
  get(stateName: string): JsonSchema | undefined;
  has(stateName: string): boolean;
  entries(): readonly { stateName: string; schema: JsonSchema }[];
}

// Discriminated result. Consumers branch on `ok` and on `reason` to wire
// retries: parse failures route to MODEL_INVALID_OUTPUT, schema failures
// route to VALIDATION_FAILED (per planning/tool-loop.md "Retry policy").
export type ConstrainedDecodeResult<T = unknown> =
  | { ok: true; value: T; raw: string }
  | { ok: false; reason: "parse"; raw: string; error: string }
  | { ok: false; reason: "schema"; raw: string; errors: unknown[] };

export interface ConstrainedDecoder {
  decode(opts: {
    stateName: string;
    prompt: string;
  }): Promise<ConstrainedDecodeResult>;
}
