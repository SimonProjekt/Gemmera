import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPT_IDS } from "../contracts/prompts";
import { FilePromptLoader } from "./file-prompt-loader";

const realPromptsDir = join(process.cwd(), "prompts");

describe("FilePromptLoader (real prompts/ directory)", () => {
  it("loads each canonical prompt id with a parsed version and body", async () => {
    const loader = new FilePromptLoader(realPromptsDir);
    for (const id of PROMPT_IDS) {
      const prompt = await loader.load(id);
      expect(prompt.id).toBe(id);
      expect(prompt.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(prompt.body.length).toBeGreaterThan(0);
    }
  });

  it("returns the cached instance on a repeat load", async () => {
    const loader = new FilePromptLoader(realPromptsDir);
    const first = await loader.load("ingest-parser");
    const second = await loader.load("ingest-parser");
    expect(second).toBe(first);
  });
});

describe("FilePromptLoader (temp directory)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "gemmera-prompts-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("invalidate(id) drops a specific entry so the next load re-reads from disk", async () => {
    await fs.writeFile(
      join(dir, "ingest-parser.md"),
      "version: 0.1.0\n\nfirst",
    );
    const loader = new FilePromptLoader(dir);
    const first = await loader.load("ingest-parser");
    expect(first.body).toBe("first");

    await fs.writeFile(
      join(dir, "ingest-parser.md"),
      "version: 0.2.0\n\nsecond",
    );
    loader.invalidate("ingest-parser");
    const second = await loader.load("ingest-parser");
    expect(second.version).toBe("0.2.0");
    expect(second.body).toBe("second");
  });

  it("invalidate() with no id clears the entire cache", async () => {
    await fs.writeFile(
      join(dir, "ingest-parser.md"),
      "version: 0.1.0\n\na",
    );
    await fs.writeFile(
      join(dir, "note-writer.md"),
      "version: 0.1.0\n\nb",
    );
    const loader = new FilePromptLoader(dir);
    const ingestA = await loader.load("ingest-parser");
    await loader.load("note-writer");

    loader.invalidate();
    const ingestB = await loader.load("ingest-parser");
    expect(ingestB).not.toBe(ingestA);
  });

  it("throws when the prompt file is missing a version header", async () => {
    await fs.writeFile(
      join(dir, "ingest-parser.md"),
      "no header here\nbody",
    );
    const loader = new FilePromptLoader(dir);
    await expect(loader.load("ingest-parser")).rejects.toThrow(
      /version: <semver>/,
    );
  });
});
