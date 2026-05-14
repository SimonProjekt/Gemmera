import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One row of a retrieval golden-set JSONL shard. Schema matches
 * `evals/golden/README.md`: a question, its expected note paths, and
 * the fixture vault those paths resolve against.
 */
export interface GoldenExample {
  id: string;
  fixtureVault: string;
  question: string;
  idealNotePaths: string[];
  idealAnswerSummary: string;
  rationale?: string;
  notes?: string;
}

const GOLDEN_DIR = join(__dirname, "..", "..", "evals", "golden");

/** Known shards, by filename stem. New shards land here as they're authored. */
export const SHARDS = ["link-structure", "lexical", "semantic", "mixed"] as const;
export type ShardName = (typeof SHARDS)[number];

export function loadShard(shard: ShardName): GoldenExample[] {
  const raw = readFileSync(join(GOLDEN_DIR, `${shard}.jsonl`), "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as GoldenExample;
    } catch (err) {
      throw new Error(`${shard}.jsonl line ${i + 1}: ${(err as Error).message}`);
    }
  });
}

export function loadAllShards(): Record<ShardName, GoldenExample[]> {
  return Object.fromEntries(SHARDS.map((s) => [s, loadShard(s)])) as Record<
    ShardName,
    GoldenExample[]
  >;
}

/**
 * Load every `.md` file under `evals/golden/fixtures/<vault>/` into a
 * path → content map, keyed the same way the golden examples reference
 * them (`<vault>/<basename>.md`).
 */
export function loadFixtureVault(vault: string): Record<string, string> {
  const dir = join(GOLDEN_DIR, "fixtures", vault);
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    files[`${vault}/${name}`] = readFileSync(join(dir, name), "utf-8");
  }
  return files;
}
