# Golden retrieval set

`(question, ideal_note_paths, ideal_answer_summary)` fixtures for the eval
harness in #16 and ad-hoc validation while building the retriever (#8) and
payload assembler (#10).

## Files

One shard per signal class, kept small so individual tests stay focused.
Total set: 30 examples across four shards.

- `link-structure.jsonl` — questions whose ideal answer requires the
  link-graph boost to outrank pure-semantic matches.
- `lexical.jsonl` — exact-term / proper-noun questions where BM25 must
  beat semantic.
- `semantic.jsonl` — paraphrase-style questions where embeddings must
  beat BM25.
- `mixed.jsonl` — realistic questions that need fusion of signals.

Each shard has a matching `fixtures/<shard>/` mini-vault. Keep them small
(≤20 notes per shard) so the harness runs in seconds.

## Schema

One JSON object per line:

```json
{
  "id": "stable-slug-for-this-question",
  "question": "natural-language question the user might ask",
  "idealNotePaths": ["Path/To/Note.md"],
  "idealAnswerSummary": "one-sentence gist of the correct answer",
  "notes": "optional free-form rationale for the test designer"
}
```

`idealNotePaths` is the recall target: a result is a "hit" if any of these
paths appears in the retrieved set. Order within the list is not
significant.

Required fields: `id`, `fixtureVault`, `question`, `idealNotePaths`,
`idealAnswerSummary`. Optional: `rationale` (notes for the test designer
about what signal class this case targets) and `notes`.

## Vault assumption

`fixtureVault` names a directory under `fixtures/`. The eval harness
loads every `.md` file in that directory and indexes it in memory.
Renames must update both the fixture file and any JSONL row referencing
the path, in the same commit.

## Mock vs. live mode

The harness defaults to a deterministic mock embedder so it can run in
CI without Ollama. Mock mode gives stable, comparable numbers for
chunker / BM25 / link-graph regressions, but cannot validate true
semantic understanding — the `semantic` shard will show partial recall
under mock mode by design. Run with a live embedder for an honest read
on semantic quality.
