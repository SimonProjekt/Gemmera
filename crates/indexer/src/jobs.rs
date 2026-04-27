//! Job queue primitive backed by the `jobs` table (migration 0002).
//!
//! This module exposes the building blocks a worker uses to drive the
//! background pipeline (index/embed/ocr/...). It does **not** implement a
//! worker loop — `claim_one` is the atomic primitive; orchestration lives in
//! a separate issue.
//!
//! ## Crash recovery
//!
//! `claim_one` will reclaim a row whose `status = 'running'` but whose
//! `claimed_at` is older than `now - claim_ttl`. That covers a worker that
//! crashed without calling `mark_done` / `mark_failed`. `attempts` is bumped
//! on every claim so a poison pill cannot loop forever silently.
//!
//! ## Atomicity
//!
//! The claim is one SQL statement using `UPDATE ... WHERE id = (SELECT ...
//! LIMIT 1) RETURNING *`, so two threads cannot win the same row even when
//! sharing a `Connection` — DuckDB serialises writes inside the engine.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use chrono::{DateTime, Utc};
use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{IndexerError, Result};

/// Categories of background work the indexer knows how to do. Stored as
/// snake_case strings in the `jobs.kind` column so the table is easy to
/// inspect by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Index,
    Embed,
    Ocr,
    Transcribe,
    Reconcile,
}

impl fmt::Display for JobKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            JobKind::Index => "index",
            JobKind::Embed => "embed",
            JobKind::Ocr => "ocr",
            JobKind::Transcribe => "transcribe",
            JobKind::Reconcile => "reconcile",
        };
        f.write_str(s)
    }
}

impl FromStr for JobKind {
    type Err = IndexerError;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        Ok(match s {
            "index" => JobKind::Index,
            "embed" => JobKind::Embed,
            "ocr" => JobKind::Ocr,
            "transcribe" => JobKind::Transcribe,
            "reconcile" => JobKind::Reconcile,
            other => {
                return Err(IndexerError::MigrationFilename(format!(
                    "unknown job kind {other:?}"
                )))
            }
        })
    }
}

/// Lifecycle of a row in the `jobs` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    Running,
    Done,
    Failed,
}

impl fmt::Display for JobStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            JobStatus::Pending => "pending",
            JobStatus::Running => "running",
            JobStatus::Done => "done",
            JobStatus::Failed => "failed",
        };
        f.write_str(s)
    }
}

impl FromStr for JobStatus {
    type Err = IndexerError;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        Ok(match s {
            "pending" => JobStatus::Pending,
            "running" => JobStatus::Running,
            "done" => JobStatus::Done,
            "failed" => JobStatus::Failed,
            other => {
                return Err(IndexerError::MigrationFilename(format!(
                    "unknown job status {other:?}"
                )))
            }
        })
    }
}

