# Intent classifier

This document pins the design of the intent classifier, which runs before the main tool loop on every user message to route it to the capture path, the ask path, both, or the meta path.

## Decision summary

- Pure LLM classification using Gemma 4 E4B, shared with the main orchestrator. No rules fast path in v1.
- Flat taxonomy: {`capture`, `ask`, `mixed`, `meta`}. No sub-labels.
- Structured JSON output with label, confidence, and one-line rationale.
- Disambiguation chip above the composer when confidence is below threshold.
- Asymmetric confidence thresholds (capture requires higher confidence than ask), tuned against the golden set at build time.
- Dev-mode-only transparency, with one exception for silent captures.
- No learning from corrections in v1. No active-editor-selection input (users copy selections into the composer if they want them classified).

## Implementation

### Model

The classifier runs on Gemma 4 E4B, the same model Ollama loads for orchestration. A separate smaller model was rejected because v1 commits to a single model set, and a second model load would exceed any gain from cheaper classification.

Because Ollama serializes calls against a single loaded model, classification adds its full latency to every non-skipped turn — there is no parallelism with the main loop. The budget is 200 ms; the classifier prompt is short, the output is a small JSON object under `format: "json"` constrained decoding, and 200 ms on E4B for that shape is achievable on a typical 8 GB laptop.

### When the classifier runs

Every user message hits the classifier *unless* the intent is already known from a hard signal (see skip conditions below). Skipping is the only classifier-latency optimization in v1 because there is no rules fast path.

### Skip conditions

- The message is empty → error, show a "type something" hint. No classifier call.
- The message has attachments but no text → pre-route to `capture`.
- The message was submitted via a command with a pre-set intent — `cowork.capture-selection`, `cowork.capture-active-note`, `cowork.ask-about-active-note`. Intent is hard-coded.
- The user submitted with `Ctrl/Cmd+Enter` → pre-route to `capture`.
- The user prefixed the message with `?` → pre-route to `ask`.

Every skip still writes a `classifier_decision` event with `source: "skip"` and the reason, so the turn inspector is consistent.

## Intent taxonomy

| Label | Meaning | Routes to |
|---|---|---|
| `capture` | User wants to save content to the vault. | Ingest state machine. |
| `ask` | User wants an answer from the vault. | Query state machine. |
| `mixed` | User wants both, typically "save this and tell me X." | Ingest first, then query with the new note included. |
| `meta` | User is asking about the app itself, not the vault. | Deterministic help lookup. No main loop call. |

Sub-labels within `capture` and `ask` are deferred. The ingest state machine's `DECIDE_STRATEGY` handles capture sub-routing from content signals; the query state machine's `PLAN_RETRIEVAL` handles ask sub-routing from query shape.

## Input contract

The classifier prompt receives:

- **Current message text** (required). Full string up to 8 KB. Longer messages are truncated with a marker; truncation is logged.
- **Attachment metadata**: for each attachment, the kind (`pdf`, `image`, `audio`, `text`) and filename. Contents are not included — too large for a 200 ms budget.
- **Active file context**: filename and title of the currently open note, if any. Not the body.
- **Last 3 chat turns**: user message text and the final intent label of each. Recent turns resolve references like "save that" or "tell me more."

The classifier deliberately does not see: the user's editor selection, vault statistics, retrieval results, or the body of the active note.

## Output contract

A single JSON object under `format: "json"`:

```json
{
  "label": "capture",
  "confidence": 0.87,
  "rationale": "User pasted a long block with 'save this as meeting notes'."
}
```

Three fields. No trailing prose. `confidence` is a raw model-reported probability in `[0.0, 1.0]`.

## Confidence thresholds

The exact threshold numbers are tuned during build against the classifier golden set. The shape is asymmetric: `capture` requires a higher confidence than `ask` because misclassifying `ask` as `capture` is costlier (a silent note may get written) than the reverse.

Starting points to anchor the eval work, not committed values:

- `ask` threshold: 0.70.
- `capture` threshold: 0.85.
- `mixed` threshold: 0.75.
- `meta` threshold: 0.70.

