# Migrations

Forward-only SQL migrations for the Cowork DuckDB index.

## Numbering (assigned by orchestrator, not by individual issues)

| File | Issue | Owner | Status |
|------|-------|-------|--------|
| `0000_meta.sql` | #1 | Wave 1 / Agent A | pending |
| `0001_core_schema.sql` | #2 | Wave 2 / Agent B | pending |
| `0002_jobs_events.sql` | #3 | Wave 2 / Agent C | pending |

Numbering is reserved up front so parallel agents do not collide on filenames.
Anything beyond `0002` is allocated as later waves are scoped.

## Rules

- Forward-only. No `DROP` of tables that hold user data.
- Each file is wrapped in a transaction by the runner; the runner also bumps
  `meta.schema_version` atomically with the migration body.
- Filenames must sort lexicographically (`NNNN_description.sql`).
- Migrations are embedded into the binary at compile time
  (`include_dir!`) so the indexer needs no external assets at runtime.
