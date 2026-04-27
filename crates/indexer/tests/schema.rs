//! Integration tests for issue #2: core schema migration (0001).

use indexer::IndexerDb;
use tempfile::TempDir;

fn open_fresh() -> (TempDir, IndexerDb) {
    let tmp = TempDir::new().unwrap();
    let db = IndexerDb::open(tmp.path()).expect("open");
    (tmp, db)
}

fn table_exists(db: &IndexerDb, name: &str) -> bool {
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?",
            [name],
            |row| row.get(0),
        )
        .expect("query information_schema.tables");
    count > 0
}

fn index_exists(db: &IndexerDb, name: &str) -> bool {
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM duckdb_indexes() WHERE index_name = ?",
            [name],
            |row| row.get(0),
        )
        .expect("query duckdb_indexes()");
    count > 0
}

#[test]
fn schema_version_advances_past_zero() {
    let (_tmp, db) = open_fresh();
    let v: u32 = db
        .conn()
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
        .parse()
        .expect("schema_version is numeric");
    // 0001 (this issue) ⇒ ≥ 1; later issues add more migrations and we don't
    // want to chase that number with an edit per merge.
    assert!(v >= 1, "schema_version should be at least 1, got {v}");
}

#[test]
fn all_core_tables_exist() {
    let (_tmp, db) = open_fresh();
    for t in [
        "meta",
        "notes",
        "chunks",
        "embeddings",
        "links",
        "tags",
        "attachments",
    ] {
        assert!(table_exists(&db, t), "table {t} should exist");
    }
}

#[test]
fn expected_indexes_exist() {
    let (_tmp, db) = open_fresh();
    assert!(
        index_exists(&db, "idx_embeddings_vec"),
        "HNSW index missing"
    );
    assert!(index_exists(&db, "idx_links_dst"), "links index missing");
}

/// Insert one note + chunk and confirm the FTS index is queryable. The DuckDB
/// `fts` extension exposes `fts_main_chunks.match_bm25(id, query)` once
/// `PRAGMA create_fts_index('chunks','id','text_for_embed')` has run.
#[test]
fn fts_index_is_queryable() {
    let (_tmp, db) = open_fresh();
    let conn = db.conn();
    conn.execute_batch(
        "INSERT INTO notes (path, title, content_hash, mtime, size_bytes, status, created_at, updated_at) \
         VALUES ('a.md', 'A', 'h', TIMESTAMP '2025-01-01 00:00:00', 1, 'inbox', TIMESTAMP '2025-01-01 00:00:00', TIMESTAMP '2025-01-01 00:00:00'); \
         INSERT INTO chunks (id, note_path, ord, heading_path, text, text_for_embed, token_count, content_hash) \
         VALUES (1, 'a.md', 0, NULL, 'hello world foo', 'hello world foo', 3, 'ch');",
    )
    .expect("insert note + chunk");

    // After create_fts_index, BM25 scoring is available via the macro
    // fts_main_<table>.match_bm25(<key>, <query>). For an indexed token we
    // expect a non-NULL score on the matching row.
    // The FTS index is built when `db.rs::ensure_extension_indexes` runs, BEFORE
    // any chunks are inserted, so we need to rebuild it now to pick up our row.
    // Production code that mutates `chunks` will need an equivalent refresh
    // (issue #8 territory).
    conn.execute_batch("PRAGMA create_fts_index('chunks', 'id', 'text_for_embed', overwrite=1);")
        .expect("rebuild fts index");

    let mut stmt = conn
        .prepare(
            "SELECT id, fts_main_chunks.match_bm25(id, 'foo') AS score FROM chunks ORDER BY id",
        )
        .expect("prepare fts query");
    let mut rows = stmt.query([]).expect("run fts query");
    let row = rows.next().expect("step").expect("at least one row");
    let id: u64 = row.get(0).unwrap();
    let score: Option<f64> = row.get(1).unwrap();
    assert_eq!(id, 1);
    assert!(
        score.is_some(),
        "BM25 score for matching token should be non-NULL after refresh"
    );
}

