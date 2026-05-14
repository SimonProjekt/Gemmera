version: 0.1.0

# retrieval-reasoner

Answers a user question from a compact retrieval package, with
structured citations back to specific notes and headings.

## Input
- The user's question.
- A compact retrieval package: top-N notes with title, path, heading,
  matched chunk, why-matched, and score.

## Output
A streamed Markdown answer with citation markers that resolve to
note paths and offsets. Validation rejects answers that cite paths
not present in the retrieval package.

## Status
Scaffold. Exact wording filled in by a separate task.
