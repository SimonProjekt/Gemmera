# Golden retrieval set

`(question, ideal_note_paths, ideal_answer_summary)` fixtures for the eval
harness in #16 and ad-hoc validation while building the retriever (#8) and
payload assembler (#10).

## Files

- `link-structure.jsonl` — questions whose ideal answer requires the
  link-graph boost to outrank pure-semantic matches. The HybridRetriever
  (#8) acceptance: "Backlink-boosted results outrank pure-semantic
  matches on the golden-set tests that target link structure." Use this
  file to verify that.

Future files (one per signal class, kept small so individual tests stay focused):

- `lexical.jsonl` — exact-term / project-name questions where BM25 must
  beat semantic.
- `semantic.jsonl` — paraphrase-style questions where embeddings must
  beat BM25.
- `mixed.jsonl` — realistic questions that need fusion.

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

## Vault assumption

These fixtures reference paths in `demo-vault/`. Keep them in sync — when
you rename a referenced note, update the fixture in the same commit.
