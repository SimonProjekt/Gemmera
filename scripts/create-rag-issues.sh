#!/usr/bin/env bash
# Creates the "RAG v1" milestone, supporting labels, and 16 issues
# implementing the architecture described in planning/rag.md.
#
# Idempotency: re-running will create duplicate issues. Run once.
# Labels and milestone creation tolerate "already exists" errors.

set -euo pipefail

REPO="${REPO:-SimonProjekt/Gemmera}"
MS_TITLE="RAG v1"
MS_DESC="Local-first RAG layer between Gemma and Obsidian: DuckDB index, markdown-aware chunking, hybrid retrieval + reranking, Gemma tool loop, and eval harness. See planning/rag.md."

echo "==> Repo: $REPO"

# ---------------------------------------------------------------------------
# 1. Milestone
# ---------------------------------------------------------------------------
MS_NUMBER=$(gh api "repos/$REPO/milestones?state=all" --jq ".[] | select(.title==\"$MS_TITLE\") | .number" | head -n1)
if [[ -z "$MS_NUMBER" ]]; then
  MS_NUMBER=$(gh api "repos/$REPO/milestones" \
    -f title="$MS_TITLE" \
    -f description="$MS_DESC" \
    --jq '.number')
  echo "==> Created milestone #$MS_NUMBER ($MS_TITLE)"
else
  echo "==> Reusing existing milestone #$MS_NUMBER ($MS_TITLE)"
fi

# ---------------------------------------------------------------------------
# 2. Labels
# ---------------------------------------------------------------------------
create_label() {
  local name="$1" color="$2" desc="$3"
  if gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" >/dev/null 2>&1; then
    echo "    + label $name"
  fi
}

echo "==> Ensuring labels"
create_label "area:storage"   "1f77b4" "DuckDB schema, migrations, index files"
create_label "area:ingestion" "2ca02c" "Vault events, hashing, chunking, embedding"
create_label "area:retrieval" "ff7f0e" "Hybrid search, reranking, payload assembly"
create_label "area:tools"     "9467bd" "Gemma function-calling tools and loops"
create_label "area:ops"       "8c564b" "Cold-start UX, controls, reconciliation"
create_label "area:eval"      "e377c2" "Golden set, metrics, regression detection"
create_label "phase:1"        "ededed" "Phase 1 — Storage foundation"
create_label "phase:2"        "ededed" "Phase 2 — Ingestion pipeline"
create_label "phase:3"        "ededed" "Phase 3 — Retrieval + tools"
create_label "phase:4"        "ededed" "Phase 4 — Operability + eval"

# ---------------------------------------------------------------------------
# 3. Issues
# ---------------------------------------------------------------------------
create_issue() {
  local title="$1" labels="$2" body="$3"
  local url
  url=$(gh issue create --repo "$REPO" \
    --title "$title" \
    --milestone "$MS_TITLE" \
    --label "$labels" \
    --body "$body")
  echo "    + $url"
}

echo "==> Creating issues"

# ---- Phase 1: Storage foundation ----

create_issue \
  "Storage: DuckDB index file + migrations runner" \
  "area:storage,phase:1,enhancement" \
  "$(cat <<'EOF'
Open `vault/.coworkmd/index.duckdb`, load the `vss` and `fts` extensions, and run versioned migrations from `crates/indexer/migrations/`. Track `schema_version` in a single-row `meta` table.

### Acceptance
- Fresh vault: file is created, extensions loaded, migrations applied, `meta.schema_version` populated.
- Existing vault: migrations run forward only; no destructive ops.
- App startup is idempotent and resumable.

### Reference
planning/rag.md §"Concrete DuckDB schema (DDL)" and §"Practical design rules".
EOF
)"

create_issue \
  "Storage: implement core schema DDL (notes, chunks, embeddings, links, tags, attachments)" \
  "area:storage,phase:1,enhancement" \
  "$(cat <<'EOF'
