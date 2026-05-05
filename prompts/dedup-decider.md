version: 0.1.0

# dedup-decider

Given a candidate note and its top-k similar existing notes, decides
the dedup strategy: propose new, append to existing, or split into
multiple notes.

## Input
- Candidate NoteSpec.
- Top-k similar notes with similarity scores.

## Output
JSON with `strategy` (one of `new`, `append`, `split`, `ask_user`),
`targetPath` (for append), and brief reasoning shown to the user.

## Status
Scaffold. Exact wording filled in by a separate task.
