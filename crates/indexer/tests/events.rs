//! Integration tests for issue #3: events log.

use indexer::events::{self, EventKind};
use indexer::IndexerDb;
use serde_json::json;
use tempfile::TempDir;

#[test]
fn append_one_of_each_kind_per_turn() {
    let tmp = TempDir::new().unwrap();
    let db = IndexerDb::open(tmp.path()).unwrap();
    let conn = db.conn();

    let turn = "turn-abc-123";
    let kinds = [
        EventKind::Prompt,
        EventKind::ToolCall,
        EventKind::Retrieval,
        EventKind::Answer,
    ];
    let mut ids = Vec::new();
    for k in kinds {
        let id = events::append(conn, turn, k, json!({"k": format!("{:?}", k)})).unwrap();
        ids.push(id);
    }

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM events WHERE turn_id = ?",
            duckdb::params![turn],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 4);

    // Ordering by ts is monotonic non-decreasing (ids are sequence-driven so
    // they are strictly monotonic; ts is wall-clock so it can tie at coarse
    // resolutions on fast machines).
    let mut stmt = conn
        .prepare("SELECT ts FROM events WHERE turn_id = ? ORDER BY id ASC")
        .unwrap();
    let rows: Vec<chrono::NaiveDateTime> = stmt
        .query_map(duckdb::params![turn], |row| {
            row.get::<_, chrono::NaiveDateTime>(0)
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(rows.len(), 4);
    for w in rows.windows(2) {
        assert!(w[0] <= w[1], "ts must be monotonically non-decreasing");
    }

    // Ids are strictly monotonic and disjoint.
    for w in ids.windows(2) {
        assert!(w[0] < w[1], "event ids must strictly increase");
    }
}