Implement the full DDL from planning/rag.md §"Concrete DuckDB schema (DDL)":

- `notes`, `chunks`, `embeddings`, `links`, `tags`, `attachments`
- HNSW index on `embeddings.vec` (`metric = 'cosine'`)
- FTS index on `chunks.text_for_embed` via `PRAGMA create_fts_index`
- Cascading deletes on `note_path` foreign keys

### Acceptance
- Migration creates every table, FK, and index without error on a fresh DuckDB file.
- `EXPLAIN` on a sample hybrid query shows HNSW + FTS used.
- Schema is documented inline in the migration file.
EOF
)"

create_issue \
  "Storage: jobs + events tables and queue helpers" \
  "area:storage,phase:1,enhancement" \
  "$(cat <<'EOF'
Add the `jobs` and `events` tables and small helpers used by every other component.

- `jobs`: enqueue, claim, mark `done`/`failed`, increment `attempts`, persist `last_error`.
- `events`: append-only writer keyed by `turn_id`, used by retrieval, tool calls, answers.

### Acceptance
- A worker can drain the `jobs` table without lost work on crash (claim resets after a TTL).
- Every chat turn produces at least one `events` row per kind (`prompt`, `tool_call`, `retrieval`, `answer`).
- Both tables are covered by basic unit tests.

### Reference
planning/rag.md §"File event handling" (backpressure) and §"Concrete DuckDB schema".
EOF
)"

# ---- Phase 2: Ingestion pipeline ----

create_issue \
  "Ingestion: subscribe to Obsidian Vault + MetadataCache events" \
  "area:ingestion,phase:2,enhancement" \
  "$(cat <<'EOF'
Wire `vault.on('create' | 'modify' | 'delete' | 'rename')` and `metadataCache.on('changed')` into the indexer. Each event enqueues a job rather than doing work inline.

- Hard-ignore: `.obsidian/`, `.git/`, `.coworkmd/`, `.trash/`.
- User-ignore: parse `.coworkignore` (see planning/runtime.md).
- Rely on Obsidian's internal debouncing — do not add another debounce layer.

### Acceptance
- Editing a note produces exactly one `modify` job after Obsidian's quiet period.
- Renames update `notes.path` without re-embedding.
- Excluded paths never produce jobs.
EOF
)"

create_issue \
  "Ingestion: content hashing and skip-on-match" \
  "area:ingestion,phase:2,enhancement" \
  "$(cat <<'EOF'
On every file event, sha256 the raw bytes and compare to `notes.content_hash`. Skip re-chunking and re-embedding when the hash matches. Frontmatter-only edits update metadata but skip embed.

### Acceptance
- Touching a file without changes is a no-op past the hash check.
- Frontmatter-only edit updates `notes.frontmatter` but does not insert new `embeddings` rows.
- Hash + mtime are persisted atomically with the chunk write.
EOF
)"

create_issue \
  "Ingestion: markdown-aware chunker (heading-first, structure-preserving)" \
  "area:ingestion,phase:2,enhancement" \
  "$(cat <<'EOF'
Implement the chunker described in planning/rag.md §"Concrete chunking parameters":

- Target 800 tokens, hard ceiling 1,200, overlap 100.
- Split first by headings, then paragraph boundaries.
- Code blocks are never split; oversize blocks become their own chunk and skip overlap.
- Lists split between top-level items, never inside one.
- Tables are one chunk up to ceiling; larger tables become "summary + N row-group" chunks.
- Frontmatter is excluded from chunk bodies.
- Every chunk's `text_for_embed` is `[note title] > [H1] > [H2] > ... \n\n [chunk body]`.

### Acceptance
- Round-trip on a fixture vault: every chunk respects ceiling and structural rules.
- `text_for_embed` always begins with the header path.
- Re-chunk only fires when `notes.content_hash` changes.
EOF
)"

create_issue \
  "Ingestion: BGE-M3 embedder service with batching" \
  "area:ingestion,phase:2,enhancement" \
  "$(cat <<'EOF'
