#!/usr/bin/env bash
# Create the "Tool-loop v1" milestone, supporting labels, and phased issues.
# Idempotent-ish: skips creating already-existing labels; will create duplicate
# issues if rerun, so guard before re-running.

set -euo pipefail

REPO="SimonProjekt/Gemmera"
MILESTONE_TITLE="Tool-loop v1"
MILESTONE_DESC="Orchestration state machines, prompt library, retries, hard stops, and constrained decoding for the Gemma tool loop. Excludes RAG-side tool definitions and per-path tool wiring (covered by RAG v1 #12, #13, #14)."

echo "==> Ensuring labels exist"
ensure_label() {
  local name="$1" color="$2" desc="$3"
  if ! gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name' | grep -Fxq "$name"; then
    gh label create "$name" --repo "$REPO" --color "$color" --description "$desc"
  else
    echo "    label exists: $name"
  fi
}

ensure_label "area:state-machine" "5319e7" "Tool-loop state machine framework, transitions, terminal states"
ensure_label "area:prompts"        "fbca04" "Prompt library, versioning, prompt-version stamping"
ensure_label "area:reliability"    "b60205" "Retries, constrained decoding, validation gates, hard stops"
ensure_label "area:classifier"     "0e8a16" "Intent classifier integration and disambiguation"
ensure_label "area:ux"             "c2e0c6" "User-facing UI surfaces tied to the tool loop"
ensure_label "area:observability"  "5def9b" "Event log, turn inspector, deterministic replay"

echo "==> Creating milestone (if missing)"
EXISTING_NUM=$(gh api "repos/${REPO}/milestones?state=all" --jq ".[] | select(.title==\"${MILESTONE_TITLE}\") | .number" | head -n1 || true)
if [[ -n "${EXISTING_NUM:-}" ]]; then
  echo "    milestone exists: #${EXISTING_NUM}"
  MILESTONE_NUM="$EXISTING_NUM"
else
  MILESTONE_NUM=$(gh api "repos/${REPO}/milestones" \
    -f title="$MILESTONE_TITLE" \
    -f state="open" \
    -f description="$MILESTONE_DESC" \
    --jq '.number')
  echo "    created milestone #${MILESTONE_NUM}"
fi

BODY_DIR="$(mktemp -d)"
trap 'rm -rf "$BODY_DIR"' EXIT

write_body() {
  local file="$1"
  shift
  cat > "$BODY_DIR/$file"
}

new_issue() {
  local title="$1" body_file="$2"
  shift 2
  local label_args=()
  for lbl in "$@"; do
    label_args+=(--label "$lbl")
  done
  gh issue create --repo "$REPO" \
    --title "$title" \
    --body-file "$BODY_DIR/$body_file" \
    --milestone "$MILESTONE_TITLE" \
    "${label_args[@]}"
}

############################################################
# PHASE 1 — Foundations
############################################################

write_body 01-state-machine-framework.md <<'EOF'
Build the generic state-machine framework that both the ingest and query loops sit on top of. This is infrastructure only — no tool wiring yet. Pinned in `planning/tool-loop.md` under "State machine requirements" (structural section).

### Acceptance
- A `StateMachine` abstraction with: named states, single-responsibility per state, explicit named transitions, no implicit fall-through.
- One active turn per chat enforced; second submission is queued (returns a queued handle the UI can render as a chip).
- Bounded events per turn — every state declares a max event count; exceeding it transitions to a terminal error state.
- Transitions are event-driven only: `user_action`, `tool_result`, `timer`, `model_output`. No "tick" loops.
- Each state defines an `enter` and `exit` hook with payload, used downstream for logging.
- Unit tests for: queueing a second turn, bounded-event enforcement, illegal transition rejection.

### Reference
- `planning/tool-loop.md` — "State machine requirements" → Structural & Behavioral.
EOF

write_body 02-terminal-states-unwind.md <<'EOF'
Make error and terminal states first-class, with a defined unwind order shared by every path. Required before the ingest/query state machines can be built safely.

### Acceptance
- Terminal states defined as named values: `DONE`, `CANCELLED`, `TIMED_OUT`, `MODEL_INVALID_OUTPUT`, `TOOL_FAILED`, `VALIDATION_FAILED`.
- A single `unwind(reason)` routine implements the documented order: stop model stream → drop pending tool results → roll back unconfirmed writes → write events → surface a `Notice` → close the turn.
- Partial state preserved on every terminal exit and accessible to the turn inspector (raw record passed forward, not lost).
- Idempotency rule encoded: side effects only fire in the `WRITE` state, after explicit user confirmation. Tests assert retried states do not duplicate effects.
- Tests cover: cancel mid-stream, timeout mid-tool-call, validation failure post-parse.

