import { describe, expect, it } from "vitest";
import { MockVaultService } from "./mock-vault";

describe("MockVaultService", () => {
  it("creates and reads files", async () => {
    const v = new MockVaultService();
    await v.create("a.md", "hello");
    expect(await v.read("a.md")).toBe("hello");
  });

  it("rejects creating an existing file", async () => {
    const v = new MockVaultService({ "a.md": "hi" });
    await expect(v.create("a.md", "x")).rejects.toThrow(/exists/);
  });

  it("appends to a file", async () => {
    const v = new MockVaultService({ "a.md": "hi" });
    await v.append("a.md", " world");
    expect(await v.read("a.md")).toBe("hi world");
  });

  it("lists only markdown files", async () => {
    const v = new MockVaultService({
      "a.md": "x",
      "b.txt": "y",
      "c.md": "z",
    });
    const files = await v.listMarkdownFiles();
    expect(files.map((f) => f.path).sort()).toEqual(["a.md", "c.md"]);
  });
});
