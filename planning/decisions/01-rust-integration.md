# Decision 01 — Rust indexer removed from working tree; RAG built in TypeScript

Date: 2026-05-05
Status: Accepted (supersedes the initial "deferred to post-MVP" framing)

## Context

The repo briefly carried two parallel implementations:

- `src/` — TypeScript Obsidian plugin (chat view, Ollama streaming, simple
  vault search). Shipped on `main` for week 1–2 MVP.
- `crates/indexer/` — Rust workspace started on the `RAG` branch. Waves 0–2
  shipped DuckDB index opener + migrations runner, core schema, jobs/events
  queue, frontmatter validator, Gemma tool schemas, and a reranker client.

Bridging the two halves requires NAPI, WASM, or out-of-process IPC — all
multi-day work that yields no user-visible improvement at MVP scale.

### Why a small model does not motivate Rust

Gemma E4B inference dominates wall-clock time per turn (seconds), while a
TypeScript retrieval pipeline over a personal vault (hundreds–thousands of
notes) runs in tens of milliseconds. What helps a small model is retrieval
**quality** (embedding model, reranker, chunking, hybrid scoring), all of
which are language-agnostic. Rust's edge — DuckDB + HNSW + BM25 hybrid —
only matters at scale we will not reach in this project.

## Decision

The Rust crate is **removed from the working tree** and the RAG pipeline is
built in TypeScript inside the plugin.

The Rust work is preserved on a long-lived local branch
**`archive/rust-indexer`** (not pushed to origin). It captures the full
state of Waves 0–2: migrations runner, core schema, jobs/events queue with
crash recovery, frontmatter validator, reranker client with caching, and
Gemma tool resolver — all under test (`cargo test --workspace` clean).

### What stays in the working tree

- `schemas/frontmatter.schema.json` — language-agnostic; the TS frontmatter
  validator will use it via `ajv`.
- `schemas/gemma-tools/*.json` — Gemma function-calling tool definitions;
  the TS tool dispatcher will read them.
- `planning/rag.md`, `planning/tool-loop.md`, etc. — design intent stays.

### What was removed

- `crates/indexer/`
- `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`
- Rust-specific entries in `.gitignore` (`/target`, `*.duckdb`, etc.)

## Consequences

- Phase-1 Storage issues #1, #2, #3 are **complete on the archive branch**
  for reference, but no longer claim space in the active codebase.
- The TypeScript RAG pipeline plugs into the existing `IndexService`
  contract (issue #48) — no UI or chat changes required.
- Plugin distribution stays simple: Obsidian + plugin + Ollama. No third
  runtime, no platform-specific binaries.

## When to revisit

If the eval set later shows TS retrieval quality is the bottleneck *and*
the Jonas demo grows past a few thousand notes, swap the `IndexService`
implementation for a Rust sidecar. The contract makes this possible
without UI changes; the archive branch is the starting point for that
work.

## How to access the archive

```
git checkout archive/rust-indexer
cargo test --workspace
```

The branch is local-only by design. If it ever needs to leave this
machine, push it explicitly: `git push -u origin archive/rust-indexer`.
