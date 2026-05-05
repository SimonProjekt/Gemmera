import { createHash } from "node:crypto";
import type {
  Chunker,
  IngestDecision,
  IngestionPipeline,
  IngestionStore,
  IngestOptions,
  NoteState,
  VaultService,
} from "../contracts";

export class HashGatedIngestionPipeline implements IngestionPipeline {
  constructor(
    private readonly vault: VaultService,
    private readonly chunker: Chunker,
    private readonly store: IngestionStore,
  ) {}

  async ingest(path: string, opts: IngestOptions = {}): Promise<IngestDecision> {
    const raw = await this.vault.read(path);
    const contentHash = sha256(raw);

    const prior = await this.store.get(path);
    if (prior && prior.contentHash === contentHash) {
      return { kind: "skip", state: prior };
    }

    const { frontmatter, body } = splitFrontmatter(raw);
    const bodyHash = sha256(body);
    const mtime = opts.mtime ?? Date.now();

    const state: NoteState = {
      path,
      contentHash,
      bodyHash,
      mtime,
      frontmatter,
    };

    if (prior && prior.bodyHash === bodyHash) {
      await this.store.upsertMetadata(state);
      return { kind: "metadata-only", state };
    }

    const title = basenameOf(path);
    const headings = await this.vault.getHeadings(path);
    const chunks = this.chunker.chunk({ path, title, content: raw, headings });

    await this.store.upsert(state, chunks);
    return { kind: "rechunk", state, chunks };
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  if (!raw.startsWith("---")) return { frontmatter: null, body: raw };
  const match = /\n---[ \t]*(\r?\n|$)/.exec(raw.slice(3));
  if (!match) return { frontmatter: null, body: raw };
  const fmEnd = 3 + match.index;
  const bodyStart = fmEnd + match[0].length;
  const frontmatter = raw.slice(3, fmEnd).replace(/^\r?\n/, "");
  return { frontmatter, body: raw.slice(bodyStart) };
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const file = slash === -1 ? path : path.slice(slash + 1);
  return file.replace(/\.md$/, "");
}
