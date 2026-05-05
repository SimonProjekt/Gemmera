import {
  JsonSchema,
  SchemaRegistry,
} from "../contracts/constrained-decoder";

export class InMemorySchemaRegistry implements SchemaRegistry {
  private schemas = new Map<string, JsonSchema>();

  register(stateName: string, schema: JsonSchema): void {
    this.schemas.set(stateName, schema);
  }

  get(stateName: string): JsonSchema | undefined {
    return this.schemas.get(stateName);
  }

  has(stateName: string): boolean {
    return this.schemas.has(stateName);
  }

  entries(): readonly { stateName: string; schema: JsonSchema }[] {
    return Array.from(this.schemas.entries()).map(([stateName, schema]) => ({
      stateName,
      schema,
    }));
  }
}
