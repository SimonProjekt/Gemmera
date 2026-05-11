# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

```bash
npm run dev              # build + watch (esbuild, outputs main.js to repo root)
npm run build            # production build
npm test                 # run all tests once (vitest)
npm run test:watch       # vitest in watch mode

# Run a single test file
npx vitest run src/services/ollama-classifier.test.ts

# Classifier eval
npm run eval:classifier         # against live Ollama
npm run eval:classifier:mock    # mock backend (fast, no Ollama needed)
npm run eval:classifier:ci      # mock + compare against baseline (CI gate)
```

To test with a mock backend without touching Ollama, set `llmBackend: "mock"` in the vault's `.obsidian/plugins/gemmera/data.json`.

---

## Architecture

Gemmera is an **Obsidian plugin** (TypeScript, compiled to `main.js`). The Obsidian host is mocked in tests via `__mocks__/obsidian.ts`; all tests run in Node with `vitest`.

### Boot sequence (`src/main.ts` → `src/services/index.ts`)

`GemmeraPlugin.onload()` calls `createServices()` which wires up all services into a single `Services` bag and passes it to `GemmeraChatView`. Service lifetimes are plugin-scoped: `eventBridge`, `ingestionRunner`, and `embeddingService` are started on load and stopped on unload.

### Per-turn request flow (`src/view.ts`)

1. User submits text → `handleSend()`
2. `classifyMessage()` calls `ClassifierService.classify()` → returns a `ClassifierDecision` with label + confidence
3. If confidence is below `DEFAULT_THRESHOLDS` (defined in `src/contracts/classifier.ts`), a disambiguation chip is shown instead of routing
4. Routing: `ask` → `runAskPath` (RAG + streaming), `capture` → `runCapturePath` (also `runAskPath` for now; full ingest wiring tracked in #68), `mixed` → `runAskPath` (tracked in #47), `meta` → static help text

### Contracts and dependency injection (`src/contracts/`)

All service interfaces live in `src/contracts/`. Services in `src/services/` implement these. The mock implementations (`MockLLMService`, `MockClassifierService`) are the fast-path for tests — `createServices()` selects mock vs Ollama based on `settings.llmBackend`.

### Indexing pipeline

File events flow: `ObsidianVaultEventSource` → `VaultEventBridge` → `InMemoryJobQueue` → `IngestionRunner` → `HashGatedIngestionPipeline` (skip unchanged files) → `MarkdownChunker`. Cold-start vault reconciliation runs once on load via `VaultReconciler`. Embeddings are computed separately by `EmbeddingService` (BGE-M3 via Ollama, 1024-dim, stored in `.coworkmd/vectors.bin`).

### Classifier eval (`eval/`)

Golden set in `eval/classifier-golden/`. CI runs the mock eval and diffs against `baseline-mock.json`. When changing classifier prompts or thresholds, regenerate the baseline with `npm run eval:classifier:mock` and commit the updated JSON.

### Persistent state

`.coworkmd/state.json` — ingestion hashes (via `JsonIngestionStore`)
`.coworkmd/vectors.bin` / `vectors.json` — embedding index (via `BinaryVectorStore`)

These live inside the user's vault and are gitignored in demo-vault.

---

## Your rules

# CLAUDE.md — 12-rule template

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Use the model only for judgment calls
Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory
Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

## Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.
