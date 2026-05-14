import { promises as fs } from "fs";
import { join } from "path";
import {
  LoadedPrompt,
  PromptId,
  PromptLoader,
} from "../contracts/prompts";

// Reads prompt files from a directory. Each file is named `<id>.md` and
// starts with a `version: <semver>` line followed by the prompt body.
//
// Format example:
//   version: 0.1.0
//
//   # ingest-parser
//   ...body...
export class FilePromptLoader implements PromptLoader {
  private cache = new Map<PromptId, LoadedPrompt>();

  constructor(private promptsDir: string) {}

  async load(id: PromptId): Promise<LoadedPrompt> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const raw = await fs.readFile(join(this.promptsDir, `${id}.md`), "utf-8");
    const { version, body } = parsePromptFile(raw);
    const loaded: LoadedPrompt = { id, version, body };
    this.cache.set(id, loaded);
    return loaded;
  }

  invalidate(id?: PromptId): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }
}

function parsePromptFile(raw: string): { version: string; body: string } {
  const match = raw.match(/^version:\s*(\S+)\s*\n([\s\S]*)$/);
  if (!match) {
    throw new Error(
      'Prompt file must start with a "version: <semver>" line',
    );
  }
  return { version: match[1], body: match[2].trim() };
}
