# LLM tool loop

This document pins the tool inventory, state machine requirements, state machines, retry policy, hard stops, intent classifier scope, and prompt inventory that govern every interaction between Gemma and the vault. It is the contract between the orchestration model and the rest of the app.

## Tool inventory

Gemma can invoke the following tools. The set is deliberately small — fewer tools means fewer classification errors from the 4B-active-parameter orchestrator, and most operations compose from a handful of well-named functions.

### Read tools (no side effects, no preview gate)

- `search_notes(query, filters?, top_k?)` — hybrid retrieval returning chunks plus metadata. Filters can narrow by tag, folder, date range, note type, or status.
- `get_note(path, include_chunks?)` — full note body and parsed metadata. With `include_chunks`, also returns the indexed chunks.
- `find_related_notes(seed, by?)` — graph + semantic similarity neighbors. `seed` is a path or raw text; `by` toggles between `graph`, `semantic`, or `hybrid` (default).
- `retrieve_similar_notes(text, top_k?)` — vector-only dedup check used during ingestion. Distinct from `search_notes` because it skips BM25 and graph boosts for speed.
- `list_folder(path, filter?)` — shallow folder listing with optional filename glob.

### Write tools (side effects, preview gate by default)

- `propose_note(content, instructions, context)` — ingestion-time tool that returns a `NoteSpec` without writing. Pure function; the app writes only after preview confirmation.
- `save_note(note_spec, mode)` — mode ∈ {`create`, `append`}. `create` writes a new note; `append` adds content under a dated heading in an existing note. Always passes through the preview gate unless the user has disabled "Always preview before save."
- `update_frontmatter(path, patch)` — targeted frontmatter edit. Patch fields only; does not touch the note body. Goes through the preview gate for non-additive changes.
- `rename_or_move_note(from_path, to_path)` — implemented via `FileManager.renameFile`, which updates all incoming links in the vault atomically. Respects the user's "Always preview" setting because the operation is reversible.
- `delete_note(path)` — moves to Obsidian's trash (`vault.trash`), never a permanent delete. Always requires an explicit user confirmation modal even when "Always preview before save" is off. Non-overridable.
- `create_synthesis_note(question, source_paths, placement)` — specialized note creation combining multiple sources. Goes through the preview gate.

### Meta tools

- `reindex(scope)` — scope ∈ {`active_note`, `paths[]`, `all`}.
- `get_vault_info()` — counts, folder tree summary, last-index timestamp, model state. Used by Gemma to answer "how big is my vault" style questions without guessing.

### CRUD coverage matrix

| Operation | Primary tool | Safety |
|---|---|---|
| Create | `save_note(mode=create)`, `create_synthesis_note` | Preview gate on by default. |
| Read | `search_notes`, `get_note`, `find_related_notes`, `list_folder` | No preview needed. |
| Update (append-only in v1) | `save_note(mode=append)`, `update_frontmatter` | Body updates are append-only. Full-body replacement deferred to v2. |
| Delete | `delete_note` | Mandatory, non-overridable confirmation modal. Moves to `.trash`, not permanent. |
| Rename / move | `rename_or_move_note` | Links updated automatically by Obsidian. Preview gate applies. |

Deliberate v1 omissions:

- No full-body-replacement update mode. Body edits are always append-only. This keeps the user's existing content stable and makes diff-preview trivial ("here's what will be added").
- No silent-overwrite path. Any future body-replacement tool (v2) will require matching mtime + hash plus an explicit confirmation.

## State machine requirements

The state machine is the skeleton the tool loop walks every turn. It must satisfy the following requirements so the rest of the system (error handling, observability, evals, UI) can be built against a stable contract.

### Structural requirements

- **Named states with single-responsibility semantics.** Each state does one thing (parse, search, decide, write, generate, validate). No compound states.
- **Explicit transitions.** Every transition is a named edge from one state to another, triggered by a specific event. No implicit fall-through.
- **One active turn per chat.** A second turn submitted while the first is running is queued, not run in parallel. The UI shows a "queued" chip.
- **Bounded events per turn.** Each state may fire a bounded number of events (tool calls, retries). Unbounded loops are a bug, not a feature.

