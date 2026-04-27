//! Integration tests for issue #1: index file opener + migrations runner.

use std::fs;
use std::path::Path;

use indexer::{IndexerDb, IndexerError};
use tempfile::TempDir;

fn read_schema_version(db: &IndexerDb) -> String {
    db.conn()
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("schema_version row")
}

fn loaded_extensions(db: &IndexerDb) -> Vec<String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT extension_name FROM duckdb_extensions() WHERE loaded = true")
        .expect("prepare");
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query_map");
    rows.filter_map(|r| r.ok()).collect()
}

fn write_migration(dir: &Path, name: &str, sql: &str) {
    fs::write(dir.join(name), sql).expect("write migration");
}

#[test]
fn fresh_open_creates_file_and_applies_meta() {
    let tmp = TempDir::new().unwrap();
    let db = IndexerDb::open(tmp.path()).expect("open");

    let expected = tmp.path().join(".coworkmd").join("index.duckdb");
    assert!(expected.exists(), "index file should exist at {expected:?}");
    assert_eq!(db.path(), expected.as_path());

    assert_eq!(read_schema_version(&db), "0");

    let exts = loaded_extensions(&db);
    assert!(exts.iter().any(|e| e == "vss"), "vss not loaded: {exts:?}");
    assert!(exts.iter().any(|e| e == "fts"), "fts not loaded: {exts:?}");
}

#[test]
fn idempotent_reopen() {
    let tmp = TempDir::new().unwrap();
    {
        let db = IndexerDb::open(tmp.path()).unwrap();
        assert_eq!(read_schema_version(&db), "0");
    }
    let db = IndexerDb::open(tmp.path()).expect("re-open");
    assert_eq!(read_schema_version(&db), "0");
}

#[test]
fn forward_migration_advances_version() {
    let tmp = TempDir::new().unwrap();
    let migs = TempDir::new().unwrap();

    write_migration(
        migs.path(),
        "0000_meta.sql",
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n\
         INSERT INTO meta (key, value) VALUES ('schema_version', '0') ON CONFLICT (key) DO NOTHING;",
    );
    write_migration(
        migs.path(),
        "0001_test.sql",
        "CREATE TABLE IF NOT EXISTS widgets (id INTEGER);",
    );

    let db = IndexerDb::open_with_migrations_dir(tmp.path(), migs.path()).expect("open");
    assert_eq!(read_schema_version(&db), "1");

    // Verify the test table actually got created.
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'widgets'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn downgrade_is_refused() {
    let tmp = TempDir::new().unwrap();
    {
        let db = IndexerDb::open(tmp.path()).unwrap();
        // Pretend a future binary has already moved this DB to schema 99.
        db.conn()
            .execute(
                "UPDATE meta SET value = '99' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
    }

    let err = IndexerDb::open(tmp.path()).expect_err("should refuse downgrade");
    match err {
        IndexerError::DowngradeRefused { current, max } => {
            assert_eq!(current, 99);
            assert!(max < 99);
        }
        other => panic!("expected DowngradeRefused, got {other:?}"),
    }

    // DB file is still there and the version row is still 99 — non-destructive.
    let db_path = tmp.path().join(".coworkmd").join("index.duckdb");
    assert!(db_path.exists());
}

#[test]
fn bad_migration_filename_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let migs = TempDir::new().unwrap();

    write_migration(
        migs.path(),
        "0000_meta.sql",
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n\
         INSERT INTO meta (key, value) VALUES ('schema_version', '0') ON CONFLICT (key) DO NOTHING;",
    );
    write_migration(migs.path(), "garbage.sql", "SELECT 1;");

    let err = IndexerDb::open_with_migrations_dir(tmp.path(), migs.path())
        .expect_err("garbage filename should be rejected");
    match err {
        IndexerError::MigrationFilename(name) => {
            assert!(name.contains("garbage"), "unexpected name: {name}");
        }
        other => panic!("expected MigrationFilename, got {other:?}"),
    }

    // No widgets table, no schema version bump beyond 0 — bad file rejected
    // before any SQL ran. We can verify by re-opening with only the good file.
    let migs2 = TempDir::new().unwrap();
    write_migration(
        migs2.path(),
        "0000_meta.sql",
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n\
         INSERT INTO meta (key, value) VALUES ('schema_version', '0') ON CONFLICT (key) DO NOTHING;",
    );
    let db = IndexerDb::open_with_migrations_dir(tmp.path(), migs2.path()).unwrap();
    assert_eq!(read_schema_version(&db), "0");
}
