RAG should sit between Gemma and Obsidian as the system’s memory and retrieval layer, so Gemma does not need to “index everything itself” or repeatedly read the whole vault. The best design is to use RAG to optimize all three stages you mentioned: input ingestion, indexing, and output answering. [unsloth](https://unsloth.ai/docs/models/gemma-4)

## Main idea

Think of the system as two loops sharing one knowledge layer. The ingestion loop turns dropped content into structured notes plus embeddings, and the query loop retrieves the best note fragments before Gemma answers. [ai.google](https://ai.google.dev/gemma/docs/core)

That separation matters because Gemma is good at parsing, summarizing, tool selection, and final synthesis, while RAG is what makes knowledge lookup fast, stable, and scalable. Published Obsidian RAG implementations explicitly separate retrieval from the final LLM layer and show better results by combining chunk embeddings with Obsidian link structure. [ai.google](https://ai.google.dev/gemma/docs/core)

## Where RAG fits

Here is the cleanest way to insert RAG into your architecture.

| Stage | What Gemma does | What RAG does | Why it helps |
|---|---|---|---|
| Input | Parses uploads and user instructions into note candidates.  [ai.google](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4) | Stores chunks, metadata, embeddings, links, and source mappings.  [ai.google](https://ai.google.dev/gemma/docs/core) | Makes new knowledge searchable immediately.  [ai.google](https://ai.google.dev/gemma/docs/core) |
| Indexing | Decides note type, tags, note splits, summaries, and related-note suggestions.  [ai.google](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4) | Builds and updates hybrid search indexes over vault content.  [ai.google](https://ai.google.dev/gemma/docs/core) | Prevents Gemma from reprocessing the whole vault on every prompt.  [ai.google](https://ai.google.dev/gemma/docs/core) |
| Output | Writes the final answer in chat and optionally creates synthesis notes.  [ai.google](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4) | Retrieves top chunks, graph neighbors, and note paths.  [ai.google](https://ai.google.dev/gemma/docs/core) | Grounds answers in your vault and improves relevance.  [ai.google](https://ai.google.dev/gemma/docs/core) |

## RAG for input

RAG should not only answer questions; it should help ingestion too. When the user drops in content, Gemma should first parse it, then query the existing knowledge base for similar notes before deciding how to store it. [ai.google](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4)

That means your ingestion flow becomes:
1. parse incoming content;
2. search the vault for related notes;
3. decide whether this should become a new note, an update to an existing note, or a note that links to existing concepts;
4. save the result and update the index. [ai.google](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4)

This streamlines input because Gemma can avoid duplicating notes, can suggest backlinks during save, and can attach the right frontmatter based on what already exists in the vault. The Obsidian RAG example shows that backlinks and multi-hop note relationships are especially valuable retrieval signals beyond semantic similarity alone. [ai.google](https://ai.google.dev/gemma/docs/core)

## RAG for indexing

RAG should own the indexing layer, not Gemma. Gemma should trigger indexing jobs and consume their results, but the actual indexing should be a deterministic pipeline. [unsloth](https://unsloth.ai/docs/models/gemma-4)

Your index should include:
- note metadata;
- frontmatter;
- note body chunks;
- headings;
- wikilinks and backlinks;
- tags and folders;
- source attachment metadata;
- note summaries. [ai.google](https://ai.google.dev/gemma/docs/core)

A strong Obsidian-oriented implementation uses markdown-aware chunking that respects heading boundaries, preserves code blocks, splits on paragraph breaks, and prepends title plus section heading to the chunk before embedding. That design improved retrieval quality in a published DuckDB-based Obsidian RAG implementation. [ai.google](https://ai.google.dev/gemma/docs/core)

## RAG for output

For output, Gemma should never answer from raw memory if the question targets the vault. Instead, the chat loop should always do retrieval first, then pass only the most relevant chunks plus metadata into Gemma for synthesis. [unsloth](https://unsloth.ai/docs/models/gemma-4)

A strong answer payload to Gemma would include:
- top semantic chunks;
- top lexical matches;
- graph-connected neighbors;
- source note paths;
- chunk summaries or section headings. [ai.google](https://ai.google.dev/gemma/docs/core)

This is the part that makes the experience feel like Perplexity: the model answers naturally, but the retrieval layer quietly assembles grounded context first. In the Gemma function-calling flow, this is exactly where Gemma would call tools like `search_notes`, `get_note`, or `find_related_notes` before producing the final answer. [unsloth](https://unsloth.ai/docs/models/gemma-4)

## Retrieval strategy

You should use hybrid retrieval, not vector search alone. The best pattern for your use case is semantic search plus lexical search plus graph-aware boosts from Obsidian links. [unstructured](https://unstructured.io/insights/knowledge-base-optimization-for-enterprise-rag-pipelines)

A good retrieval stack is:
- BM25 or full-text search for exact keywords, file names, aliases, and tags;
- vector similarity for semantic matching;
- reranking for final precision;
- graph boosting for backlinks, wikilinks, and one- to two-hop neighbors. [towardsai](https://towardsai.net/p/machine-learning/production-rag-the-chunking-retrieval-and-evaluation-strategies-that-actually-work)

The published Obsidian RAG build used graph-boosted search by multiplying similarity scores for notes that were also graph-connected, and found that this surfaced better results because the link structure encoded user intent that embeddings alone missed. [ai.google](https://ai.google.dev/gemma/docs/core)

## Chunking strategy

Chunking is one of the highest-leverage parts of the system. For Obsidian and Markdown-heavy content, structure-aware chunking is better than naive fixed windows. [blockchain-council](https://www.blockchain-council.org/ai/building-production-ready-rag-pipeline-vector-database-ingestion-chunking-metadata-retrieval-tuning/)

The best default for your vault is:
- split first by headings;
- preserve code blocks intact;
- split long sections by paragraph boundaries;
- keep chunk sizes moderate;
- prepend note title and section heading before embedding. [ai.google](https://ai.google.dev/gemma/docs/core)

One documented Obsidian RAG implementation used chunks around 512 characters with heading context attached, and another best-practices source recommends title-aware or structure-aware chunking for documents with clear headings because it preserves context and attribution better than character-only splitting. [unstructured](https://unstructured.io/insights/knowledge-base-optimization-for-enterprise-rag-pipelines)

### Concrete chunking parameters to default to

- **Target chunk length**: 800 tokens (roughly 600 words / 3,200 characters), with a hard ceiling of 1,200.
- **Overlap**: 100 tokens. Preserves context across heading boundaries without ballooning the index.
- **Header context prepend**: every chunk gets `[note title] > [H1] > [H2] > ...` prepended *before* embedding and stripped before display. This is the single highest-leverage chunking trick. Retrieval quality jumps because semantically thin chunks like "yes" or "maybe" gain enough context to match queries.
- **Code blocks**: never split. If a fenced block exceeds the ceiling, it becomes its own chunk and skips overlap.
- **Lists**: split between top-level items, never inside one. Bullet-heavy notes are otherwise unreadable after retrieval.
- **Tables**: kept as one chunk per table up to the ceiling. Larger tables become a "table summary plus N row-group chunks" pair.
- **Frontmatter**: not chunked into the body. Stored as structured metadata and used as filter and boost signals.
- **Re-chunk on note edit**: yes, but only when the note's content hash changes. Frontmatter-only edits skip re-embedding.

These numbers are starting defaults, not commandments. Treat them as the first row of an A/B grid the eval suite (see below) will tune.

## Reranking

After initial retrieval, you should rerank results before sending context to Gemma. This is especially important once your vault grows, because top semantic matches are often “close” but not the most directly useful answer context. [towardsdatascience](https://towardsdatascience.com/rag-explained-reranking-for-better-answers/)

The usual pattern is:
- retrieve 20 to 50 candidates cheaply;
- rerank them with a cross-encoder or higher-precision relevance stage;
- send only the top 5 to 10 chunks to Gemma. [towardsai](https://towardsai.net/p/machine-learning/production-rag-the-chunking-retrieval-and-evaluation-strategies-that-actually-work)

This reduces noise, lowers context bloat, and makes Gemma’s final answer more grounded. [towardsai](https://towardsai.net/p/machine-learning/production-rag-the-chunking-retrieval-and-evaluation-strategies-that-actually-work)

### Concrete reranker choice

Default to **bge-reranker-v2-m3** as a cross-encoder. It is small (~568M params), runs CPU-only at acceptable latency, and consistently outperforms vector-only retrieval on Markdown and knowledge-base tasks. Lightweight alternatives if CPU latency is too slow on a given machine: **mxbai-rerank-base-v1** (smaller, faster) or **bge-reranker-v2-gemma** (larger, GPU-friendly).

Operational rules:

- Rerank top 30 candidates from hybrid retrieval, return top 8 to Gemma.
- Cache rerank scores per `(query_hash, chunk_hash)` for 15 minutes. Repeated chats during a session reuse them.
- Tag each result with the *signal that won*: `semantic`, `lexical`, `backlink`, `tag`, or `recency_boost`. Send this tag in the payload so Gemma knows *why* a chunk is relevant, not just that it is.
- Skip reranking when the query looks like a literal lookup (exact filename, exact tag, quoted phrase). Reranking adds latency without adding value in those cases.

## How this optimizes Gemma

RAG improves Gemma across all three of your concerns.

### Indexing optimization
Gemma does not need to repeatedly inspect the entire vault because the index is precomputed and incrementally updated. The indexer handles embeddings, metadata extraction, and link graph updates, while Gemma just triggers or consumes those services. [ai.google](https://ai.google.dev/gemma/docs/core)

### Input optimization
On ingestion, Gemma can consult retrieval results before saving content, which helps classify the material, deduplicate it, link it to the right notes, and choose whether to create one note or several. [ai.google](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4)

### Output optimization
On answer generation, Gemma gets a compact, high-signal prompt made of only relevant chunks and note metadata, which makes responses faster, cheaper, and less likely to hallucinate beyond the vault. [jangwook](https://jangwook.net/en/blog/en/gemma-4-local-agent-edge-ai/)

## Recommended tool loop

The cleanest orchestration is an agent loop built around Gemma function calling. Google’s Gemma 4 docs describe a model turn, developer turn, and final response turn for tools, which maps very well to RAG workflows. [unsloth](https://unsloth.ai/docs/models/gemma-4)

Your production tools should look roughly like this:

- `ingest_content(content, instructions)`
- `retrieve_similar_notes(text, top_k)`
- `save_note(note_spec)`
- `update_index(paths)`
- `search_notes(query, mode)`
- `rerank_results(query, candidates)`
- `get_note_context(paths)`
- `create_synthesis_note(query, sources)` [unsloth](https://unsloth.ai/docs/models/gemma-4)

Then the model loop becomes:

### On upload
1. User drops content.
2. Gemma calls `ingest_content`.
3. Backend extracts candidate note structure.
4. Backend calls `retrieve_similar_notes`.
5. Gemma decides storage plan using both the upload and the related-note context.
6. Backend saves note.
7. Backend calls `update_index`. [unsloth](https://unsloth.ai/docs/models/gemma-4)

### On question
1. User asks a question.
2. Gemma calls `search_notes`.
3. Backend returns hybrid candidates.
4. Backend reranks.
5. Gemma answers from top context.
6. Optional: Gemma calls `create_synthesis_note` if user wants the answer written back into Obsidian. [towardsai](https://towardsai.net/p/machine-learning/production-rag-the-chunking-retrieval-and-evaluation-strategies-that-actually-work)

## Best database and index shape

For your use case, a local DuckDB-based retrieval layer is a very strong fit. A published Obsidian RAG system stored notes, links, chunks, embeddings, and hyperedge-style relations in DuckDB and used it successfully for semantic search, hidden connections, and graph traversal. [ai.google](https://ai.google.dev/gemma/docs/core)

A practical schema would include:
- `notes`
- `chunks`
- `links`
- `embeddings`
- `tags`
- `folders`
- `summaries`
- `attachments`
- `jobs` [ai.google](https://ai.google.dev/gemma/docs/core)

This works well because DuckDB lets you keep relational metadata and vector-like data in one local file, and the example implementation used it without requiring a separate dedicated vector database. [ai.google](https://ai.google.dev/gemma/docs/core)

### Concrete DuckDB schema (DDL)

The full index lives in one file at `vault/.coworkmd/index.duckdb`. The DDL below uses the `vss` extension for vector search and `fts` for BM25.

```sql
INSTALL vss; LOAD vss;
INSTALL fts; LOAD fts;

-- one row per Markdown file in the vault
CREATE TABLE notes (
  path           TEXT PRIMARY KEY,           -- vault-relative path
  title          TEXT NOT NULL,
  content_hash   TEXT NOT NULL,              -- sha256 of raw bytes
  mtime          TIMESTAMP NOT NULL,
  size_bytes     BIGINT NOT NULL,
  frontmatter    JSON,                       -- parsed YAML frontmatter
  status         TEXT,                       -- inbox | processed | linked | archived
  cowork_managed BOOLEAN NOT NULL DEFAULT FALSE,  -- did the app create this note
  created_at     TIMESTAMP NOT NULL,
  updated_at     TIMESTAMP NOT NULL
);

-- one row per chunk inside a note
CREATE TABLE chunks (
  id             UBIGINT PRIMARY KEY,
  note_path      TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,           -- position within the note
  heading_path   TEXT,                       -- "H1 > H2 > H3"
  text           TEXT NOT NULL,              -- chunk body without prepended context
  text_for_embed TEXT NOT NULL,              -- chunk body WITH prepended title + headings
  token_count    INTEGER NOT NULL,
  content_hash   TEXT NOT NULL               -- for re-embed skip
);

-- vector column lives alongside chunks
CREATE TABLE embeddings (
  chunk_id   UBIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,                  -- e.g. "bge-m3"
  dim        INTEGER NOT NULL,
  vec        FLOAT[1024] NOT NULL            -- size matches model.dim
);
CREATE INDEX idx_embeddings_vec ON embeddings USING HNSW (vec) WITH (metric = 'cosine');

-- BM25 over chunk text
PRAGMA create_fts_index('chunks', 'id', 'text_for_embed');

-- explicit Obsidian links (wikilinks + markdown links)
CREATE TABLE links (
  src_path   TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  dst_path   TEXT NOT NULL,                  -- may not yet exist (broken link)
  link_text  TEXT,
  PRIMARY KEY (src_path, dst_path, link_text)
);
CREATE INDEX idx_links_dst ON links(dst_path);

-- tags as a separate facet for fast filter + boost
CREATE TABLE tags (
  note_path  TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (note_path, tag)
);

-- attachments referenced by notes
CREATE TABLE attachments (
  path       TEXT PRIMARY KEY,               -- vault-relative
  kind       TEXT NOT NULL,                  -- pdf | image | audio | other
  parent     TEXT REFERENCES notes(path),
  extracted  JSON                            -- parsed text, ocr, transcript metadata
);

-- background jobs (indexing, embedding, ocr, transcription)
CREATE TABLE jobs (
  id          UBIGINT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     JSON NOT NULL,
  status      TEXT NOT NULL,                 -- pending | running | done | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMP NOT NULL,
  updated_at  TIMESTAMP NOT NULL
);

-- everything that happened in a turn, for debugging + eval
CREATE TABLE events (
  id          UBIGINT PRIMARY KEY,
  turn_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- prompt | tool_call | retrieval | answer
  payload     JSON NOT NULL,
  ts          TIMESTAMP NOT NULL
);
```

A few notes on the shape:

- The hybrid retrieval query joins `embeddings` (vector top-k via HNSW), the FTS index over `chunks.text_for_embed`, and `links` for one- and two-hop graph boosts in a single SQL pass. DuckDB happily does this.
- `cowork_managed = TRUE` is what the app checks before any non-additive write, alongside the `mtime` and `content_hash` re-read described in `instruction.md`.
- `events` is the local-only telemetry table. It powers the "what happened in this turn?" inspector.
- Schema migrations live in `crates/indexer/migrations/` and run on app start. The `schema_version` is stored in a tiny `meta` table (one row).

## What to send to Gemma

Do not send raw retrieved chunks alone. Send a compact structured retrieval package. [ai.google](https://ai.google.dev/gemma/docs/core)

A good context payload is:
- note title
- chunk text
- section heading
- note path
- why it matched, such as semantic, lexical, backlink, or tag
- optional score
- optional neighboring note titles [ai.google](https://ai.google.dev/gemma/docs/core)

That gives Gemma enough grounding to answer naturally while still preserving source traceability. It also lets you display note citations or “related notes” in the UI. [ai.google](https://ai.google.dev/gemma/docs/core)

## Frontmatter contract (the structured object Gemma fills)

The model never invents the file format. It returns a strict JSON object that the app validates and then writes. Anything off-schema is rejected and the model is asked to retry once.

```jsonc
{
  "title": "Q2 planning meeting",
  "type": "meeting",                     // source | evergreen | project | meeting | person | concept
  "tags": ["q2", "planning", "team"],
  "aliases": [],
  "source": "chat-paste",                // chat-paste | pdf | webpage | image | audio | manual
  "entities": ["Alice", "Bob", "billing-v2"],
  "related": ["projects/billing-v2.md"], // candidate links from retrieve_similar_notes
  "status": "inbox",
  "summary": "...",                      // 1-3 sentences
  "key_points": ["..."],
  "body_markdown": "...",                // the actual note body
  "cowork": {
    "source": "ingest",
    "run_id": "01HW...",
    "model": "gemma4-e4b",
    "version": "0.3.1",
    "confidence": "high"                 // high | medium | low
  }
}
```

Validation rules the app enforces before write:

- `title` non-empty and ≤ 120 chars.
- `type` is one of the enumerated values.
- `body_markdown` does not contain its own frontmatter block (the app composes the final file).
- `related` paths exist *or* are explicitly marked as new-link suggestions in the preview UI.
- `confidence: low` forces the preview UI into "needs review" mode regardless of user defaults.

This contract is the single most important thing to get stable. Once it is, everything downstream (chunking, indexing, retrieval) gets predictably better inputs.

## File event handling

Because Cowork runs inside Obsidian, the file watcher does not need to be built. Obsidian's own `Vault` and `MetadataCache` events replace what would otherwise be a cross-platform watcher layer.

- **Subscriptions**: `vault.on('create' | 'modify' | 'delete' | 'rename')` and `metadataCache.on('changed')`. The metadataCache event fires after Obsidian has already re-parsed the file, so the indexer reacts to a structured delta rather than raw bytes.
- **Debouncing and coalescing**: Obsidian debounces its own events, so the indexer does not need its own quiet-period logic. Multiple edits to the same file in quick succession surface as a single `modify` after Obsidian's internal delay.
- **Ignore patterns**: `.obsidian/`, `.git/`, `.coworkmd/`, `.trash/` are hard-coded exclusions. User-configured exclusions live in `.coworkignore` (see `runtime.md`).
- **Hash before re-embed**: every file event re-hashes the content. If the hash matches `notes.content_hash`, skip re-chunk and re-embed.
- **Backpressure**: events feed into the `jobs` table. The indexer drains it. On cold start or large syncs, the indexer self-throttles based on CPU and battery state.

This section is small on purpose: the heavy lifting is Obsidian's.

## Cold start vs steady state

A vault might be 50 notes or 50,000. The pipeline behaves differently in those two regimes and the app should be honest about it.

### First index of a 5K-note vault on an 8 GB laptop
- Initial scan: walk the vault, hash every file, populate `notes` and `chunks` rows. About 1-3 minutes.
- Embedding: BGE-M3 at ~50 chunks/sec on CPU, ~300/sec on a modest GPU. Expect 10-30 minutes for 5K notes the first time. Run in background. Show progress per folder.
- BM25: built incrementally as chunks are inserted. Effectively free.
- The user can already chat during this period; retrieval just returns smaller candidate sets until embedding catches up.

### Steady state
- Per-edit cost: 50-500 ms total for chunk + embed + index update on a typical note.
- Per-query cost: 30-80 ms hybrid retrieval, 100-300 ms rerank, then whatever the LLM takes.

### Observable behaviors the app should expose
- A small "indexing X of Y" pill in the chat header during cold start.
- A "pause indexer" toggle, useful when sync is doing batch work.
- A "rebuild index" affordance in settings, idempotent and resumable.
- A weekly reconciliation job that re-hashes every file and reconciles drift between the vault and `notes`.

## Evaluation: golden set and retrieval metrics

RAG quality regresses silently. A model swap, an embedding upgrade, a chunking tweak — any of them can quietly tank recall, and you will only notice weeks later when answers feel "off." Build the eval loop early.

### Golden set
Hand-curate 30 examples to start, grow toward 200 as the vault grows. Each example is `(question, ideal_note_paths, ideal_answer_summary)`. Store them in `evals/golden.jsonl`. Re-run on every change to chunking, embedding model, retriever, or reranker.

### Metrics to track per run
- **Recall@10**: fraction of ideal note paths that appear in the top-10 retrieval results. Healthy chunker and embedder if this is high.
- **Recall@30** (pre-rerank): same but on the candidate set. Distinguishes "retriever is bad" from "reranker is bad."
- **MRR** of the top ideal path: healthy reranker if this is high.
- **Faithfulness**: does every claim in the generated answer trace back to a retrieved chunk? The `judge` prompt that scores this is deferred to v2 (see `tool-loop.md` prompt library); v1 runs a simpler rule-based check that verifies each claim's cited chunk exists in the retrieval payload.
- **Citation correctness**: do cited paths actually contain the claim?
- **Latency P50 / P95** for retrieval, rerank, generation, end-to-end.

### Continuous eval
A scheduled local job re-runs the golden set weekly, writes results to a `metrics` table, and the app shows a small chart. Any 10%+ recall drop after a config change is flagged in the UI.

## If Gemma's tool calls underperform

v1 commits to Gemma 4 E4B as the sole orchestration model. No cloud fallback, no alternate open models, no larger Gemma variants. If tool-calling proves unreliable in practice, the response is **constrain harder, do not switch**: move to JSON-schema-constrained decoding (Ollama's `format: "json"` or a schema grammar) at every structured-output state in `tool-loop.md`. This eliminates schema-invalid JSON entirely and addresses most reliability issues without touching the model choice.

Model-swap options are intentionally deferred past v1. Revisit in a `model-strategy.md` doc only if constrained decoding does not get us where we need to be.

Even without an LLM, hybrid retrieval, reranking, and Obsidian-native storage already give "search my vault better than Obsidian's built-in search." That is the floor and it is respectable.

## Practical design rules

Use these rules from the start:

- Always retrieve before answering vault-based questions. [ai.google](https://ai.google.dev/gemma/docs/core)
- Always search for related notes before saving new content. [ai.google](https://ai.google.dev/gemma/docs/core)
- Use incremental indexing, not full reindex unless explicitly requested. [ai.google](https://ai.google.dev/gemma/docs/core)
- Prefer markdown-aware chunking over fixed windows. [unstructured](https://unstructured.io/insights/knowledge-base-optimization-for-enterprise-rag-pipelines)
- Use hybrid retrieval plus reranking. [towardsdatascience](https://towardsdatascience.com/rag-explained-reranking-for-better-answers/)
- Include source note paths in retrieval results and final UI answers. [ai.google](https://ai.google.dev/gemma/docs/core)
- Let Gemma orchestrate tools, but keep indexing and storage deterministic in your backend. [unsloth](https://unsloth.ai/docs/models/gemma-4)

## Best version for your product

For the product you described, the strongest version is an agentic local RAG system where Gemma is the planner and writer, while RAG is the memory engine. Gemma should decide when to ingest, search, update, summarize, or synthesize; RAG should handle chunking, embeddings, lexical search, graph search, reranking, and source retrieval. [unsloth](https://unsloth.ai/docs/models/gemma-4)

That gives you:
- Perplexity-style chat UX,
- Obsidian-native durable knowledge,
- local-first privacy,
- scalable retrieval,
- and much better note linking and deduplication than a plain chat history system. [jangwook](https://jangwook.net/en/blog/en/gemma-4-local-agent-edge-ai/)

## My concrete recommendation

Build RAG as a shared service with two entrypoints: `ingest` and `query`. On `ingest`, Gemma parses uploads and uses retrieval to place new knowledge correctly before saving. On `query`, Gemma uses hybrid retrieval, reranking, and graph-aware expansion to answer from the vault. Store notes and metadata in Obsidian, store chunks and embeddings in DuckDB, and use Gemma function calling as the orchestration layer across both flows. [unsloth](https://unsloth.ai/docs/models/gemma-4)

The concrete DuckDB schema, chunking parameters, reranker choice, watcher rules, and frontmatter contract above are the missing layer that the original plan kept gesturing at. With those pinned, the next thing worth writing is the Gemma tool-loop state machine — the exact sequence of `ingest_content → retrieve_similar_notes → propose_notes → save_note → update_index` calls including the "near-duplicate found" branch — and the JSON schemas for each tool. That, plus a diagram showing how the watcher, indexer, and chat loop share the `jobs` table, is the last piece before building.