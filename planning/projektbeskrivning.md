# Historical Project Description

This document is kept as historical planning context for the original DD1349 course pitch. It no longer describes the current Gemmera implementation.

The current product is a TypeScript Obsidian plugin with local Ollama/Gemma orchestration, incremental indexing, retrieval, write tools, citation chips, and chat history. Use these files as the authoritative planning sources:

- [README.md](../README.md) for user-facing setup and feature status.
- [planning/overview.md](overview.md) for the current plugin architecture.
- [planning/runtime.md](runtime.md), [planning/rag.md](rag.md), [planning/tool-loop.md](tool-loop.md), [planning/ui-surfaces.md](ui-surfaces.md), and [planning/classifier.md](classifier.md) for subsystem details.

## Original Scope

The first course proposal was a smaller Python CLI:

- `kb compile` would read raw files and generate Obsidian-compatible wiki pages.
- `kb ask` would answer questions from the generated vault.
- `kb lint` would detect contradictions, orphan pages, and unsupported claims.
- The demo corpus would use the fictional Jonas Berg persona.
- All inference would run locally through Ollama with no cloud fallback.

That proposal was intentionally scoped for a four-week Python course project. The repository has since moved to the fuller Obsidian plugin architecture described in the other planning documents.

## Principles That Still Apply

- Local-first execution; no cloud fallback.
- Markdown files remain the canonical user-owned storage.
- Preview before writes by default.
- Append-only body updates for v1.
- Explicit confirmation before destructive actions.
- MIT license.

## Major Differences From The Current Implementation

| Original CLI proposal | Current Gemmera implementation |
|---|---|
| Python CLI commands | TypeScript Obsidian plugin |
| User manually runs `kb compile` / `kb ask` | User interacts through an Obsidian chat view |
| File-only retrieval | Hybrid retrieval with embeddings, BM25, and link-graph signals |
| No intent classifier | Classifier routes capture, ask, mixed, and meta turns |
| No tool loop state machines | Ingest/query/tool-loop state machines with retries and event logging |
| User manages Ollama manually | Plugin monitors and can restart the local Ollama runtime |

This file should not be used to decide new implementation work. Treat it as an archived snapshot of the early concept.
