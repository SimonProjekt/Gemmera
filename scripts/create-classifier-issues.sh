#!/usr/bin/env bash
# Creates the "Classifier v1" milestone, supporting labels, and issues
# implementing the architecture described in planning/classifier.md.
#
# Idempotency: re-running will create duplicate issues. Run once.
# Labels and milestone creation tolerate "already exists" errors.
#
# NOTE: the original heredoc-inside-$(...) form broke partway on a parenthesis
# in one of the bodies. The remaining 9 issues were created with a recovery
# snippet writing each body to /tmp/cls-NN.md first and then calling
# `gh issue create --body-file`. Prefer that pattern if extending this script.

set -euo pipefail

REPO="${REPO:-SimonProjekt/Gemmera}"
MS_TITLE="Classifier v1"
MS_DESC="Pure-LLM intent classifier (capture / ask / mixed / meta) with skip conditions, asymmetric confidence thresholds, disambiguation UX, and golden-set eval. See planning/classifier.md."

WORKDIR="$(mktemp -d -t classifier-issues.XXXXXX)"
echo "==> Repo: $REPO"
echo "==> Body files: $WORKDIR"

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
# 2. Labels (reuse area:* + phase:* from RAG, add classifier-specific ones)
# ---------------------------------------------------------------------------
create_label() {
  local name="$1" color="$2" desc="$3"
  if gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" >/dev/null 2>&1; then
    echo "    + label $name"
  fi
}

echo "==> Ensuring labels"
create_label "area:classifier" "17becf" "Intent classifier: prompt, routing, thresholds"
create_label "area:ui"         "bcbd22" "Composer chips, indicators, dev-mode surfaces"
create_label "area:prompts"    "c5b0d5" "Versioned prompt files and few-shot examples"
# (phase:1..4, area:eval, area:tools, area:ops already exist from RAG run.)

# ---------------------------------------------------------------------------
# 3. Issues
# ---------------------------------------------------------------------------
create_issue() {
  local title="$1" labels="$2" body_file="$3"
  local url
  url=$(gh issue create --repo "$REPO" \
    --title "$title" \
    --milestone "$MS_TITLE" \
    --label "$labels" \
    --body-file "$body_file")
  echo "    + $url"
}

write_body() {
  local name="$1"
  local path="$WORKDIR/$name.md"
  cat > "$path"
  echo "$path"
}

echo "==> Creating issues"

# ===========================================================================
# Phase 1 — Foundations: contracts, prompt, event schema
# ===========================================================================

BODY=$(write_body "01-types" <<'EOF'
Define the TypeScript types for classifier input and output, matching the contract in `planning/classifier.md`.

Input shape:
- `messageText: string` (truncated to 8 KB with marker; truncation flag returned)
- `attachments: { kind: "pdf"|"image"|"audio"|"text"; filename: string }[]`
- `activeFile: { filename: string; title: string } | null`
- `recentTurns: { text: string; intent: IntentLabel }[]` (last 3)

Output shape:
- `{ label: IntentLabel; confidence: number; rationale: string }`
- `IntentLabel = "capture" | "ask" | "mixed" | "meta"`

### Acceptance
- Types exported from a single module consumed by both the classifier call site and the eval harness.
- An 8 KB+ message is truncated with a visible marker and a `truncated: true` flag.
- Unit tests cover truncation boundary and the recent-turns slice (always last 3, fewer if not available).

### Reference
planning/classifier.md — "Input contract" and "Output contract".
EOF
)
create_issue \
  "Classifier: input/output contract types + truncation helper" \
  "area:classifier,phase:1,enhancement" \
  "$BODY"

BODY=$(write_body "02-prompt" <<'EOF'
Add `prompts/intent-classifier.md` per the structure pinned in planning. Stamp it with a prompt version ID that gets emitted in every classifier event.

Structure:
- ~150-token system section defining `capture`, `ask`, `mixed`, `meta` (one sentence each).
- User section template with placeholders for current message, attachments, active file, last 3 turns.
- 4–6 inline few-shot examples — one per label plus 1–2 edge cases (attachment-only, follow-up "save that"). Each shows the expected JSON output.
- Instruction to return JSON only, no prose.

### Acceptance
- File exists, is loaded by the runtime, and its version ID is exported as a constant.
- The version ID appears in `classifier_decision` event rows.
- A snapshot test pins the rendered prompt against a fixed input.

### Reference
planning/classifier.md — "Prompt structure".
EOF
)
create_issue \
  "Classifier: versioned intent-classifier prompt" \
  "area:classifier,area:prompts,phase:1,enhancement" \
  "$BODY"

