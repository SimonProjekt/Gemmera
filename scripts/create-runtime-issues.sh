#!/usr/bin/env bash
# Creates the "Runtime v1" milestone, supporting labels, and issues
# implementing the runtime layer described in planning/runtime.md.
#
# Idempotency: re-running will create duplicate issues. Run once.
# Labels and milestone creation tolerate "already exists" errors.

set -euo pipefail

REPO="${REPO:-SimonProjekt/Gemmera}"
MS_TITLE="Runtime v1"
MS_DESC="Plugin-managed Ollama lifecycle (detect/install/spawn/health/unload), required-model pulls, and gitignore-style .coworkignore for indexing scope. See planning/runtime.md."

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
create_label "area:runtime"   "17becf" "Ollama lifecycle, child process, health checks"
create_label "area:packaging" "bcbd22" "Cross-platform install, model pulls, distribution"
create_label "area:scope"     "7f7f7f" ".coworkignore parsing, evaluation, edit surface"
create_label "area:ops"       "8c564b" "Cold-start UX, controls, reconciliation"
create_label "area:ingestion" "2ca02c" "Vault events, hashing, chunking, embedding"
create_label "area:retrieval" "ff7f0e" "Hybrid search, reranking, payload assembly"
create_label "phase:1"        "ededed" "Phase 1 — Storage foundation"
create_label "phase:2"        "ededed" "Phase 2 — Ingestion pipeline"
create_label "phase:3"        "ededed" "Phase 3 — Retrieval + tools"
create_label "phase:4"        "ededed" "Phase 4 — Operability + eval"

# ---------------------------------------------------------------------------
# 3. Issue bodies (written to /tmp; gh issue create reads via --body-file)
# ---------------------------------------------------------------------------
TMPDIR_R="${TMPDIR:-/tmp}"
B="$TMPDIR_R/runtime-issue"

# --- P1.1 detect ---
cat > "$B-detect.md" <<'EOF'
On plugin load, detect Ollama in this order: (1) ping `http://127.0.0.1:11434/api/tags` with a short timeout; (2) probe the binary on PATH; (3) probe known platform install paths (Homebrew prefix on macOS, `%LOCALAPPDATA%\Programs\Ollama` on Windows, `/usr/local/bin` on Linux); (4) honor a user-configured manual path from settings.

Result becomes a single `OllamaState` value: `running_attached`, `installed_not_running`, `not_installed`, or `manual_path_invalid`.

### Acceptance
- Returns `running_attached` within 500ms when an Ollama server is already up.
- Returns `installed_not_running` when the binary exists but `/api/tags` fails.
- Returns `not_installed` only after both PATH and platform paths are checked.
- Manual-path setting overrides discovery and surfaces `manual_path_invalid` if the file is missing or not executable.
- All probes log to the plugin log with timing; no UI blocking on slow probes.

### Reference
planning/runtime.md → "Ollama lifecycle" → Lifecycle bullet 1.
EOF

# --- P1.2 first-run modal ---
cat > "$B-firstrun.md" <<'EOF'
Build the first-run install modal that appears when `OllamaState == not_installed`. Three branches, platform-aware:

1. **One-click install**: Homebrew on macOS (`brew install ollama`), winget on Windows (`winget install Ollama.Ollama`), or the upstream `curl | sh` script on Linux. Stream installer output into the modal.
2. **Open download page**: launch `https://ollama.com/download` in the user's browser.
3. **Manual path entry**: file picker + validation that writes the path into settings.

The modal is one continuous progress experience that flows directly into the model-pull step (separate issue) once Ollama is up.

### Acceptance
- Detected platform selects the right one-click installer; unsupported platforms hide branch 1.
- Cancellation at any step leaves no partial state and shows a clear "you can install later from Settings" notice.
- Successful install transitions to "spawn server" then "pull models" without requiring the user to reopen anything.

### Reference
planning/runtime.md → "Ollama lifecycle" → Lifecycle bullet 1 (sub-bullets a/b/c).
EOF

# --- P1.3 spawn ---
cat > "$B-spawn.md" <<'EOF'
When detection returns `installed_not_running`, spawn `ollama serve` (or platform equivalent) as a child process. Capture stdout and stderr line-by-line into the plugin log with `[ollama]` prefix. Track the PID so unload can stop it cleanly.

The child must inherit a sane environment (e.g., `OLLAMA_HOST=127.0.0.1:11434` to bind locally) and be detached from the Obsidian terminal where applicable.

### Acceptance
- Server reaches a healthy `/api/tags` response within 10s, or the spawn is reported failed with the captured stderr surfaced in a Notice.
- Plugin log shows interleaved Ollama output during startup.
- A flag `spawnedByPlugin = true` is set so unload knows it owns this process.
- Re-detection during the same session attaches to the spawned PID, never double-spawns.

### Reference
planning/runtime.md → "Ollama lifecycle" → Lifecycle bullet 1b and bullet 4.
EOF