### Behavioral requirements

- **Event-driven transitions.** Transitions fire on: user action (confirm, edit, cancel), tool result (success, error), timer (timeout), or model output (parsed JSON, text, tool call).
- **Cancellation support.** The user can abort at any state. On cancel, the loop unwinds in a well-defined order: stop model streaming first, drop pending tool results, mark the turn `cancelled` in events, preserve any confirmed writes, roll back partial unconfirmed writes.
- **Timeout support.** Each turn has a wall-clock ceiling. On timeout, the loop exits to a `TIMED_OUT` terminal state with the same unwind order as cancellation.
- **Retry hooks at specific states.** Model-output retries happen at `PARSE_CONTENT`, `DECIDE_STRATEGY`, and `GENERATE`. Tool-argument retries happen at every tool-call state. Retry budgets are defined in the retry policy section below.
- **Idempotency.** Retrying a state does not cause duplicate side effects. Writes happen only once, in the `WRITE` state, after explicit user confirmation.

### Observability requirements

- **Every transition logged.** Each state enter/exit writes a row to `events.duckdb` with turn_id, state name, timestamp, and payload (tool args, tool results, prompts, responses).
- **Deterministic replay.** Given the same inputs and recorded tool results, the state machine follows the same path up to model non-determinism. This is the foundation for the eval suite.
- **UI reflection.** Each state maps to a visible UI status. `RETRIEVE` → "Searching notes…", `GENERATE` → streaming answer, `PREVIEW` → modal or inline preview, `WRITE` → "Saving…".

### Error handling requirements

- **Error states are first-class.** `MODEL_INVALID_OUTPUT`, `TOOL_FAILED`, `VALIDATION_FAILED`, `TIMED_OUT`, `CANCELLED` are named terminal states. Not thrown exceptions caught by a generic handler.
- **Partial state preserved on exit.** Every terminal state preserves what happened before it for the turn inspector. The user can always answer "why did it stop?" by opening the inspector.
- **Defined unwind order.** On any terminal state: stop model stream → drop pending tool results → roll back unconfirmed writes → update events log → show Notice → close the turn.

## State machines

Two state machines run inside the tool loop: an ingest path (capture) and a query path (ask). The intent classifier routes each user message to one or the other, or occasionally both. A third mini-state-machine governs destructive operations (delete, rename, move) regardless of which path triggered them.

### Ingest state machine

```
IDLE
  └── user submits content + optional instruction
      ↓
  CLASSIFY_INTENT
      ↓ (capture)
  PARSE_CONTENT
      │   Gemma runs the ingest-parser prompt and emits a structured candidate
      │   (title guess, type, tags, summary, body markdown).
      ↓
  SEARCH_SIMILAR
      │   Calls retrieve_similar_notes on the candidate body.
      ↓
  DECIDE_STRATEGY
      ├── no similar notes                          → PROPOSE_NEW
      ├── similarity > dup_threshold                → ASK_USER_DEDUP
      ├── related but distinct                      → PROPOSE_NEW_WITH_LINKS
      ├── append-compatible with existing note      → PROPOSE_APPEND
      └── multi-topic content                       → PROPOSE_SPLIT
      ↓
  PREVIEW
      ├── user edits        → loop back to PREVIEW with edits applied
      ├── user cancels      → CANCELLED
      └── user confirms     → WRITE
      ↓
  WRITE
      │   Atomic write via FileManager, inbox quarantine, cowork frontmatter block.
      │   For PROPOSE_APPEND, content is appended under a dated heading.
      ↓
  UPDATE_INDEX
      │   Chunk + embed the new or updated note.
      ↓
  DONE (Notice: "Saved to Inbox/…" with Undo action)
```

Branches worth flagging:

