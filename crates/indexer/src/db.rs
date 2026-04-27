//! Index file opener.
//!
//! Wraps a `duckdb::Connection`, ensures `.coworkmd/` exists, loads the `vss`
//! and `fts` extensions, then runs the embedded migrations. Re-opening the
//! same vault is idempotent.

use std::path::{Path, PathBuf};

use duckdb::Connection;

use crate::error::Result;
use crate::migrations;
use crate::paths;

/// Handle to the on-disk DuckDB index for one vault.
pub struct IndexerDb {
    conn: Connection,
    path: PathBuf,
}

impl std::fmt::Debug for IndexerDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexerDb")
            .field("path", &self.path)
            .finish()
    }
}

impl IndexerDb {
    /// Open (or create) the index for the given vault root.
    ///
    /// On first call this creates `.coworkmd/index.duckdb`, loads required
    /// extensions, and applies every embedded migration. On subsequent calls
    /// the migration loop is a fast no-op past the `schema_version` check.
    pub fn open(vault_root: &Path) -> Result<Self> {
        paths::ensure_cowork_dir(vault_root)?;
        let path = paths::index_path(vault_root);
        let mut conn = Connection::open(&path)?;
        load_extensions(&conn);
        let migs = migrations::embedded_migrations()?;
        migrations::run(&mut conn, &migs)?;
        Ok(Self { conn, path })
    }

    /// Test-only: open against a directory of migrations on disk so we can
    /// exercise version bumps and bad-filename errors without rebuilding the
    /// crate. Hidden from docs; not part of the stable API.
    #[doc(hidden)]
    pub fn open_with_migrations_dir(vault_root: &Path, migrations_dir: &Path) -> Result<Self> {
        paths::ensure_cowork_dir(vault_root)?;
        let path = paths::index_path(vault_root);
        let mut conn = Connection::open(&path)?;
        load_extensions(&conn);
        let migs = migrations::migrations_from_dir(migrations_dir)?;
        migrations::run(&mut conn, &migs)?;
        Ok(Self { conn, path })
    }

    /// Borrow the underlying DuckDB connection. Held mutably in case callers
    /// want to start their own transactions.
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Mutable access to the underlying connection.
    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Path of the DuckDB file on disk.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Best-effort load of `vss` and `fts`.
///
/// `INSTALL` reaches the network the first time on a given machine; once a
/// machine has the extension cached, `LOAD` alone is enough. We try `INSTALL`
/// every open (it's cheap and idempotent when cached) but only warn if it
/// fails — a sandboxed/offline host can still succeed at `LOAD` against a
/// previously-installed extension.
fn load_extensions(conn: &Connection) {
    for ext in ["vss", "fts"] {
        if let Err(e) = conn.execute_batch(&format!("INSTALL {ext};")) {
            tracing::warn!(extension = ext, error = %e, "INSTALL failed; will rely on cached extension");
        }
        if let Err(e) = conn.execute_batch(&format!("LOAD {ext};")) {
            // Loading is fatal-shaped but we don't want to brick `open`;
            // downstream code that actually needs vss/fts will surface the
            // failure with better context.
            tracing::warn!(extension = ext, error = %e, "LOAD failed");
        }
    }
}