/// One row of the `jobs` table.
#[derive(Debug, Clone)]
pub struct Job {
    pub id: u64,
    pub kind: JobKind,
    pub payload: serde_json::Value,
    pub status: JobStatus,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Insert a fresh `pending` row. Returns the new id.
pub fn enqueue(conn: &Connection, kind: JobKind, payload: serde_json::Value) -> Result<u64> {
    let now = Utc::now();
    let payload_text = serde_json::to_string(&payload)?;
    let id: u64 = conn.query_row(
        "INSERT INTO jobs (id, kind, payload, status, attempts, created_at, updated_at)
         VALUES (nextval('seq_jobs'), ?, ?, 'pending', 0, ?, ?)
         RETURNING id",
        params![
            kind.to_string(),
            payload_text,
            now.naive_utc(),
            now.naive_utc()
        ],
        |row| row.get::<_, u64>(0),
    )?;
    Ok(id)
}

/// Atomically pick the oldest pending job, OR the oldest `running` job whose
/// `claimed_at` is older than `now - claim_ttl` (a crashed worker), flip it
/// to `running`, stamp `claimed_at`, bump `attempts`, and return it.
///
/// Returns `Ok(None)` if there is nothing to claim.
pub fn claim_one(conn: &Connection, claim_ttl: Duration) -> Result<Option<Job>> {
    // DuckDB uses optimistic concurrency control: when two connections race
    // on the same row the loser gets a "transaction conflict" error rather
    // than blocking. Retry a bounded number of times with an exponential
    // backoff capped in the low-millisecond range — by the time the loser
    // re-runs the SELECT subquery, the winner's UPDATE has committed and the
    // conflicting row has flipped to status='running', so the loser picks a
    // different row (or correctly finds nothing).
    const MAX_RETRIES: u32 = 64;
    let mut attempt = 0u32;
    loop {
        match try_claim_one(conn, claim_ttl) {
            Ok(opt) => return Ok(opt),
            Err(e) if is_conflict(&e) && attempt < MAX_RETRIES => {
                let backoff_us = (1u64 << attempt.min(8)).min(2_000);
                std::thread::sleep(std::time::Duration::from_micros(backoff_us));
                attempt += 1;
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

fn try_claim_one(conn: &Connection, claim_ttl: Duration) -> Result<Option<Job>> {
    let now = Utc::now();
    let ttl_secs = claim_ttl.as_secs() as i64;
    let cutoff = now - chrono::Duration::seconds(ttl_secs);

    let mut stmt = conn.prepare(
        "UPDATE jobs
            SET status     = 'running',
                claimed_at = ?,
                attempts   = attempts + 1,
                updated_at = ?
          WHERE id = (
              SELECT id FROM jobs
               WHERE status = 'pending'
                  OR (status = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?)
            ORDER BY created_at ASC, id ASC
               LIMIT 1
          )
        RETURNING id, kind, payload, status, attempts, last_error,
                  claimed_at, created_at, updated_at",
    )?;

    let mut rows = stmt.query(params![
        now.naive_utc(),
        now.naive_utc(),
        cutoff.naive_utc()
    ])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_job(row)?)),
        None => Ok(None),
    }
}

fn is_conflict(e: &IndexerError) -> bool {
    if let IndexerError::Db(duckdb_err) = e {
        let msg = duckdb_err.to_string().to_lowercase();
        msg.contains("conflict") || msg.contains("transaction was aborted")
    } else {
        false
    }
}

/// Mark a row as successfully completed.
pub fn mark_done(conn: &Connection, id: u64) -> Result<()> {
    let now = Utc::now();
    conn.execute(
        "UPDATE jobs
            SET status     = 'done',
                last_error = NULL,
                updated_at = ?
          WHERE id = ?",
        params![now.naive_utc(), id],
    )?;
    Ok(())
}

/// Mark a row as failed and record the error string. Does NOT requeue —
/// the caller decides whether to enqueue a retry.
pub fn mark_failed(conn: &Connection, id: u64, err: &str) -> Result<()> {
    let now = Utc::now();
    conn.execute(
        "UPDATE jobs
            SET status     = 'failed',
                last_error = ?,
                updated_at = ?
          WHERE id = ?",
        params![err, now.naive_utc(), id],
    )?;
    Ok(())
}

fn row_to_job(row: &duckdb::Row<'_>) -> Result<Job> {
    let id: u64 = row.get(0)?;
    let kind_s: String = row.get(1)?;
    let payload_s: String = row.get(2)?;
    let status_s: String = row.get(3)?;
    let attempts: i64 = row.get(4)?;
    let last_error: Option<String> = row.get(5)?;
    let claimed_at: Option<chrono::NaiveDateTime> = row.get(6)?;
    let created_at: chrono::NaiveDateTime = row.get(7)?;
    let updated_at: chrono::NaiveDateTime = row.get(8)?;

    Ok(Job {
        id,
        kind: kind_s.parse()?,
        payload: serde_json::from_str(&payload_s)?,
        status: status_s.parse()?,
        attempts: attempts.max(0) as u32,
        last_error,
        claimed_at: claimed_at.map(|n| DateTime::<Utc>::from_naive_utc_and_offset(n, Utc)),
        created_at: DateTime::<Utc>::from_naive_utc_and_offset(created_at, Utc),
        updated_at: DateTime::<Utc>::from_naive_utc_and_offset(updated_at, Utc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_kind_round_trip() {
        for k in [
            JobKind::Index,
            JobKind::Embed,
            JobKind::Ocr,
            JobKind::Transcribe,
            JobKind::Reconcile,
        ] {
            let s = k.to_string();
            let back: JobKind = s.parse().unwrap();
            assert_eq!(k, back);
        }
    }

    #[test]
    fn job_status_round_trip() {
        for s in [
            JobStatus::Pending,
            JobStatus::Running,
            JobStatus::Done,
            JobStatus::Failed,
        ] {
            let back: JobStatus = s.to_string().parse().unwrap();
            assert_eq!(s, back);
        }
    }
}