- **ASK_USER_DEDUP** is the most delicate branch. The preview modal surfaces the near-duplicate and offers three options: "append to the existing note," "save as a new note anyway," or "cancel." This is the single highest-leverage point for preventing vault duplication over time.
- **PROPOSE_APPEND** shows what will be added, not a diff of the whole note. Content is appended under a dated heading (for example, `## 2026-04-23 capture`) so future maintenance is straightforward.
- **PROPOSE_SPLIT** returns N note candidates. The preview shows a list and lets the user confirm each independently or accept all.

### Query state machine

```
IDLE
  └── user submits question
      ↓
  CLASSIFY_INTENT
      ↓ (ask)
  PLAN_RETRIEVAL
      │   Gemma may call search_notes, find_related_notes, or both.
      │   Simple queries skip to RETRIEVE with sensible defaults.
      ↓
  RETRIEVE
      │   Hybrid candidates (~30) from vector + BM25 + graph boost.
      ↓
  RERANK
      │   bge-reranker-v2-m3 narrows to top 8.
      ↓
  ASSEMBLE_CONTEXT
      │   Compact retrieval package (title, path, heading, chunk, why-matched, score).
      ↓
  GENERATE
      │   Gemma streams the answer. May call get_note to read any chunk
      │   it needs in full context.
      ↓
  VALIDATE_CITATIONS
      │   Every cited path must appear in the retrieval payload.
      ├── valid   → PRESENT
      └── invalid → RETRY_WITH_CONSTRAINED_CITATIONS (once)
      ↓
  PRESENT
      │   Streamed answer with clickable citations.
      │   Optional "save as synthesis note" affordance.
      ↓
  DONE
```

### Destructive operation path

A mini-state-machine governs `delete_note` and `rename_or_move_note` when Gemma invokes them. These operations can be triggered from either the ingest or query path (for example: "the last meeting note is a duplicate — delete it").

```
TOOL_CALL (delete_note | rename_or_move_note)
  ↓
  CONFIRM
      ├── For delete_note: a dedicated confirmation modal lists the target file,
      │   shows its preview, and requires an explicit Confirm click. Cannot be
      │   bypassed by any setting. Non-overridable by design.
      ├── For rename_or_move_note: the standard preview gate shows from/to paths
      │   and the affected-link count. Respects the global "Always preview"
      │   setting because the operation is reversible and Obsidian maintains
      │   link integrity.
      ├── user cancels  → CANCELLED (tool result: "user declined")
      └── user confirms → EXECUTE
      ↓
  EXECUTE
      │   For delete: vault.trash(path).
      │   For rename: fileManager.renameFile(from, to).
      ↓
  UPDATE_INDEX
      ↓
  DONE (Notice: "Deleted X" / "Renamed X to Y" with Undo)
```

Delete confirmation is mandatory and non-overridable. This is the strictest safety rule in the system: there is no setting, no power-user flag, no "don't ask me again" affordance that removes the delete modal.

### Mixed intent

If the classifier returns `mixed` (the user simultaneously wants to ingest and ask), the ingest path runs first to completion, then the query path runs with the newly-written note included in the retrieval set. The UI shows both phases as distinct status cards within a single turn.

## Retry policy

Retries happen at two layers: model-output validity and tool-call correctness. Infrastructure failures get a third, separate budget.

### Model-output validity

