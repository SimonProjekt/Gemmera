version: 0.1.0

# ingest-parser

Turns raw user content into a structured NoteSpec candidate.

## Input
- Raw user content (Markdown, plain text, or pasted snippet).
- Optional user instruction (e.g. "save this as a meeting note").

## Output
JSON matching the NoteSpec contract in `planning/rag.md`. Includes a title
guess, type, tags, summary, and the body Markdown.

## Status
Scaffold. Exact wording filled in by a separate task.
