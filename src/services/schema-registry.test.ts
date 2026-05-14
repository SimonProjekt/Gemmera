import { describe, expect, it } from "vitest";
import { InMemorySchemaRegistry } from "./schema-registry";

describe("InMemorySchemaRegistry", () => {
  it("registers a schema and retrieves it by state name", () => {
    const reg = new InMemorySchemaRegistry();
    const schema = { type: "object", required: ["title"] };
    reg.register("PARSE_CONTENT", schema);
    expect(reg.get("PARSE_CONTENT")).toBe(schema);
    expect(reg.has("PARSE_CONTENT")).toBe(true);
  });

  it("returns undefined for an unregistered state", () => {
    const reg = new InMemorySchemaRegistry();
    expect(reg.get("MISSING")).toBeUndefined();
    expect(reg.has("MISSING")).toBe(false);
  });

  it("entries() returns every registered (stateName, schema) pair", () => {
    const reg = new InMemorySchemaRegistry();
    reg.register("A", { type: "object" });
    reg.register("B", { type: "string" });
    const entries = reg.entries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.stateName === "A")?.schema).toEqual({
      type: "object",
    });
  });
});