BODY=$(write_body "03-events" <<'EOF'
Add `classifier_decision` and `classifier_disambiguation` row schemas to `events.duckdb` and a small writer helper.

`classifier_decision` columns:
- `turn_id`, `ts`, `source` (`llm` | `skip`), `skip_reason` (nullable), `prompt_version`, `input_json`, `output_json`, `latency_ms`, `confidence`, `label`.

`classifier_disambiguation` columns:
- `turn_id`, `ts`, `original_label`, `original_confidence`, `chosen_label`, `cancelled` (bool).

### Acceptance
- Migration adds both tables; existing event log rolls forward cleanly.
- Writer helpers are awaited synchronously per event so order is preserved.
- Skip-path classifications still emit a `classifier_decision` row with `source = "skip"`.

### Reference
planning/classifier.md — "Integration with the tool loop".
EOF
)
create_issue \
  "Classifier: event log schema for decisions and disambiguations" \
  "area:classifier,area:storage,phase:1,enhancement" \
  "$BODY"

# ===========================================================================
# Phase 2 — Core classifier: skip router, LLM call, retries, error handling
# ===========================================================================

BODY=$(write_body "04-skip-router" <<'EOF'
Implement the pre-classifier skip router. Every user submission goes through this first; only non-skipped messages call the LLM classifier.

Skip rules (in order):
- Empty / whitespace-only → error, "type something" hint, no classifier event.
- Attachments present but no text → pre-route `capture`.
- Submitted via `cowork.capture-selection`, `cowork.capture-active-note`, `cowork.ask-about-active-note` → label hard-coded.
- `Ctrl/Cmd+Enter` submit → `capture`.
- Message starts with `?` → `ask` (the `?` is stripped before downstream use).

### Acceptance
- Each non-error skip emits a `classifier_decision` row with `source = "skip"` and a `skip_reason`.
- Empty-message error path does NOT emit an event.
- Unit tests cover every rule plus precedence (e.g. attachment + `?` resolves per documented order).

### Reference
planning/classifier.md — "Skip conditions".
EOF
)
create_issue \
  "Classifier: skip-condition pre-router" \
  "area:classifier,area:tools,phase:2,enhancement" \
  "$BODY"

BODY=$(write_body "05-llm-call" <<'EOF'
Implement the actual LLM classifier call against Ollama-hosted Gemma 4 E4B with `format: "json"` constrained decoding.

Behavior:
- Render the `intent-classifier` prompt with the validated input.
- Issue a single Ollama call with a 500 ms wall-clock budget (200 ms target, 500 ms hard timeout).
- Parse the JSON response; validate `label` is in the taxonomy and `confidence` is in `[0, 1]`.
- Return a `ClassifierDecision` to the caller and emit a `classifier_decision` event with `source = "llm"`, `latency_ms`, `confidence`, and `label`.

### Acceptance
- Happy path: well-formed response is parsed and returned in <500 ms on a warm model.
- Latency is measured from request-send to parse-complete.
- Prompt version ID is included in every event.

### Reference
planning/classifier.md — "Model", "When the classifier runs", "Output contract".
EOF
)
create_issue \
  "Classifier: Ollama call with format=json constrained decoding" \
  "area:classifier,area:tools,phase:2,enhancement" \
  "$BODY"

BODY=$(write_body "06-retries" <<'EOF'
Apply the classifier-specific retry budget per planning. Classifier retries do NOT count against the main turn's 3-retry budget.

Rules:
- Invalid JSON output: 1 retry. Second failure → treat as timeout (route `ask`, show chip, log malformed output).
- Transport errors (Ollama unreachable, network): 0 retries → main-loop Ollama-error handling (Notice with Start action). Turn is not submitted.
- Out-of-taxonomy label: log, treat as timeout, show chip.
- Wall-clock >500 ms: route `ask`, show chip.
- Low confidence on a valid output: NOT a retry — that is the disambiguation path.

### Acceptance
- Tests cover each branch above.
- The malformed-output payload is captured verbatim in the event row for debugging.
- The main-loop retry counter is verifiably untouched by classifier retries.

### Reference
planning/classifier.md — "Edge cases", "Retry budget".
EOF
)
create_issue \
  "Classifier: retry budget and timeout/error fallbacks" \
  "area:classifier,area:tools,phase:2,enhancement" \
  "$BODY"

