//! Error type for the indexer crate.

use thiserror::Error;

/// Errors produced by the indexer.
#[derive(Debug, Error)]
pub enum IndexerError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("duckdb error: {0}")]
    Db(#[from] duckdb::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("invalid migration filename {0:?}: expected NNNN_description.sql")]
    MigrationFilename(String),

    #[error(
        "downgrade refused: database schema_version is {current} but the binary only knows up to {max}"
    )]
    DowngradeRefused { current: u32, max: u32 },

    #[error("error running migration {migration}: {source}")]
    Sql {
        migration: String,
        #[source]
        source: duckdb::Error,
    },

    #[error("http error: {0}")]
    Http(#[from] Box<ureq::Error>),

    #[error("ollama api error (status {status}): {body}")]
    OllamaApi { status: u16, body: String },

    #[error("schema compile error: {0}")]
    SchemaCompile(String),
}

/// Convenience alias.
pub type Result<T> = std::result::Result<T, IndexerError>;