Local BGE-M3 embedder writing to `embeddings(model, dim, vec)`.

- Batched inference, CPU/GPU autodetect.
- Self-throttle on battery / high CPU.
- Skip when the chunk's `content_hash` already has an embedding for the same `model`.

### Acceptance
- 5K-note cold start completes within the budget in planning/rag.md §"Cold start vs steady state" (10–30 min on modest hardware).
- Per-edit embed cost stays in the 50–500 ms window for typical notes.
- Model name + dim are persisted so a model swap triggers re-embed only for affected rows.
EOF
)"

create_issue \
  "Ingestion: frontmatter contract + JSON-schema validator" \
  "area:ingestion,phase:2,enhancement" \
  "$(cat <<'EOF'
Implement the strict contract from planning/rag.md §"Frontmatter contract":

- Validate against the schema before any write.
- Reject off-schema output and re-prompt the model once.
- Enforce: `title` ≤ 120 chars, `type` enum, `body_markdown` has no nested frontmatter, `related` paths exist or are flagged as new-link suggestions, `confidence: low` forces "needs review" UI.
- Compose the on-disk file (frontmatter + body) on the app side, never the model side.

### Acceptance
- A schema-invalid model response triggers exactly one retry, then surfaces a clean error.
- `cowork` block is always populated with `run_id`, `model`, `version`.
- Validator has unit tests covering each rejection case.
EOF
)"

# ---- Phase 3: Retrieval + tools ----

create_issue \
  "Retrieval: hybrid SQL (HNSW + BM25 + link-graph boost)" \
  "area:retrieval,phase:3,enhancement" \
  "$(cat <<'EOF'
Single-pass SQL that joins:

- HNSW top-k over `embeddings.vec` (cosine).
- BM25 hits from the FTS index on `chunks.text_for_embed`.
- One- and two-hop graph boosts from `links` (multiplicative, as in the published Obsidian RAG build).

Each result row is tagged with the winning signal: `semantic | lexical | backlink | tag | recency_boost`.

### Acceptance
- Query latency P50 ≤ 80 ms on a 5K-note vault (per planning/rag.md §"Steady state").
- Backlink-boosted results outrank pure-semantic matches on the golden-set tests that target link structure.
- Result rows always carry `winning_signal`.
EOF
)"

create_issue \
  "Retrieval: bge-reranker-v2-m3 cross-encoder with caching" \
  "area:retrieval,phase:3,enhancement" \
  "$(cat <<'EOF'
Rerank top-30 candidates → top-8 with bge-reranker-v2-m3.

- Cache scores per `(query_hash, chunk_hash)` for 15 minutes.
- Skip reranking for literal lookups (exact filename, exact tag, quoted phrase).
- Fallback alternatives documented in code comments: mxbai-rerank-base-v1, bge-reranker-v2-gemma.

### Acceptance
- Rerank latency P50 in the 100–300 ms window.
- Cache hit on a repeated query within 15 min returns in < 5 ms.
- Literal-lookup short-circuit verified by unit test.
EOF
)"

create_issue \
  "Retrieval: structured payload assembler for Gemma context" \
  "area:retrieval,phase:3,enhancement" \
  "$(cat <<'EOF'
Build the compact payload described in planning/rag.md §"What to send to Gemma":

- note title, chunk text, section heading, note path
- why-matched tag, optional score
- optional neighboring note titles (1-hop)

The payload is the only retrieval-derived input the chat loop hands to Gemma.

### Acceptance
- Payload size stays bounded (configurable max chunks, default 8).
- Source paths are preserved end-to-end so the UI can render citations.
- Snapshot tests cover payload shape.
EOF
)"

create_issue \
  "Tools: Gemma function definitions + JSON schemas" \
  "area:tools,phase:3,enhancement" \
  "$(cat <<'EOF'
Define the eight tools listed in planning/rag.md §"Recommended tool loop":