### Reference
- `planning/tool-loop.md` — "Error handling requirements", "Cancellation support", "Timeout support", "Idempotency".
EOF

write_body 03-event-log-replay.md <<'EOF'
Wire the state machine into `events.duckdb` so every transition is logged and turns can be deterministically replayed for evals. Builds on RAG v1 #3 (jobs + events tables).

### Acceptance
- Every `enter`/`exit` transition writes a row to `events` with `turn_id`, state name, timestamp, and JSON payload (tool args, tool results, prompts, model responses).
- Payload schema documented in code comments next to the writer.
- Deterministic replay helper: given a `turn_id` and the recorded tool results, the state machine traverses the same path (modulo model non-determinism). Replay is the foundation for the eval suite.
- Replay test on a captured fixture passes in CI.
- Sensitive-content redaction hook at the writer boundary (placeholder is acceptable; see `errors.md` future doc).

### Reference
- `planning/tool-loop.md` — "Observability requirements".
- `planning/rag.md` — `events` table DDL.
EOF

write_body 04-hard-stops.md <<'EOF'
Implement the per-turn ceilings that bound every state machine. Without these, the loop can spin or burn budget invisibly.

### Acceptance
- Enforced ceilings: max 10 tool calls per turn, max 120 s wall-clock (configurable up to 300 s), max 3 consecutive no-op model responses, max 3 retries across the whole turn, max 16 KB compacted retrieval payload.
- "No-op" defined: model response with no tool calls and no user-visible text.
- On any ceiling hit, the loop exits to the appropriate terminal state via the shared unwind, partial state preserved, Notice explains what stopped with a link to the turn inspector.
- Settings expose the wall-clock ceiling; other ceilings are constants in v1.
- Unit tests assert each ceiling triggers the expected terminal state.

### Reference
- `planning/tool-loop.md` — "Hard stops".
EOF

write_body 05-prompt-library-scaffold.md <<'EOF'
Set up the versioned prompt library and the stamp mechanism that ties prompt revisions to written notes and event log rows.

### Acceptance
- `prompts/` directory with one Markdown file per v1 prompt: `ingest-parser.md`, `note-writer.md`, `intent-classifier.md`, `dedup-decider.md`, `retrieval-reasoner.md`, `synthesis-writer.md`. Initial content is the structural spec; exact wording is a separate task.
- Each prompt file carries a `version` header (semver-ish, e.g. `0.1.0`) read at load time.
- Loader returns `{ id, version, body }` and caches by file path; reload on edit in dev mode.
- The active prompt version is stamped into:
  - `cowork.version` on any note written under that prompt (per `rag.md` frontmatter contract).
  - `events.duckdb` payload for `prompt`-kind rows.
- Test confirms a written note's `cowork.version` matches the loaded prompt version.

### Reference
- `planning/tool-loop.md` — "Prompt library".
- `planning/rag.md` — "Frontmatter contract" → `cowork.version`.
EOF

############################################################
# PHASE 2 — State machines
############################################################