# --- P1.4 unload ---
cat > "$B-unload.md" <<'EOF'
On `Plugin.onunload`, stop Ollama only if the plugin spawned it. If it was already running at load time (`spawnedByPlugin = false`), leave it alone.

Stopping is graceful: send SIGTERM (or platform equivalent) and wait up to 5s for clean exit, then SIGKILL. Always release the PID handle.

### Acceptance
- Disabling the plugin while it spawned Ollama leaves no `ollama` process behind.
- Disabling the plugin when Ollama was pre-existing leaves it running and reachable.
- Obsidian quit triggers the same path; no orphaned processes.

### Reference
planning/runtime.md → "Ollama lifecycle" → Lifecycle bullet 4.
EOF

# --- P2.1 model pull ---
cat > "$B-models.md" <<'EOF'
After Ollama is reachable, verify that the three required v1 models are present via `/api/tags`: Gemma 4 E4B (~3 GB), BGE-M3 (~2 GB), bge-reranker-v2-m3 (~0.6 GB). Pull any missing ones via `/api/pull` with a single combined progress modal that streams percent + bytes per model.

These three are the only models v1 supports — no "lite" or "power" variants, no user-selectable swap.

### Acceptance
- All three present: status bar flips to ready immediately, no modal.
- One or more missing: modal opens, downloads serially with progress, and dismisses on success.
- Pull failure (network, disk full): modal shows the error and offers retry; does not block plugin load forever.
- Re-running the check is cheap (single `/api/tags` call) and incurs no re-download.

### Reference
planning/runtime.md → "Ollama lifecycle" → Lifecycle bullet 2 ("Model pull").
EOF

# --- P2.2 health checks ---
cat > "$B-health.md" <<'EOF'
Background health-check loop: `GET /api/tags` every 30 seconds while the plugin is loaded. After three consecutive failures, transition the status bar to `Ollama not responding — click to restart` and attempt one restart on the next user action (chat send, command palette invocation).

The loop must not run during model pulls (those have their own progress) and must back off cleanly if the plugin is unloading.

### Acceptance
- Three consecutive failures flip the status bar; a single failure does not.
- Clicking the status bar (or the next chat send) triggers exactly one restart attempt.
- A successful health check after a restart clears the warning state.
- Loop stops within 1s of `onunload`.

### Reference
planning/runtime.md → "Ollama lifecycle" → Lifecycle bullet 3 ("Health checks").
EOF

# --- P2.3 settings + status bar ---
cat > "$B-settings.md" <<'EOF'
Add the runtime UI surfaces:

- **Status bar segment** showing model readiness (`Cowork: ready` / `Cowork: pulling models 42%` / `Cowork: Ollama not responding`).
- **Settings entry** "Ollama path: auto / manual" with a path field that appears only when "manual" is selected.
- **Advanced settings** "Restart Ollama" button that runs the same restart path as the health-check fallback.

These are the only Ollama-related controls in v1. Resource caps, port negotiation, and version pinning are explicitly deferred.

### Acceptance
- Status bar updates within 1s of any state transition (detection, pull progress, health failure, restart).
- Switching "auto → manual" persists and re-runs detection.
- "Restart Ollama" is disabled while a pull or restart is already in flight.

### Reference
planning/runtime.md → "Ollama lifecycle" → "What the user sees".
EOF

# --- P3.1 .coworkignore parser ---
cat > "$B-ignore-parser.md" <<'EOF'
Parse `vault/.coworkignore` as gitignore-style globs. Supported syntax: `folder/`, `*.glob`, `**` deep wildcard, leading `!` negation, `# comment` lines, blank lines.

Evaluation is **last-match-wins**, consistent with gitignore. Hard-coded exclusions (`.obsidian/`, `.git/`, `.trash/`, `.coworkmd/`) are always applied first and cannot be un-excluded by `!` rules.

Expose a single `isIgnored(vaultRelativePath: string): boolean`.

### Acceptance
- `Templates/` excludes the folder and everything under it.
- `*.canvas` excludes canvas files at any depth.
- `Templates/**` plus `!Templates/KeepMe.md` keeps the negated file.
- `# comment` lines and blank lines are ignored.
- Hard-coded paths return true even if the user writes `!.obsidian/`.
- Default contents (Templates/, Attachments/, attachments/, assets/, *.canvas, *.excalidraw) ship at first install.

### Reference
planning/runtime.md → ".coworkignore" → "Format" and "Default contents on first install".
EOF

# --- P3.2 indexer integration ---
cat > "$B-ignore-indexer.md" <<'EOF'
Wire `isIgnored()` into the indexer and file-watcher pipeline so matched files are skipped end-to-end:

- **Indexing**: matched files never get chunked, embedded, or inserted into `notes`/`chunks`.
- **Retrieval**: because they never enter the index, they never appear in results (no extra filter needed).
- **File watcher**: `vault.on('create' | 'modify' | 'delete' | 'rename')` events for matched paths are dropped before reaching the `jobs` table.

