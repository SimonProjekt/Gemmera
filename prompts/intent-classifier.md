version: 0.1.0

# intent-classifier

Classifies a user message into one of {capture, ask, mixed, meta}.

## Input
- The user's message.

## Output
JSON with `label`, `confidence` (0–1), and a one-line `rationale`. Used
by the tool loop to route messages to the ingest or query state machine.
Asymmetric thresholds: capture requires higher confidence than ask.

## Status
Scaffold. Exact wording, examples, and threshold tuning are separate
tasks. See `planning/classifier.md`.