BODY=$(write_body "07-thresholds" <<'EOF'
Implement asymmetric confidence thresholds. Below threshold → caller is told to show the disambiguation chip; the routed label is still returned for telemetry.

Initial (anchor) values, configurable via settings under an "Advanced" section:
- `ask`: 0.70
- `capture`: 0.85
- `mixed`: 0.75
- `meta`: 0.70

Final committed values land after the first golden-set run during M1 (#eval issue covers tuning).

### Acceptance
- Threshold check is a pure function over `(label, confidence)` and is unit-tested at boundaries.
- A single config object holds all four thresholds and is readable by both the classifier and the eval runner.
- Disambiguation flag is surfaced on the returned `ClassifierDecision`.

### Reference
planning/classifier.md — "Confidence thresholds".
EOF
)
create_issue \
  "Classifier: asymmetric confidence threshold gating" \
  "area:classifier,phase:2,enhancement" \
  "$BODY"

# ===========================================================================
# Phase 3 — Integration: routing into state machines + UX surfaces
# ===========================================================================

BODY=$(write_body "08-route" <<'EOF'
Wire the classifier output into the tool loop. The mapping is fixed by the taxonomy table.

- `capture` → ingest state machine.
- `ask` → query state machine.
- `mixed` → ingest first, then query with the new note included in the retrieval payload.
- `meta` → deterministic help lookup. No main-loop call.

### Acceptance
- A turn whose classifier returns `mixed` runs ingest then query in sequence with the new note id available to retrieval.
- A `meta` decision short-circuits the orchestrator and renders the static help response.
- The classifier decision is attached to the turn record so the turn inspector can read it.

### Reference
planning/classifier.md — "Intent taxonomy", "Integration with the tool loop".
EOF
)
create_issue \
  "Classifier: route decisions into ingest/query/meta paths" \
  "area:classifier,area:tools,phase:3,enhancement" \
  "$BODY"

BODY=$(write_body "09-chip" <<'EOF'
Implement the disambiguation chip in the composer header. Triggered when the classifier decision is below threshold OR on timeout/parse fallback.

Behavior:
- Renders within 250 ms of the classifier returning (or timing out).
- Buttons: `Save`, `Ask`, `Cancel`. Tooltip on the chip shows the one-line rationale.
- `Save`/`Ask` re-submit the original message with the chosen intent hard-coded (same path as a command skip).
- `Cancel` discards the message.
- Non-modal: user can scroll, open files, change panes while it is visible.
- If the user types a new message while the chip is showing, that message is queued; the chip still applies to the first message only.

Emit a `classifier_disambiguation` event on any of the three button actions.

### Acceptance
- Visual + interaction tests cover all three buttons plus the queued-message case.
- 250 ms budget is met on a warm load (asserted in a perf test).
- Non-modal behavior verified by automated UI test.

### Reference
planning/classifier.md — "Disambiguation UX".
EOF
)
create_issue \
  "Classifier UI: disambiguation chip in composer header" \
  "area:classifier,area:ui,phase:3,enhancement" \
  "$BODY"

BODY=$(write_body "10-transparency" <<'EOF'
Implement the v1 transparency rules.

- High-confidence decisions are silent on the message (no inline label).
- Dev mode (Settings → Advanced → "Show classifier decisions") shows a subtle inline label on every message with the rationale on hover.
- Silent-save indicator: when the classifier routes to `capture` AND "Always preview before save" is OFF, show a subtle "saving as note" indicator before the silent save completes.
- The turn inspector ALWAYS shows the full classifier output regardless of dev mode (covered by a separate ticket).

### Acceptance
- Dev mode toggle is wired and persists across reloads.
- Silent-save indicator appears for the right preference combination and not otherwise.
- Snapshot tests for both the silent and dev-mode message renderings.

### Reference
planning/classifier.md — "Transparency".
EOF
)
create_issue \
  "Classifier UI: dev-mode inline labels + silent-save indicator" \
  "area:classifier,area:ui,phase:3,enhancement" \
  "$BODY"

BODY=$(write_body "11-inspector" <<'EOF'
Add a classifier panel at the top of every turn inspector entry. Always visible regardless of dev mode.

Shows:
- Source (`llm` or `skip` + reason).
- Final label and confidence.
- Rationale (full text).
- Latency (ms).
- Prompt version.
- Whether disambiguation was triggered, and if so the user's chosen label.

### Acceptance
- Skip-path turns render with `source = skip` and the skip reason; no confidence/rationale fields.
- LLM-path turns render all fields including raw input and output JSON (collapsible).
- Disambiguation outcomes are joined from `classifier_disambiguation` and shown.

### Reference
planning/classifier.md — "Integration with the tool loop", "Transparency".
EOF
)
create_issue \
  "Classifier UI: turn-inspector panel for every decision" \
  "area:classifier,area:ui,area:ops,phase:3,enhancement" \
  "$BODY"

# ===========================================================================
# Phase 4 — Evaluation: golden set, runner, regression policy
# ===========================================================================

BODY=$(write_body "12-golden" <<'EOF'
Build the initial classifier golden set: 30 hand-labeled examples covering all four labels and the documented edge cases.

Coverage requirements:
- Each of `capture`, `ask`, `mixed`, `meta` appears.
- Edge cases: attachment-only, follow-up referencing prior turn ("more detail", "save that"), ambiguous phrasing, meta question, message with active-file context, message with last-3-turn context.
- Stored as a JSON or YAML fixture committed to the repo.

Distinct from the retrieval golden set.

### Acceptance
- Fixture lives under `eval/classifier-golden/` (or analogous), checked in.
- Each example carries: input contract fields, expected label, optional notes.
- A loader exposes the set to the runner ticket.

### Reference
planning/classifier.md — "Evaluation".
EOF
)
create_issue \
  "Classifier eval: initial 30-example golden set" \
  "area:classifier,area:eval,phase:4,enhancement" \
  "$BODY"

BODY=$(write_body "13-runner" <<'EOF'
Implement the classifier eval runner. Reads the golden set, runs each example through the live classifier (skip router + LLM), and emits metrics.

Outputs:
- Per-class precision and recall.
- Full 4x4 confusion matrix.
- P50 and P95 classifier latency.
- Per-example diff (expected vs actual) for failures.

Runnable from a single CLI entry point; results written to `eval/runs/<timestamp>/`.

### Acceptance
- A single command produces a complete report on a fresh checkout (assuming Ollama is up).
- The runner re-uses the production classifier code path; no parallel implementation.
- Report is human-readable (markdown) and machine-readable (JSON) side by side.

### Reference
planning/classifier.md — "Evaluation".
EOF
)
create_issue \
  "Classifier eval: runner with confusion matrix + latency metrics" \
  "area:classifier,area:eval,phase:4,enhancement" \
  "$BODY"

BODY=$(write_body "14-tune" <<'EOF'
Run the eval harness against the initial golden set, choose committed threshold values, and update the defaults shipped in #thresholds.

Constraints:
- Maintain `capture` > `ask` asymmetry — `ask → capture` precision is the protected metric.
- Document the chosen values and the tradeoffs in a short note inside `planning/classifier.md` (under "Confidence thresholds") OR in a follow-up doc — pick whichever the repo prefers.
- Establish the regression policy in CI: any drop in `ask → capture` precision is a P0 regression; other regressions are P1.

### Acceptance
- Committed thresholds replace the anchor values in code.
- Eval run on the golden set produces non-degraded precision/recall vs the anchor run.
- CI runs the classifier eval on every PR touching `area:classifier` and fails on a P0 regression.

### Reference
planning/classifier.md — "Confidence thresholds", "Evaluation".
EOF
)
create_issue \
  "Classifier eval: tune committed thresholds + regression policy" \
  "area:classifier,area:eval,area:ops,phase:4,enhancement" \
  "$BODY"

echo "==> Done."
