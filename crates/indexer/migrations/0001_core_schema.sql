-- 0001_core_schema.sql
-- Core knowledge tables for the Cowork RAG index. The runner wraps this whole
-- file in one transaction and updates meta.schema_version, so we do NOT touch
-- meta here. CREATE TABLE IF NOT EXISTS is used everywhere as defense in depth
-- if an operator ever reapplies this manually.
--
-- Note on cascading deletes: DuckDB 1.10 rejects `ON DELETE CASCADE` at parse
-- time ("FOREIGN KEY constraints cannot use CASCADE, SET NULL or SET DEFAULT").
-- We declare plain `REFERENCES` for catalog integrity and do cascading deletes
-- in app code (e.g. `notes::delete` will explicitly clear chunks, links, tags,
-- attachments, then the note row). Wave 3 / issue #5 owns that helper.

CREATE TABLE IF NOT EXISTS notes (
    path           TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    mtime          TIMESTAMP NOT NULL,
    size_bytes     BIGINT NOT NULL,
    frontmatter    JSON,
    status         TEXT,
    cowork_managed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMP NOT NULL,
    updated_at     TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id             UBIGINT PRIMARY KEY,
    note_path      TEXT NOT NULL REFERENCES notes(path),
    ord            INTEGER NOT NULL,
    heading_path   TEXT,
    text           TEXT NOT NULL,
    text_for_embed TEXT NOT NULL,
    token_count    INTEGER NOT NULL,
    content_hash   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id   UBIGINT PRIMARY KEY REFERENCES chunks(id),
    model      TEXT NOT NULL,
    dim        INTEGER NOT NULL,
    vec        FLOAT[1024] NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
    src_path   TEXT NOT NULL REFERENCES notes(path),
    dst_path   TEXT NOT NULL,
    link_text  TEXT,
    PRIMARY KEY (src_path, dst_path, link_text)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_path);

CREATE TABLE IF NOT EXISTS tags (
    note_path  TEXT NOT NULL REFERENCES notes(path),
    tag        TEXT NOT NULL,
    PRIMARY KEY (note_path, tag)
);

CREATE TABLE IF NOT EXISTS attachments (
    path       TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    parent     TEXT REFERENCES notes(path),
    extracted  JSON
);

-- HNSW + FTS index creation are done by `db.rs::ensure_extension_indexes`
-- after migrations commit. Both PRAGMAs/extensions need the underlying tables
-- to be visible to a fresh statement-level read of the catalog, which the
-- single-transaction migration body cannot guarantee on DuckDB 1.10.
