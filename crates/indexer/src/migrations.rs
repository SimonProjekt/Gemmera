//! Forward-only migrations runner.
//!
//! Migrations are embedded into the binary so the indexer needs no external
//! assets at runtime. Filenames must match `NNNN_description.sql`. Each file
//! is wrapped in a single transaction along with the `meta.schema_version`
//! bump so that a crash mid-migration leaves the DB at the previous version.

use duckdb::Connection;
use include_dir::{include_dir, Dir};

use crate::error::{IndexerError, Result};

/// Compile-time embed of all `.sql` files in `crates/indexer/migrations/`.
static MIGRATIONS_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/migrations");

/// One parsed migration, as it appears in `MIGRATIONS_DIR` (or in tests, on disk).
#[derive(Debug, Clone)]
pub(crate) struct Migration {
    pub version: u32,
    pub filename: String,
    pub sql: String,
}

/// Parse and validate a single filename, returning the leading version number.
fn parse_version(filename: &str) -> Result<u32> {
    // Expect `NNNN_description.sql`. The 4-digit prefix and the underscore are
    // both load-bearing — sort order is purely lexicographic.
    let stem = filename
        .strip_suffix(".sql")
        .ok_or_else(|| IndexerError::MigrationFilename(filename.to_string()))?;
    let (num, rest) = stem
        .split_once('_')
        .ok_or_else(|| IndexerError::MigrationFilename(filename.to_string()))?;
    if num.len() != 4 || !num.chars().all(|c| c.is_ascii_digit()) || rest.is_empty() {
        return Err(IndexerError::MigrationFilename(filename.to_string()));
    }
    num.parse::<u32>()
        .map_err(|_| IndexerError::MigrationFilename(filename.to_string()))
}

/// Collect migrations from the embedded directory, sorted ascending by version.
pub(crate) fn embedded_migrations() -> Result<Vec<Migration>> {
    let mut out = Vec::new();
    for file in MIGRATIONS_DIR.files() {
        let name = match file.path().file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".sql") {
            continue;
        }
        let version = parse_version(name)?;
        let sql = std::str::from_utf8(file.contents())
            .map_err(|_| IndexerError::MigrationFilename(name.to_string()))?
            .to_string();
        out.push(Migration {
            version,
            filename: name.to_string(),
            sql,
        });
    }
    out.sort_by_key(|m| m.version);
    Ok(out)
}

/// Collect migrations from a directory on disk. Used by the doc-hidden test
/// helper `IndexerDb::open_with_migrations_dir`; not part of the stable API.
pub(crate) fn migrations_from_dir(dir: &std::path::Path) -> Result<Vec<Migration>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.ends_with(".sql") {
            continue;
        }
        let version = parse_version(&name)?;
        let sql = std::fs::read_to_string(&path)?;
        out.push(Migration {
            version,
            filename: name,
            sql,
        });
    }
    out.sort_by_key(|m| m.version);
    Ok(out)
}

/// Read `meta.schema_version`. Returns `None` if the `meta` table does not
/// yet exist (fresh database, before migration 0000 has run).
fn current_schema_version(conn: &Connection) -> Result<Option<u32>> {
    // Check whether `meta` exists. DuckDB exposes information_schema.
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'meta'",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Ok(None);
    }
    let val: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .ok();
    match val {
        Some(s) => {
            let v: u32 = s
                .parse()
                .map_err(|_| IndexerError::MigrationFilename(format!("schema_version={s}")))?;
            Ok(Some(v))
        }
        None => Ok(None),
    }
}

/// Apply every migration whose version is strictly greater than the DB's
/// current `schema_version`. Idempotent: re-running on a populated DB only
/// performs the version check.
pub(crate) fn run(conn: &mut Connection, migrations: &[Migration]) -> Result<()> {
    let max_available = migrations.iter().map(|m| m.version).max();
    let current = current_schema_version(conn)?;

    if let (Some(cur), Some(max)) = (current, max_available) {
        if cur > max {
            return Err(IndexerError::DowngradeRefused { current: cur, max });
        }
    }

    for m in migrations {
        // For migrations strictly newer than what the DB has applied. A fresh
        // DB has `current = None`; treat it as "below every available version".
        let needs_apply = match current {
            Some(cur) => m.version > cur,
            None => true,
        };
        if !needs_apply {
            continue;
        }
        apply_one(conn, m)?;
    }
    Ok(())
}

fn apply_one(conn: &mut Connection, m: &Migration) -> Result<()> {
    let tx = conn.transaction().map_err(|e| IndexerError::Sql {
        migration: m.filename.clone(),
        source: e,
    })?;
    tx.execute_batch(&m.sql).map_err(|e| IndexerError::Sql {
        migration: m.filename.clone(),
        source: e,
    })?;
    // 0000 creates the `meta` table; subsequent migrations only update the row.
    // The INSERT in 0000 uses ON CONFLICT DO NOTHING so the row exists by now.
    tx.execute(
        "UPDATE meta SET value = ? WHERE key = 'schema_version'",
        [m.version.to_string()],
    )
    .map_err(|e| IndexerError::Sql {
        migration: m.filename.clone(),
        source: e,
    })?;
    tx.commit().map_err(|e| IndexerError::Sql {
        migration: m.filename.clone(),
        source: e,
    })?;
    tracing::info!(version = m.version, file = %m.filename, "applied migration");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_accepts_well_formed() {
        assert_eq!(parse_version("0000_meta.sql").unwrap(), 0);
        assert_eq!(parse_version("0042_widgets.sql").unwrap(), 42);
    }

    #[test]
    fn parse_version_rejects_garbage() {
        for bad in [
            "garbage.sql",
            "00_x.sql",
            "abcd_x.sql",
            "0001.sql",
            "0001_.sql",
        ] {
            assert!(parse_version(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn embedded_migrations_contain_meta() {
        let m = embedded_migrations().unwrap();
        assert!(!m.is_empty());
        assert_eq!(m[0].version, 0);
        assert_eq!(m[0].filename, "0000_meta.sql");
    }
}