Below threshold, the disambiguation chip appears. Committed values land after the first golden-set run during M1.

## Disambiguation UX

When confidence is below the active threshold, the composer header shows a non-blocking chip:

> Did you mean to save this, or ask about it? [Save] [Ask] [Cancel]

Clicking a button re-submits the message with the chosen intent hard-coded (same path as a command-based skip). Cancel discards the message. The chip contains the classifier's one-line rationale as a tooltip.

Behavior rules:

- The chip appears within 250 ms of the classifier result.
- If the user types another message while the chip is showing, the new message is queued and the chip still applies to the first message only.
- The chip is non-modal; users can scroll, open files, and change panes while it is visible.

## Transparency

When confidence is high, the classifier's decision is silent in v1 — no label or indicator on the message. Exceptions:

- **Dev mode** (Settings → Advanced) shows every classification inline on each message as a subtle label plus the rationale on hover.
- **Silent-save indicator**: when the classifier routes to `capture` and the user has "Always preview before save" disabled, a subtle "saving as note" indicator appears before the silent save completes. Silent writes should never surprise the user.

The turn inspector always shows the full classifier output including rationale, regardless of dev mode.

## Edge cases

- **Classifier times out (>500 ms wall clock)**: route to `ask` and show the disambiguation chip. `ask` is the safer default because it has no write side effects.
- **Classifier returns unparseable output**: treat as timeout — route to `ask`, show chip, log the malformed output.
- **Classifier returns a label outside the taxonomy**: log, treat as timeout, show chip.
- **Ollama unreachable during classification**: fall back to the main-loop Ollama-error handling (Notice with Start action). The turn is not submitted.
- **Empty or whitespace-only message**: error, show "type something" hint, no classifier call.
- **Attachment plus a single word**: treat as attachment-only, route to `capture` via the skip path.
- **Follow-up message referencing prior turn** ("more detail", "save that"): the classifier uses the last 3 chat turns in context to infer the referent.

## Retry budget

The classifier gets its own retry budget, separate from the main loop:

- 1 retry on invalid JSON output (under `format: "json"`, a second failure is treated as timeout).
- 0 retries on transport errors (fall back to timeout behavior).
- No retry on valid output with low confidence — that is the disambiguation path, not an error.

Classifier retries do not count against the main turn's 3-retry budget.

## Evaluation

A classifier golden set, distinct from the retrieval golden set.

- **Initial size**: 30 hand-labeled examples covering all four labels and the main edge cases (attachments, follow-ups, ambiguous phrasing, meta questions).
- **Growth**: to 100+ during beta. The disambiguation chip is a built-in labeled-example factory — every user correction becomes a labeled example.
- **Metrics**: per-class precision and recall, full confusion matrix, P50 and P95 latency.
- **Regression policy**: any drop in `ask → capture` precision is a P0 regression. Other regressions are P1.

## Prompt structure

The `intent-classifier` prompt lives in `prompts/intent-classifier.md`, versioned, stamped into events with a prompt version ID.

Structure:

- Short system section (~150 tokens) defining the four labels with one-sentence descriptions each.
- User section containing the structured input: current message text, attachment list, active file (name + title), last 3 turns.
- 4–6 few-shot examples inline — one per label plus 1–2 edge cases — each with the expected JSON output.
- Instruction to return JSON only, no prose.

Exact prompt wording is prompt-writing work; the structure above is the contract the eval suite assumes.

## Integration with the tool loop

- Every classification (LLM or skip) writes a `classifier_decision` row to `events.duckdb` with input, output, latency, source (`llm` or `skip`), and prompt version.
- The turn inspector shows the classifier decision at the top of every turn.
- A low-confidence decision that triggers a disambiguation chip logs a `classifier_disambiguation` event when the user clicks a button, including the user's chosen label. This is the primary data source for growing the golden set during beta.

## Deferred to post-v1

- Learning from user corrections as a per-vault prior.
- Sub-labels for capture and ask sub-routing.
- Rules-based fast path to reduce classifier latency on common cases.
- Speculative parallel retrieval (start retrieval while classifier runs; discard if classifier returns `capture`).
- A separate smaller classifier model.
