# Cowork: overview

Cowork is a local, privacy-first Obsidian plugin that turns the user's vault into a Perplexity-style knowledge layer. Drop content into a chat — it becomes a structured note in the user's vault. Ask a question — it gets answered from existing notes with clickable citations. Everything runs locally; nothing leaves the machine.

This document is the start-here guide to the plan. Specialized docs cover each layer in depth.

## What the product does

One chat box, two user behaviors routed by an auto classifier:

- **Capture.** The user drops content with optional instructions ("save this as a meeting note about Q2"). Cowork parses it, checks the vault for duplicates, generates a preview note with title, tags, and frontmatter, and writes it to `Inbox/` after user confirmation.
- **Ask.** The user asks a question. Cowork retrieves from a hybrid index over the vault, reranks, and answers with citations back to specific notes.

Gemma is the orchestrator for both flows. The vault — plain Markdown files Obsidian already manages — is the canonical long-term store.

## MVP scope

What ships in v1:

- Obsidian plugin, desktop-only (`isDesktopOnly: true` in manifest).
- Local Gemma 4 E4B orchestration via Ollama. The plugin spawns and manages Ollama so users do not need to know it exists.
- BGE-M3 embeddings; bge-reranker-v2-m3 reranker.
- DuckDB index at `vault/.coworkmd/index.duckdb` (vector + BM25 + link graph).
- Responsive chat view, default in the right sidebar, pop-out to main-area tab or OS window.
- Capture path: paste/drop → parse → dedup check → preview → save to `Inbox/` → index.
- Ask path: plan → hybrid retrieve → rerank → stream answer with citations.
- Full CRUD from Gemma with safety rules:
  - Create / append via `save_note(mode=create|append)`.
  - Read via `search_notes`, `get_note`, `find_related_notes`, `list_folder`.
  - Update via `append` only (no full-body replacement in v1) and `update_frontmatter`.
  - Delete via `delete_note` — mandatory, non-overridable confirmation modal.
  - Rename / move via `rename_or_move_note`, which uses Obsidian's `FileManager.renameFile` so links update atomically.
- Six system prompts: `ingest-parser`, `note-writer`, `intent-classifier`, `dedup-decider`, `retrieval-reasoner`, `synthesis-writer`.
- `.coworkignore` (gitignore-style globs) for controlling indexing scope.
- Local event log at `vault/.coworkmd/events.duckdb`.
- Chat history persistence at `vault/.coworkmd/chats.duckdb`.
- Golden-set eval scaffolding for retrieval quality regressions.

Explicitly out of scope for v1:

- Mobile (desktop-only plugin).
- Cloud model fallback (local-only; no hosted provider integration).
- Full-body note rewrites (append is the only body-update mode).
- Model variants beyond E4B + BGE-M3 + reranker (no 26B MoE, no E2B, no swap ladder).
- PDF, image, and audio ingestion (plain text and Markdown only in v1).
- Canvas synthesis outputs.
- Graph view highlighting of cited notes.
- Localization.
- Dataview / Daily Notes / Templates integrations as first-class features.

## Architecture at a glance

The system is four layers inside a single Obsidian plugin:

1. **UI layer** — responsive `ItemView` chat, `NotePreviewModal` for pre-save confirmation, a dedicated delete-confirmation modal, standard settings and status surfaces. See `ui-surfaces.md`.
2. **Tool loop** — Gemma as orchestrator, a small set of well-defined tools, and two main state machines (ingest + query) plus a destructive-operation mini-state-machine. See `tool-loop.md`.
3. **RAG pipeline** — structure-aware chunking, BGE-M3 embeddings, hybrid retrieval with cross-encoder rerank and Obsidian graph boosts, stored in DuckDB. See `rag.md`.
4. **Runtime** — plugin-managed Ollama lifecycle, `.coworkignore` for indexing scope. See `runtime.md`.

The plugin reuses Obsidian's own `MetadataCache`, `Vault` events, `FileManager`, and `MarkdownRenderer` rather than reimplementing these subsystems. This is the single biggest reason to build as a plugin rather than standalone.

## Tech stack (pinned)

- Obsidian plugin, TypeScript, desktop-only.
- Ollama for local model serving (plugin spawns and manages).
- Gemma 4 E4B for all orchestration (~3 GB).
- BGE-M3 for embeddings (~2 GB).
- bge-reranker-v2-m3 for rerank (~0.6 GB).
- DuckDB with the `vss` extension for vectors and `fts` for BM25.
- MIT license.
- Distribution: BRAT during beta, Obsidian Community Plugins at GA.

## Milestones