write_body 06-ingest-state-machine.md <<'EOF'
Implement the ingest state machine: the orchestration skeleton that sits above the ingest tool wiring (RAG v1 #13). This issue owns the *states and transitions*, not the tool definitions.

### Acceptance
- States implemented in order: `IDLE` → `CLASSIFY_INTENT` → `PARSE_CONTENT` → `SEARCH_SIMILAR` → `DECIDE_STRATEGY` → `PREVIEW` → `WRITE` → `UPDATE_INDEX` → `DONE`.
- `DECIDE_STRATEGY` branches: `PROPOSE_NEW`, `ASK_USER_DEDUP`, `PROPOSE_NEW_WITH_LINKS`, `PROPOSE_APPEND`, `PROPOSE_SPLIT`. Each branch resolves into a `PREVIEW` payload variant.
- `PREVIEW` accepts user actions: edit (loop back to `PREVIEW` with edits applied), cancel (→ `CANCELLED`), confirm (→ `WRITE`).
- `PROPOSE_APPEND` payload shows what *will be added* under a dated heading (`## YYYY-MM-DD capture`), not a full-note diff.
- `PROPOSE_SPLIT` payload returns N candidates; preview confirms each independently or all-at-once.
- Integration test drives a synthetic ingestion through every branch using mocked tool results recorded via the replay helper from #3.

### Reference
- `planning/tool-loop.md` — "Ingest state machine".
- Cross-link: depends on RAG v1 #13 for tool wiring; this issue owns the SM only.
EOF

write_body 07-query-state-machine.md <<'EOF'
Implement the query state machine. Orchestration skeleton above the query tool wiring (RAG v1 #14); this issue owns *states, transitions, and the citation-validation gate*.

### Acceptance
- States: `IDLE` → `CLASSIFY_INTENT` → `PLAN_RETRIEVAL` → `RETRIEVE` → `RERANK` → `ASSEMBLE_CONTEXT` → `GENERATE` → `VALIDATE_CITATIONS` → `PRESENT` → `DONE`.
- `PLAN_RETRIEVAL` may call `search_notes`, `find_related_notes`, or both; simple queries skip planning and go to `RETRIEVE` with sensible defaults.
- `GENERATE` streams tokens and may call `get_note` mid-generation to read a chunk in full.
- `VALIDATE_CITATIONS` checks every cited path appears in the retrieval payload assembled in `ASSEMBLE_CONTEXT`. Invalid → `RETRY_WITH_CONSTRAINED_CITATIONS` (once) → `PRESENT` or `VALIDATION_FAILED`.
- `PRESENT` exposes optional "save as synthesis note" affordance.
- Tests: simple query happy path; query with citation retry; query with citation retry exhausted.

### Reference
- `planning/tool-loop.md` — "Query state machine".
- Depends on RAG v1 #14 for tool wiring.
EOF

write_body 08-destructive-op-mini-sm.md <<'EOF'
Implement the destructive-operation mini state machine that wraps `delete_note` and `rename_or_move_note` regardless of which path triggered them.

### Acceptance
- States: `TOOL_CALL` → `CONFIRM` → `EXECUTE` → `UPDATE_INDEX` → `DONE`. Cancel from `CONFIRM` → `CANCELLED` with tool result `"user declined"`.
- `delete_note` confirmation uses a *dedicated* modal: shows target file path, preview of contents, requires explicit Confirm. **Mandatory and non-overridable** — no setting bypasses it.
- `rename_or_move_note` uses the standard preview gate (from/to paths + affected-link count) and respects the "Always preview" setting because Obsidian maintains link integrity.
- `EXECUTE` calls `vault.trash(path)` for delete, `fileManager.renameFile(from, to)` for rename.
- `DONE` surfaces a Notice with Undo (`"Deleted X"` / `"Renamed X to Y"`).
- Test asserts the delete modal cannot be skipped under any setting permutation.

### Reference
- `planning/tool-loop.md` — "Destructive operation path".
EOF

write_body 09-mixed-intent-orchestration.md <<'EOF'
Handle the `mixed` classifier label by chaining the ingest and query state machines within a single user turn.

### Acceptance
- On `mixed`, ingest path runs first to completion; query path runs second with the newly-written note included in the retrieval set.
- A single `turn_id` spans both phases; events are tagged with a `phase` field (`ingest` | `query`).
- The UI shows both phases as distinct status cards within one turn.
- Cancellation during ingest aborts the whole turn; cancellation after ingest preserves the saved note and aborts only the query phase.
- Hard stops (#4) apply across the combined turn, not per phase.
- Test covers: clean mixed turn, mixed cancelled mid-ingest, mixed cancelled mid-query.

### Reference
- `planning/tool-loop.md` — "Mixed intent".
- `planning/classifier.md` — `mixed` taxonomy entry.
EOF

############################################################
# PHASE 3 — Reliability
############################################################

write_body 10-retry-policy.md <<'EOF'
Implement the layered retry policy. Sits on top of the state machine framework and the hard-stop budget.

### Acceptance
- **Model-output validity**: invalid JSON → 1 retry under `format: "json"` constrained decoding; on second failure → `MODEL_INVALID_OUTPUT`. Schema-valid-but-rule-violating JSON → 1 retry with explicit error feedback appended; second failure → `VALIDATION_FAILED`.
- **Tool-call correctness**: unknown tool name → 0 retries → `VALIDATION_FAILED`. Bad arguments → 1 retry with validation error returned to Gemma as a tool result. Tool execution exception → 0 automatic retries; error returned as tool result, Gemma decides.
- **Transient infra**: Ollama connection refused → 1 retry after 500 ms; on failure surface "Ollama not running" Notice with Start action. Embedding call fail → 1 retry after 250 ms; on failure return job to queue. Reranker fail → 0 retries; skip rerank, log event.
- Retries at `PARSE_CONTENT`, `DECIDE_STRATEGY`, `GENERATE` and at every tool-call state, all bounded by the per-turn 3-retry ceiling from #4.
- Tests cover each policy branch using fault-injected fakes.

### Reference
- `planning/tool-loop.md` — "Retry policy".
EOF

write_body 11-constrained-decoding-gates.md <<'EOF'
Wire JSON-schema-constrained decoding into every structured-output state. Per `rag.md`, this is the response of choice if Gemma's tool calls underperform; v1 ships with it on by default.

### Acceptance
- `PARSE_CONTENT`, `DECIDE_STRATEGY`, `VALIDATE_CITATIONS`, and the classifier all submit with Ollama `format: "json"` (or grammar) plus the relevant JSON schema.
- A schema registry maps state → schema. Schemas live alongside the prompt files for that state.
- Output that parses but violates schema feeds the validation-retry path (#10).
- A small benchmark utility exercises each constrained call against fixtures and reports schema-failure rate (a stand-in metric for the eval suite).
- Documented escape hatch: a single setting toggles constrained decoding off for debugging, but never in user-facing builds.

### Reference
- `planning/tool-loop.md` — "Retry policy" → Model-output validity.
- `planning/rag.md` — "If Gemma's tool calls underperform".
EOF

write_body 12-classifier-integration.md <<'EOF'
Integrate the intent classifier into the front of the tool loop, with skip conditions, disambiguation chip, and the asymmetric thresholds. The classifier prompt itself is owned by #5; this issue owns the routing surface.

### Acceptance
- Every user message hits the classifier *unless* a skip condition fires: empty (error), attachment-only (`capture`), command-invoked, `Ctrl/Cmd+Enter` (`capture`), leading `?` (`ask`).
- Every skip writes a `classifier_decision` event with `source: "skip"` and the reason.
- Output JSON validated under `format: "json"` (uses #11). Schema-bad output → 1 retry → fall back to `ask` and show disambiguation chip.
- Asymmetric thresholds in config (anchors: `ask` 0.70, `capture` 0.85, `mixed` 0.75, `meta` 0.70). Below threshold → disambiguation chip with `[Save] [Ask] [Cancel]`.
- Edge cases: classifier timeout (>500 ms) → `ask` + chip; unparseable → `ask` + chip; out-of-taxonomy label → `ask` + chip; Ollama unreachable → main-loop Ollama-error handling.
- Disambiguation result writes a `classifier_disambiguation` event for golden-set growth.
- Classifier retries do not count against the main-turn 3-retry budget (#4).

### Reference
- `planning/classifier.md` — full spec.
- `planning/tool-loop.md` — "Intent classifier".
EOF

############################################################
# PHASE 4 — Ops + UX surfaces
############################################################

write_body 13-cancellation-timeout.md <<'EOF'
Implement first-class cancellation and timeout that drive the shared unwind from #2.

### Acceptance
- User can abort at any state via a UI affordance; abort triggers `unwind("cancelled")` and the loop exits to `CANCELLED`.
- Per-turn wall-clock timer (default 120 s, configurable up to 300 s, sourced from the hard-stops constants in #4) fires `unwind("timed_out")` on expiry.
- Unwind order matches #2: stop model stream → drop pending tool results → roll back unconfirmed writes → write events → Notice → close turn.
- Confirmed writes from prior states are preserved across cancel/timeout.
- Tests cover: cancel during `GENERATE`, cancel during a long tool call, timeout during `RERANK`, timeout during `GENERATE`.

### Reference
- `planning/tool-loop.md` — "Cancellation support", "Timeout support".
EOF

write_body 14-preview-gate.md <<'EOF'
Implement the preview gate that guards every write tool. UI surfaces (modal layout, inline preview) are sketched here at the integration level; full UI polish lives in a future ui-surfaces issue.

### Acceptance
- `save_note`, `update_frontmatter` (non-additive), `rename_or_move_note`, `propose_note → save`, `create_synthesis_note` all route through the preview gate by default.
- `delete_note` *always* requires the dedicated confirmation modal from #8 — preview gate setting cannot bypass it.
- Setting "Always preview before save" defaults on; when off, write tools (excluding delete) skip the gate, but a "saving as note" indicator appears for any silent write triggered by the classifier.
- `ASK_USER_DEDUP` preview surfaces three choices: "append to existing," "save as a new note anyway," "cancel." This is the highest-leverage anti-duplication branch.
- Edits in the preview loop back to `PREVIEW` with the edited payload — no double-write.
- Test asserts the delete modal still fires with `Always preview = false`.

### Reference
- `planning/tool-loop.md` — "Write tools", "ASK_USER_DEDUP", "Destructive operation path".
EOF

write_body 15-turn-inspector-ui-status.md <<'EOF'
Surface the loop's internal state to the user in two ways: a small UI status indicator that follows the active state, and a turn inspector (dev mode) that shows the full event timeline.

### Acceptance
- Each state maps to a visible UI status string. Required mappings: `RETRIEVE` → "Searching notes…", `GENERATE` → streaming answer, `PREVIEW` → modal/inline preview, `WRITE` → "Saving…", `CLASSIFY_INTENT` → "Thinking…", `RERANK` → "Reranking…", `UPDATE_INDEX` → "Indexing…".
- Mixed-intent turns (#9) show distinct status cards per phase.
- Turn inspector (dev mode setting) lists every transition for a turn: state name, timestamp, payload preview, retry count. Pulls from the events log written in #3.
- Inspector always shows the classifier output at the top of the turn, including rationale (per `classifier.md` integration rules).
- Every Notice issued by a terminal state links to the inspector for that turn.

### Reference
- `planning/tool-loop.md` — "UI reflection", "Partial state preserved on exit".
- `planning/classifier.md` — "Integration with the tool loop".
EOF

############################################################
# Create issues in order
############################################################

echo "==> Creating issues"
new_issue "Tool-loop: state machine framework (named states, transitions, queueing)" 01-state-machine-framework.md   "area:state-machine" "phase:1"
new_issue "Tool-loop: terminal states + shared unwind order"                          02-terminal-states-unwind.md      "area:state-machine" "area:reliability" "phase:1"
new_issue "Tool-loop: event log writer + deterministic replay"                        03-event-log-replay.md            "area:observability" "area:state-machine" "phase:1"
new_issue "Tool-loop: per-turn hard stops (tool calls, wall-clock, no-ops, retries)"  04-hard-stops.md                  "area:reliability"   "phase:1"
new_issue "Tool-loop: prompt library scaffold + version stamping"                     05-prompt-library-scaffold.md     "area:prompts"       "phase:1"

new_issue "Tool-loop: ingest state machine (CLASSIFY → PARSE → SEARCH → DECIDE → PREVIEW → WRITE → INDEX)" 06-ingest-state-machine.md "area:state-machine" "area:tools" "phase:2"
new_issue "Tool-loop: query state machine (PLAN → RETRIEVE → RERANK → ASSEMBLE → GENERATE → VALIDATE → PRESENT)" 07-query-state-machine.md "area:state-machine" "area:tools" "phase:2"
new_issue "Tool-loop: destructive-op mini state machine (delete + rename/move)"       08-destructive-op-mini-sm.md      "area:state-machine" "area:ux"   "phase:2"
new_issue "Tool-loop: mixed-intent orchestration (ingest then query in one turn)"     09-mixed-intent-orchestration.md  "area:state-machine" "area:classifier" "phase:2"

new_issue "Tool-loop: layered retry policy (model output, tool calls, transient infra)" 10-retry-policy.md              "area:reliability"   "phase:3"
new_issue "Tool-loop: JSON-schema constrained decoding at every structured-output state" 11-constrained-decoding-gates.md "area:reliability" "area:prompts" "phase:3"
new_issue "Tool-loop: intent classifier integration (skips, thresholds, disambiguation chip)" 12-classifier-integration.md "area:classifier" "area:reliability" "phase:3"

new_issue "Tool-loop: cancellation + per-turn timeout with shared unwind"             13-cancellation-timeout.md        "area:reliability"   "area:ux"   "phase:4"
new_issue "Tool-loop: preview gate for all write tools (with non-overridable delete)" 14-preview-gate.md                "area:ux"            "area:tools" "phase:4"
new_issue "Tool-loop: UI status reflection + turn inspector (dev mode)"               15-turn-inspector-ui-status.md    "area:observability" "area:ux"   "phase:4"

echo "==> Done"
gh issue list --repo "$REPO" --milestone "$MILESTONE_TITLE" --limit 30
