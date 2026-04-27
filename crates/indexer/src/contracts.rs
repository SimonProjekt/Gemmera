//! Frozen contracts between RAG v1 components.
//!
//! Subagents implement against these types; the orchestrator owns this file.
//! Adding a field is fine; renaming or removing one requires re-coordinating
//! every wave that consumes the type.
//!
//! Real types are filled in by the issues that own them. This file exists in
//! Wave 0 so later waves have a single import path that does not move.

// Wave 1 / issue #1 will export an `IndexerDb` handle from `crate::db`.
// Wave 2 / issue #3 will export `JobKind`, `JobPayload`, `EventKind`.
// Wave 3 will export `Chunk`, `EmbedRequest`, `EmbedResponse`.
//
// Until those land, this module is intentionally empty so that
// `use indexer::contracts::*` is a stable import for downstream crates and
// the Obsidian plugin's IPC bindings.