**M1 — working local loop.** Plugin installs and manages Ollama, pulls the three required models, registers a right-sidebar chat view, and completes one end-to-end capture and ask cycle on plain text / Markdown content. Day-one acceptance tests (see below) pass.

**M2 — richer capture and full CRUD.** Dedup detection and the `ASK_USER_DEDUP` branch. `PROPOSE_APPEND`, `PROPOSE_SPLIT`, `PROPOSE_NEW_WITH_LINKS`. `delete_note` and `rename_or_move_note`. Frontmatter editing in the preview modal. Wide-mode tab layout with inline preview. Pop-out windows. `create_synthesis_note`.

**M3 — observability and beta polish.** Turn inspector (dev mode). Golden-set eval runner. `.coworkignore` editor with live re-evaluation. Chat history drawer with retention controls. Status bar, Notices with undo, context menus. Submit to BRAT.

## Day-one acceptance tests

Scripted tests that must pass before moving past M1:

1. Drop the same content twice. The second ingestion detects the near-duplicate via `retrieve_similar_notes` and offers "append to existing" instead of creating a duplicate.
2. Edit a note in Obsidian while the indexer is running. The index updates within 2 seconds; no edits are lost.
3. Delete a note in Obsidian. It disappears from retrieval results on the next query.
4. Kill the plugin mid-ingestion. No partial files remain in the vault; no orphan rows remain in DuckDB.
5. Open the plugin on a fresh install. Detect or install Ollama, pull all three models, and complete a first capture within 10 minutes of starting the install flow on a typical 8 GB laptop.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Gemma 4 E4B too weak for reliable structured ingestion | Medium | High | JSON-schema-constrained decoding at every structured output state. Revisit model choice only if this is insufficient. |
| Vault write race with Obsidian or sync | Medium | High | Reuse Obsidian's `Vault` and `FileManager` APIs; atomic writes; `mtime` + content-hash re-check before any non-additive edit. |
| Embedding cost on first index of a large vault | Medium | Medium | Background indexing with progress UI; respects "pause" switch; resumable on restart. |
| User loses trust after one bad auto-save | Low after mitigation | Catastrophic | "Always preview before save" defaults on. Delete requires a mandatory non-overridable confirmation. |
| Hallucinated citations | Medium | High | Validate every cited path against the retrieval payload; one retry with constrained instructions; reject answers that still cite missing paths. |
| Index drifts from vault state after sync conflicts | Medium | Medium | Hash-first event handling; weekly reconciliation pass; "rebuild index" setting. |
| Ollama install friction blocks first run | Medium | Medium | First-run modal with platform-aware one-click install (Homebrew, winget, upstream script) and manual path override. |

## Doc index

- `overview.md` — this file. MVP scope, architecture summary, milestones, doc map.
- `tool-loop.md` — tool inventory, state machine requirements, state machines, retry policy, hard stops, intent classifier scope, prompt library.
- `classifier.md` — intent classifier: taxonomy, input/output contract, skip conditions, confidence thresholds, disambiguation UX, evaluation.
- `rag.md` — chunking parameters, embeddings, hybrid retrieval, reranker, DuckDB schema, frontmatter contract, cold-start vs steady-state behavior, evaluation.
- `ui-surfaces.md` — chat view, preview modal, settings tab, status bar, ribbon, commands, context menus, notices, keyboard flow, accessibility.
- `runtime.md` — Ollama lifecycle and `.coworkignore` semantics.

Future docs (not yet needed):

- `errors.md` — error surface catalog.
- `roadmap.md` — v2+ features with scoping notes.

## Decisions committed

- Plugin architecture on top of Obsidian (not a standalone app).
- Desktop-only.
- Local-only: no cloud model fallback in v1.
- Single model set: Gemma 4 E4B + BGE-M3 + bge-reranker-v2-m3. No variants.
- Append-only body updates in v1. No full-body replacement tool.
- Gemma can create, read, append, rename, move, and delete notes. Delete always requires an explicit, non-overridable confirmation.
- Responsive chat view. Default to right sidebar. Pop-out to tab or OS window supported from day one.
- MIT license.
- Distribution: BRAT for beta, Community Plugins for GA.

## Open questions (parked, not blocking v1)

- Error surface catalog: failure classes, user messages, recovery affordances — `errors.md`.
- Exact confidence thresholds for the intent classifier — tuned during M1 against the classifier golden set.
- Exact prompt wording for the six v1 prompts — prompt-writing work that follows the spec in `tool-loop.md`.
- Dataview / Daily Notes / Templates integrations — v1.5 or v2.
- Canvas synthesis outputs — v2.
- Graph view highlighting — investigate feasibility, possibly v2.
- Mobile story — post-v1.
- Ollama service integration (LaunchAgent, Windows service, systemd) — post-v1.
