-- Issue #3: jobs queue + append-only events log.
--
-- DuckDB has no monotonic auto-increment, so ids are drawn from explicit
-- sequences. `claimed_at` is added on top of the planning doc's schema so
-- a worker that crashed mid-job can be detected by a TTL sweep — see
-- `claim_one` in src/jobs.rs.
--
-- The runner wraps this file in a transaction and bumps meta.schema_version
-- atomically; do not touch `meta` here.

CREATE SEQUENCE IF NOT EXISTS seq_jobs;
CREATE SEQUENCE IF NOT EXISTS seq_events;

CREATE TABLE IF NOT EXISTS jobs (
  id          UBIGINT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     JSON NOT NULL,
  status      TEXT NOT NULL,                  -- pending | running | done | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  claimed_at  TIMESTAMP,                      -- when a worker picked it up; reset on TTL
  created_at  TIMESTAMP NOT NULL,
  updated_at  TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, claimed_at);

CREATE TABLE IF NOT EXISTS events (
  id          UBIGINT PRIMARY KEY,
  turn_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                  -- prompt | tool_call | retrieval | answer
  payload     JSON NOT NULL,
  ts          TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id);