Hard-coded exclusions are checked here too as a defense-in-depth.

### Acceptance
- Adding a path to `.coworkignore` then editing a matching file triggers no jobs.
- Cold-start scan respects the ignore file from the first walk.
- Renaming an ignored file into a non-ignored path triggers a normal create-equivalent index job.
- Renaming a non-ignored indexed file into an ignored path removes its rows.

### Reference
planning/runtime.md → ".coworkignore" → "What it affects" and "What it does not affect".
EOF

# --- P3.3 settings editor + live re-eval ---
cat > "$B-ignore-editor.md" <<'EOF'
In the Settings tab add a `.coworkignore` editor:

- Plain `<textarea>` with monospace font and inline syntax hints.
- Live "this many files will be affected" counter that updates as the user types (debounced).
- Save writes `vault/.coworkignore` so it travels with the vault.
- On save, the indexer re-evaluates every note within 1 second and adds/removes rows as needed. Large removals (>50 notes) show a progress Notice.

### Acceptance
- Editing and saving updates the file on disk and triggers re-evaluation within 1s.
- Counter reflects the rule set being typed, not just the saved version.
- Removing a rule that previously excluded 200 notes shows a progress Notice and queues embedding jobs without blocking the UI.
- Adding a rule that newly excludes 200 notes deletes their rows in a single transaction.

### Reference
planning/runtime.md → ".coworkignore" → "Edit surface".
EOF

# --- P4.1 deferred-questions doc / guards ---
cat > "$B-deferred.md" <<'EOF'
Encode the v1 "deferred" decisions from `planning/runtime.md` as clear failure modes rather than silent fallbacks, so we do not accidentally promise behavior we have not built:

- **Port collision (11434 in use, not by Ollama)**: detect during spawn and surface a clear error Notice ("Port 11434 in use by another process. Stop it and click Restart Ollama."). No automatic alternate-port negotiation in v1.
- **Resource budgets**: no UI sliders. Document defaults in the README runtime section.
- **Service integration (LaunchAgent / systemd / Windows service)**: not in v1; child-process only.
- **Bundling Ollama**: not shipping; first-run modal is the install path.
- **Ollama self-update API drift**: log the Ollama version on attach so issues can be triaged later.

### Acceptance
- Spawn against an occupied port produces the exact error text above and does not crash the plugin.
- Plugin log contains the Ollama version string on every successful attach/spawn.
- README "Runtime" section lists the deferred items so users know what is intentionally absent.

### Reference
planning/runtime.md → "Ollama lifecycle" → "Deferred questions".
EOF

# ---------------------------------------------------------------------------
# 4. Issues
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

echo "==> Creating issues"

# ---- Phase 1: Detection + lifecycle skeleton ----
create_issue "Runtime: detect Ollama (running / installed / missing / manual)" \
  "area:runtime,phase:1,enhancement" "$B-detect.md"

create_issue "Runtime: first-run install modal (one-click / browser / manual path)" \
  "area:runtime,area:packaging,phase:1,enhancement" "$B-firstrun.md"

create_issue "Runtime: spawn Ollama as child process with log capture" \
  "area:runtime,phase:1,enhancement" "$B-spawn.md"

create_issue "Runtime: graceful unload — stop only if we spawned it" \
  "area:runtime,phase:1,enhancement" "$B-unload.md"

# ---- Phase 2: Models, health, surfaces ----
create_issue "Runtime: pull required models (Gemma 4 E4B, BGE-M3, bge-reranker-v2-m3)" \
  "area:runtime,area:packaging,phase:2,enhancement" "$B-models.md"

create_issue "Runtime: 30s health-check loop with status-bar fallback + one-shot restart" \
  "area:runtime,area:ops,phase:2,enhancement" "$B-health.md"

create_issue "Runtime: status bar segment + Ollama path setting + Restart button" \
  "area:runtime,area:ops,phase:2,enhancement" "$B-settings.md"

# ---- Phase 3: .coworkignore ----
create_issue "Scope: gitignore-style .coworkignore parser with hard-coded exclusions" \
  "area:scope,phase:3,enhancement" "$B-ignore-parser.md"

create_issue "Scope: wire .coworkignore into indexer and file-watcher pipeline" \
  "area:scope,area:ingestion,phase:3,enhancement" "$B-ignore-indexer.md"

create_issue "Scope: Settings-tab editor with live affected-files counter and re-evaluation" \
  "area:scope,area:ops,phase:3,enhancement" "$B-ignore-editor.md"

# ---- Phase 4: Honest deferrals ----
create_issue "Runtime: encode deferred items as explicit failure modes (port, resources, bundling)" \
  "area:runtime,area:ops,phase:4,documentation" "$B-deferred.md"

echo "==> Done"
