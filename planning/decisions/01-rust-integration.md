# Decision 01 — Rust indexer integration is deferred to post-MVP

Date: 2026-05-05
Status: Accepted

## Context

The repo carries two parallel implementations:

- `src/` — TypeScript Obsidian plugin (chat view, Ollama streaming, simple
  vault search). Shipped on `main` for week 1–2 MVP.
- `crates/indexer/` — Rust workspace started on the `RAG` branch. Waves 0–2
  shipped DuckDB index opener + migrations runner, core schema, jobs/events
  queue, frontmatter validator, Gemma tool schemas, and a reranker client.

The two halves do not talk to each other. Bridging them requires a TypeScript
runtime that can call into Rust: NAPI (Node native module, multi-day
toolchain work), WASM (no DuckDB story), or out-of-process IPC (HTTP / Unix
socket — extra runtime to install and supervise).

## Decision

For the 4-week course MVP, the Rust crate is **not on the critical path**.
Week-3 incremental indexing is implemented in TypeScript inside the plugin,
against the in-memory `MetadataCache` and `Vault` API.

The Rust crate remains in the repo as a parallel post-MVP exploration:
- Continue closing storage / ingestion issues there opportunistically.
- Do **not** spend MVP time on the NAPI/WASM/IPC bridge.
- Treat `crates/indexer/` as feature-complete-on-its-own-terms; the plugin
  does not depend on it landing.

## Consequences

- Phase-1 Storage issues #1, #2, #3 are closed by the Rust work alone — they
  describe the indexer's storage layer, not a TS-side dependency.
- Phase-2/3 ingestion + retrieval issues (#4–#11) get a TypeScript-flavored
  reinterpretation for the plugin: incremental file watcher, content
  hashing, simple scoring (already present in `src/search.ts`).
- The cross-track contract `IndexService` (issue #48) is defined as a
  TypeScript interface that *could* later be backed by either an in-process
  TS index or the Rust crate via IPC — implementations swap without UI
  changes.

## When to revisit

After v0.1 ships. If retrieval quality on the Jonas Berg eval set is
clearly bottlenecked by the in-process TS index, pick an integration route
and wire it behind the existing `IndexService` contract.
