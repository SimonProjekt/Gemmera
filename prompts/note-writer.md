version: 0.1.0

# note-writer

Formats the final Markdown body of a note from a NoteSpec.

## Input
- A NoteSpec produced by `ingest-parser`.

## Output
The Markdown body of the note. Preserves frontmatter rules from
`planning/rag.md`. Separated from the parser so that body-format
changes do not regress parsing.

## Status
Scaffold. Exact wording filled in by a separate task.