/// Insert a chunk + 1024-dim embedding and confirm the HNSW index is used by
/// the cosine-distance query and the expected row comes back.
#[test]
fn hnsw_index_is_used() {
    let (_tmp, db) = open_fresh();
    let conn = db.conn();
    conn.execute_batch(
        "INSERT INTO notes (path, title, content_hash, mtime, size_bytes, status, created_at, updated_at) \
         VALUES ('a.md', 'A', 'h', TIMESTAMP '2025-01-01 00:00:00', 1, 'inbox', TIMESTAMP '2025-01-01 00:00:00', TIMESTAMP '2025-01-01 00:00:00'); \
         INSERT INTO chunks (id, note_path, ord, heading_path, text, text_for_embed, token_count, content_hash) \
         VALUES (1, 'a.md', 0, NULL, 't', 't', 1, 'ch');",
    )
    .expect("insert note + chunk");

    // Build a 1024-dim FLOAT array literal: [1.0, 0.0, 0.0, ...].
    let mut vec_lit = String::from("[1.0");
    for _ in 1..1024 {
        vec_lit.push_str(", 0.0");
    }
    vec_lit.push(']');

    let insert = format!(
        "INSERT INTO embeddings (chunk_id, model, dim, vec) VALUES (1, 'bge-m3', 1024, {vec_lit}::FLOAT[1024]);"
    );
    conn.execute_batch(&insert).expect("insert embedding");

    // EXPLAIN should mention HNSW once the planner picks the index.
    let query = format!(
        "SELECT chunk_id FROM embeddings ORDER BY array_cosine_distance(vec, {vec_lit}::FLOAT[1024]) LIMIT 1"
    );
    let explain_sql = format!("EXPLAIN {query}");
    let plan: String = {
        let mut stmt = conn.prepare(&explain_sql).expect("prepare EXPLAIN");
        let mut rows = stmt.query([]).expect("run EXPLAIN");
        let mut buf = String::new();
        while let Some(r) = rows.next().expect("step") {
            // EXPLAIN returns two columns (label, plan_text); concatenate both.
            let a: String = r.get(0).unwrap_or_default();
            let b: String = r.get(1).unwrap_or_default();
            buf.push_str(&a);
            buf.push('\n');
            buf.push_str(&b);
            buf.push('\n');
        }
        buf
    };
    assert!(
        plan.to_uppercase().contains("HNSW"),
        "EXPLAIN should mention HNSW; got:\n{plan}"
    );

    let id: u64 = conn.query_row(&query, [], |row| row.get(0)).unwrap();
    assert_eq!(id, 1);
}

#[test]
fn cascading_delete_clears_dependents() {
    let (_tmp, db) = open_fresh();
    let conn = db.conn();
    conn.execute_batch(
        "INSERT INTO notes (path, title, content_hash, mtime, size_bytes, status, created_at, updated_at) \
         VALUES ('a.md', 'A', 'h', TIMESTAMP '2025-01-01 00:00:00', 1, 'inbox', TIMESTAMP '2025-01-01 00:00:00', TIMESTAMP '2025-01-01 00:00:00'), \
                ('b.md', 'B', 'h', TIMESTAMP '2025-01-01 00:00:00', 1, 'inbox', TIMESTAMP '2025-01-01 00:00:00', TIMESTAMP '2025-01-01 00:00:00'); \
         INSERT INTO chunks (id, note_path, ord, heading_path, text, text_for_embed, token_count, content_hash) \
         VALUES (1, 'a.md', 0, NULL, 't', 't', 1, 'ch'); \
         INSERT INTO links (src_path, dst_path, link_text) VALUES ('a.md', 'b.md', 'B'); \
         INSERT INTO tags (note_path, tag) VALUES ('a.md', 'foo');",
    )
    .expect("seed rows");

    // Build a 1024-dim vector literal for one embedding.
    let mut vec_lit = String::from("[1.0");
    for _ in 1..1024 {
        vec_lit.push_str(", 0.0");
    }
    vec_lit.push(']');
    let emb = format!(
        "INSERT INTO embeddings (chunk_id, model, dim, vec) VALUES (1, 'bge-m3', 1024, {vec_lit}::FLOAT[1024]);"
    );
    conn.execute_batch(&emb).expect("insert embedding");

    // DuckDB 1.10 rejects `ON DELETE CASCADE` at parse time, so cascading is
    // app-level. The future `notes::delete` helper will run this sequence in
    // one transaction; this test asserts the schema permits the ordering.
    conn.execute_batch(
        "DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE note_path = 'a.md'); \
         DELETE FROM chunks WHERE note_path = 'a.md'; \
         DELETE FROM links WHERE src_path = 'a.md'; \
         DELETE FROM tags WHERE note_path = 'a.md'; \
         DELETE FROM notes WHERE path = 'a.md';",
    )
    .expect("cascading delete");

    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap() };
    assert_eq!(
        count("SELECT COUNT(*) FROM chunks WHERE note_path = 'a.md'"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM embeddings WHERE chunk_id = 1"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM links WHERE src_path = 'a.md'"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM tags WHERE note_path = 'a.md'"),
        0
    );
    // Untouched note still present.
    assert_eq!(count("SELECT COUNT(*) FROM notes WHERE path = 'b.md'"), 1);
}
