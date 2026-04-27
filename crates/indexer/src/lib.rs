//! Cowork indexer.
//!
//! This crate owns the DuckDB-backed knowledge index that sits between the
//! Obsidian vault and the Gemma orchestration layer. See `planning/rag.md`
//! for the architecture; concrete contracts (chunk shape, embedder I/O, job
//! payloads) live in `contracts.rs` and are frozen before downstream issues
//! fan out.
//!
//! Modules are added incrementally as RAG v1 issues land:
//! - issue #1: `db` (open + migrations runner) and `paths`
//! - issue #2: `schema` (DDL via migration 0001)
//! - issue #3: `jobs`, `events`
//! - issue #5: `hashing`
//! - issue #6: `chunker`
//! - issue #7: `frontmatter`
//! - issue #8: `retrieval`
//! - issue #11: `embedder`

pub mod contracts;
pub mod db;
pub mod error;
pub mod paths;

mod migrations;

pub use db::IndexerDb;
pub use error::{IndexerError, Result};
