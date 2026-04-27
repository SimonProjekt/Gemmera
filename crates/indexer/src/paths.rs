//! Path resolution for the on-disk index.

use std::path::{Path, PathBuf};

use crate::error::Result;

/// Subdirectory of a vault root where the indexer keeps its private state.
pub const COWORK_DIR: &str = ".coworkmd";
/// Filename of the DuckDB index file inside `COWORK_DIR`.
pub const INDEX_FILE: &str = "index.duckdb";

/// Returns the path of the DuckDB index file for the given vault root.
///
/// This does *not* create the file; callers (e.g. [`crate::db::IndexerDb::open`])
/// are responsible for ensuring `.coworkmd/` exists with the right mode.
pub fn index_path(vault_root: &Path) -> PathBuf {
    vault_root.join(COWORK_DIR).join(INDEX_FILE)
}

/// Ensure `vault_root/.coworkmd/` exists. On Unix, the directory is created
/// with mode 0700 so other users on the host cannot read the embeddings or
/// note hashes. On other platforms we fall back to the OS default.
pub fn ensure_cowork_dir(vault_root: &Path) -> Result<PathBuf> {
    let dir = vault_root.join(COWORK_DIR);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(&dir, perms)?;
    }
    Ok(dir)
}