- Invalid JSON for a structured output → retry once with JSON-schema-constrained decoding (Ollama's `format: "json"` or a schema grammar). If still invalid, exit to `MODEL_INVALID_OUTPUT`.
- JSON that parses but violates the schema → retry once with explicit error feedback appended to the prompt. If still invalid, exit to `VALIDATION_FAILED`.

### Tool-call correctness

- Unknown tool name → 0 retries. Exit to `VALIDATION_FAILED`; this indicates a prompt bug, not a transient issue.
- Tool arguments that fail schema validation → 1 retry with the validation error returned to Gemma as a tool result.
- Tool execution raises an exception (file not found, timeout, permission error) → 0 automatic retries. The error is returned as a tool result and Gemma decides whether to retry, try a different approach, or explain the failure to the user.

### Transient infrastructure failures

- Ollama connection refused → 1 retry after 500 ms. On failure, surface "Ollama not running" Notice with a Start action.
- Embedding call fails → 1 retry after 250 ms. On failure, the indexing job returns to the queue and the user is not blocked.
- Reranker fails → 0 retries; skip rerank and use raw hybrid scores. Log the event.

## Hard stops

Every turn has enforced ceilings. When a ceiling is hit, the loop exits immediately to a terminal state, partial state is preserved, and a Notice explains what happened with a link to the turn inspector.

- **Maximum tool calls per turn**: 10. Realistic turns use 2–5.
- **Maximum wall-clock time per turn**: 120 seconds. Configurable up to 300 s for slower hardware.
- **Maximum consecutive no-op model responses**: 3. A "no-op" is a model response that calls no tools and emits no user-visible text.
- **Maximum retries across the whole turn**: 3. Independent of per-step retry budgets.
- **Maximum retrieval payload size**: 16 KB of compacted retrieval JSON. If hybrid + rerank produces more, truncate by score.

## Intent classifier

**Scope**: an auto classifier runs on every user message before the main loop, unless a skip condition hard-codes the intent. Full design lives in `classifier.md`.

Summary:

- Pure LLM classification on shared E4B, 200 ms budget.
- Flat taxonomy: {`capture`, `ask`, `mixed`, `meta`}.
- Output is structured JSON with label, confidence, and one-line rationale.
- Asymmetric confidence thresholds (capture requires higher confidence than ask), tuned against the golden set at build time.
- Skip conditions hard-code intent for empty messages, attachment-only messages, command-invoked messages, `Ctrl/Cmd+Enter` (capture), and leading `?` (ask).
- Low-confidence results surface a non-blocking disambiguation chip above the composer.
- Decisions are silent except in dev mode; silent writes trigger a "saving as note" indicator.

See `classifier.md` for input contract, output contract, edge cases, evaluation plan, and prompt structure.

## Prompt library

Six system prompts are needed for v1. Each is versioned as a file in `prompts/` and stamped into the `cowork.version` field on any note written while that prompt is active, so eval regressions trace back to specific prompt revisions.

1. **`ingest-parser`** — turns raw user content into a structured `NoteSpec` candidate. Takes raw content + user instructions. Outputs JSON matching the contract in `rag.md`.
2. **`note-writer`** — formats the final Markdown body from a NoteSpec. Separate from the parser so body-format changes do not regress parsing.
3. **`intent-classifier`** — the classifier described above.
4. **`dedup-decider`** — given a candidate note and its top-k similar notes, decides whether to propose new, append, or split. Returns structured JSON with brief reasoning for the UI.
5. **`retrieval-reasoner`** — the main answering prompt. Consumes the compact retrieval package and produces an answer with structured citations.
6. **`synthesis-writer`** — combines multiple notes into a synthesis note. Invoked by `create_synthesis_note`.

Deferred to v2 or later: `judge` for eval faithfulness scoring, standalone `title-suggester` and `tag-suggester` prompts (v1 inlines these into `ingest-parser`), `related-notes-suggester` (v1 delegates this to retrieval), `error-translator` for user-friendly error messages.

## Error handling (placeholder)

Full error-surface catalog is not pinned in this document. v1 scope focuses on the happy path. All paths above assume success; failures surface as generic Notices and rows in the event log.

Before beta, an `errors.md` doc will enumerate each failure class, its user-visible message, the recovery affordance, and the log schema. Questions parked for that doc:

- What happens when a tool is called on a note that was renamed mid-turn?
- What happens when Ollama's model is hot-swapped while a turn is running?
- What does the user experience when the DuckDB index is corrupted?
- How do partial writes (Notice + Undo) integrate with Gemma's observed state in a later turn?