`ingest_content`, `retrieve_similar_notes`, `save_note`, `update_index`, `search_notes`, `rerank_results`, `get_note_context`, `create_synthesis_note`.

Each tool ships with a strict JSON schema suitable for constrained decoding (Ollama `format: "json"` or grammar). Schemas live alongside the tool implementation and are re-exported for the model loop.

### Acceptance
- All eight tools have schemas validated by a JSON-schema test.
- Schemas are wired into the constrained-decoding path so v1 can flip it on if Gemma's tool calls underperform (planning/rag.md §"If Gemma's tool calls underperform").
EOF
)"

create_issue \
  "Tools: ingest tool loop (with near-duplicate branch)" \
  "area:tools,phase:3,enhancement" \
  "$(cat <<'EOF'
Implement the on-upload sequence from planning/rag.md §"On upload":

1. `ingest_content`
2. backend extracts candidate note structure
3. `retrieve_similar_notes`
4. Gemma decides: new note, update existing, or link-only
5. `save_note`
6. `update_index`

The "near-duplicate found" branch must short-circuit to update-or-link without creating a duplicate file.

### Acceptance
- Re-uploading the same content does not create a second note; it surfaces the existing one.
- Updates preserve `cowork_managed = TRUE` invariants from planning/rag.md.
- Every step writes an `events` row.
EOF
)"

create_issue \
  "Tools: query tool loop (search → rerank → answer → optional synthesis)" \
  "area:tools,phase:3,enhancement" \
  "$(cat <<'EOF'
Implement the on-question sequence from planning/rag.md §"On question":

1. `search_notes` (hybrid)
2. `rerank_results`
3. `get_note_context` for the top-N if needed
4. Gemma answers grounded in the payload
5. Optional `create_synthesis_note` if the user wants the answer written back

### Acceptance
- Vault questions never bypass retrieval (enforced by a test that asserts at least one `retrieval` event per vault-tagged turn).
- Answers always include source paths in the UI payload.
- Synthesis notes carry the same `cowork` block + frontmatter contract as ingest output.
EOF
)"

# ---- Phase 4: Operability + eval ----

create_issue \
  "Ops: cold-start UX, indexer controls, weekly reconciliation" \
  "area:ops,phase:4,enhancement" \
  "$(cat <<'EOF'
Ship the operability surface described in planning/rag.md §"Cold start vs steady state":

- "Indexing X of Y" pill in the chat header during cold start.
- "Pause indexer" toggle.
- Idempotent, resumable "Rebuild index" affordance in settings.
- Weekly reconciliation job that re-hashes every file and reconciles drift between the vault and `notes`.

### Acceptance
- Pausing the indexer halts new job claims within one tick.
- Rebuild is safe to interrupt and resume without duplicate rows.
- Reconciliation logs (and exposes) any divergence it finds.
EOF
)"

create_issue \
  "Eval: golden set + retrieval metrics + weekly regression check" \
  "area:eval,phase:4,enhancement" \
  "$(cat <<'EOF'
Build the eval harness from planning/rag.md §"Evaluation: golden set and retrieval metrics".

- `evals/golden.jsonl` seeded with 30 `(question, ideal_note_paths, ideal_answer_summary)` examples.
- Metrics per run: Recall@10, Recall@30 (pre-rerank), MRR, citation correctness, latency P50/P95 for retrieval/rerank/generation/end-to-end.
- v1 faithfulness check is the rule-based version (every cited chunk exists in the retrieval payload). LLM-judge faithfulness is deferred to v2.
- Scheduled local job re-runs the set weekly, writes to a `metrics` table, app shows a small chart.
- Any ≥10% recall drop after a config change is flagged in the UI.

### Acceptance
- `pnpm eval` (or equivalent) runs the full set and prints metrics.
- A deliberate chunker regression in a test fixture trips the 10%-drop flag.
- Results are persisted so trend lines render in the UI.
EOF
)"

echo "==> Done."
