//! Append-only events log.
//!
//! Each row records one observable step in a Gemma turn: the user prompt,
//! tool calls the agent fired, retrieval payloads handed back from the
//! indexer, and the final answer. Backed by the `events` table from
//! migration 0002. Append-only — there is no `update` or `delete` API on
//! purpose, so the table doubles as an audit log.

use chrono::Utc;
use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// What happened in this event row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Prompt,
    ToolCall,
    Retrieval,
    Answer,
}

impl EventKind {
    fn as_str(self) -> &'static str {
        match self {
            EventKind::Prompt => "prompt",
            EventKind::ToolCall => "tool_call",
            EventKind::Retrieval => "retrieval",
            EventKind::Answer => "answer",
        }
    }
}

/// Append a single event row for `turn_id`. Returns the new id.
pub fn append(
    conn: &Connection,
    turn_id: &str,
    kind: EventKind,
    payload: serde_json::Value,
) -> Result<u64> {
    let now = Utc::now();
    let payload_text = serde_json::to_string(&payload)?;
    let id: u64 = conn.query_row(
        "INSERT INTO events (id, turn_id, kind, payload, ts)
         VALUES (nextval('seq_events'), ?, ?, ?, ?)
         RETURNING id",
        params![turn_id, kind.as_str(), payload_text, now.naive_utc()],
        |row| row.get::<_, u64>(0),
    )?;
    Ok(id)
}
