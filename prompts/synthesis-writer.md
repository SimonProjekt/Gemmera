version: 0.1.0

# synthesis-writer

Combines multiple notes into a single synthesis note. Invoked by
`create_synthesis_note`.

## Input
- A set of source notes (path, title, body excerpts).
- Optional user-provided framing or focus.

## Output
A new Markdown note that summarizes and connects the sources, with
wikilinks back to each source under a `## Sources` section.

## Status
Scaffold. Exact wording filled in by a separate task.
