//! Integration tests for issue #3: jobs queue.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use indexer::jobs::{self, JobKind, JobStatus};
use indexer::IndexerDb;
use serde_json::json;
use tempfile::TempDir;

fn open_db() -> (TempDir, IndexerDb) {
    let tmp = TempDir::new().expect("tempdir");
    let db = IndexerDb::open(tmp.path()).expect("open db");
    (tmp, db)
}

#[test]
fn enqueue_then_claim_round_trip() {
    let (_g, db) = open_db();
    let conn = db.conn();

    let id = jobs::enqueue(conn, JobKind::Index, json!({"path": "vault/foo.md"})).expect("enqueue");
    assert!(id > 0);

    let job = jobs::claim_one(conn, Duration::from_secs(60))
        .expect("claim_one")
        .expect("a row to claim");
    assert_eq!(job.id, id);
    assert_eq!(job.kind, JobKind::Index);
    assert_eq!(job.status, JobStatus::Running);
    assert_eq!(job.attempts, 1);
    assert!(job.claimed_at.is_some(), "claimed_at should be stamped");
    assert_eq!(job.payload, json!({"path": "vault/foo.md"}));

    // Nothing else to claim.
    assert!(jobs::claim_one(conn, Duration::from_secs(60))
        .unwrap()
        .is_none());
}

#[test]
fn ttl_reclaims_crashed_running_job() {
    let (_g, db) = open_db();
    let conn = db.conn();

    let id = jobs::enqueue(conn, JobKind::Embed, json!({"chunk_id": 7})).expect("enqueue");
    let first = jobs::claim_one(conn, Duration::from_secs(60))
        .unwrap()
        .unwrap();
    assert_eq!(first.id, id);
    assert_eq!(first.attempts, 1);

    // Simulate a crashed worker by backdating claimed_at past the TTL.
    conn.execute(
        "UPDATE jobs SET claimed_at = TIMESTAMP '1970-01-01 00:00:00' WHERE id = ?",
        duckdb::params![id],
    )
    .unwrap();

    let again = jobs::claim_one(conn, Duration::from_secs(5))
        .unwrap()
        .expect("should reclaim crashed job");
    assert_eq!(again.id, id);
    assert_eq!(
        again.attempts, 2,
        "attempts must increment on every claim, including reclaim"
    );
    assert_eq!(again.status, JobStatus::Running);
}

#[test]
fn mark_done_and_mark_failed_round_trip() {
    let (_g, db) = open_db();
    let conn = db.conn();

    let ok_id = jobs::enqueue(conn, JobKind::Reconcile, json!({})).unwrap();
    jobs::claim_one(conn, Duration::from_secs(60)).unwrap();
    jobs::mark_done(conn, ok_id).expect("mark_done");

    let (status, last_err): (String, Option<String>) = conn
        .query_row(
            "SELECT status, last_error FROM jobs WHERE id = ?",
            duckdb::params![ok_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "done");
    assert!(last_err.is_none());

    let bad_id = jobs::enqueue(conn, JobKind::Ocr, json!({})).unwrap();
    jobs::claim_one(conn, Duration::from_secs(60)).unwrap();
    jobs::mark_failed(conn, bad_id, "tesseract exited 1").expect("mark_failed");

    let (status, last_err): (String, Option<String>) = conn
        .query_row(
            "SELECT status, last_error FROM jobs WHERE id = ?",
            duckdb::params![bad_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "failed");
    assert_eq!(last_err.as_deref(), Some("tesseract exited 1"));
}

#[test]
fn concurrent_claim_one_partitions_work() {
    let (_g, db) = open_db();
    let conn = db.conn();

    let n: usize = 20;
    let mut expected = Vec::with_capacity(n);
    for i in 0..n {
        let id = jobs::enqueue(conn, JobKind::Index, json!({ "i": i })).unwrap();
        expected.push(id);
    }

    let claimed_a: Mutex<Vec<u64>> = Mutex::new(Vec::new());
    let claimed_b: Mutex<Vec<u64>> = Mutex::new(Vec::new());

    // Each worker gets its own connection to the same DuckDB file. DuckDB's
    // `Connection` is `Send` but not `Sync`, so we cannot share `&Connection`
    // across threads — `try_clone` is the supported way.
    let conn_a = conn.try_clone().expect("clone conn a");
    let conn_b = conn.try_clone().expect("clone conn b");

    thread::scope(|scope| {
        let a_ref = &claimed_a;
        let b_ref = &claimed_b;
        scope.spawn(move || {
            while let Some(j) = jobs::claim_one(&conn_a, Duration::from_secs(60)).unwrap() {
                a_ref.lock().unwrap().push(j.id);
            }
        });
        scope.spawn(move || {
            while let Some(j) = jobs::claim_one(&conn_b, Duration::from_secs(60)).unwrap() {
                b_ref.lock().unwrap().push(j.id);
            }
        });
    });

    let mut a = claimed_a.into_inner().unwrap();
    let mut b = claimed_b.into_inner().unwrap();

    // Each thread sees a disjoint set, and the union covers every job.
    for id in &a {
        assert!(!b.contains(id), "id {id} double-claimed");
    }
    let mut all: Vec<u64> = a.drain(..).chain(b.drain(..)).collect();
    all.sort_unstable();
    let mut expected_sorted = expected.clone();
    expected_sorted.sort_unstable();
    assert_eq!(all, expected_sorted, "every enqueued job was claimed once");
}
