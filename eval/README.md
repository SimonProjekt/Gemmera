# Eval harnesses

Two runners, both `tsx` scripts, both emit timestamped reports under
`eval/runs/<ts>/` and append a trend row to `eval/runs/metrics.jsonl`.

## Retrieval (`#16`)

```bash
npm run eval:retrieval:mock                            # full set, mock embedder
npm run eval:retrieval:mock -- --shard semantic        # one shard only
npm run eval:retrieval:ci                              # mock + regression gate
```

- **Golden set:** four JSONL shards under `evals/golden/`, one fixture
  mini-vault per shard under `evals/golden/fixtures/`. Schema lives in
  `evals/golden/README.md`.
- **Metrics:** Recall@10, Recall@30, MRR, citation correctness,
  retrieval + end-to-end latency P50/P95, per-`winningSignal`
  attribution.
- **Mock vs. live:** the default mock embedder is a deterministic
  hash → vector function; it gives a stable baseline for CI but cannot
  validate true semantic understanding. Run with a live Ollama
  embedder for a real read on semantic quality (live mode is not
  wired into `npm run` yet — invoke `tsx eval/runner/retrieval.ts`
  directly without `--mock` once that lands).

### Regression gate

```bash
npm run eval:retrieval:ci
```

Compares the current run to `eval/retrieval-golden/baseline.json`. A
Recall@10 drop of 10 percentage points or more is a P0 and fails the
run (exit 1). Smaller drops and drops in other metrics surface as
`[warn]` lines without failing.

After an *intentional* retrieval improvement (or after authoring new
golden examples), regenerate the baseline:

```bash
npm run eval:retrieval:mock -- --save-baseline eval/retrieval-golden/baseline.json
```

Review the diff, commit it in the same PR as the change that moved
the metric.

## Classifier (`#26 / #27`)

```bash
npm run eval:classifier:mock
npm run eval:classifier:ci      # mock + ask→capture FPR gate
npm run eval:classifier         # live mode against a running Ollama
```

See `eval/runner/classify.ts` for the full flag set.

## Out of scope (deferred)

- **LLM-judge faithfulness** — `planning/rag.md §Evaluation` defers
  this to v2.
- **Rule-based faithfulness** (every cited chunk landed in the
  retrieval payload) — needs the query tool loop running end-to-end
  with the LLM emitting citations. Will land alongside live mode for
  the retrieval runner.
- **In-app trend chart** — UI-surfaces v1 will read
  `eval/runs/metrics.jsonl`. Not built here.
- **Scheduled weekly run** — out of scope for RAG v1. Possibly a
  Runtime v1 follow-up; the CI job covers the regression case in the
  meantime.
