# Runtime behavior

This document pins decisions about external runtime management (Ollama) and indexing scope control (.coworkignore). Both are user-visible but sit outside the core chat flow.

## Ollama lifecycle

**Decision**: the plugin spawns and manages Ollama. Users do not need to know what Ollama is — they install the plugin, and chat works.

### Lifecycle

- **On plugin load**: detect Ollama.
  - If the binary is installed and a server is already running on the default port (11434), attach to the existing instance. Do not restart it.
  - If the binary is installed but no server is running, spawn Ollama as a child process with stdout/stderr captured to the plugin log.
  - If the binary is not installed, open a first-run modal offering three paths:
    1. One-click install via Homebrew (macOS), winget (Windows), or the upstream installer script (Linux), whichever is detected on the platform.
    2. Open the Ollama download page in the user's browser for manual install.
    3. Manual path entry for advanced users who have Ollama installed in a non-standard location.
- **Model pull**: after Ollama is up, verify that the three required models are present. If not, pull them with a single progress modal. Required models are Gemma 4 E4B (~3 GB) for orchestration, BGE-M3 (~2 GB) for embeddings, and bge-reranker-v2-m3 (~0.6 GB) for reranking. These three are the only models v1 supports — there is no smaller-model "lite" mode and no larger-model "power" mode.
- **Health checks**: ping `/api/tags` every 30 seconds. If the ping fails three times in a row, transition the status bar to "Ollama not responding — click to restart" and attempt a single restart on the next user action.
- **On plugin unload**: if the plugin spawned Ollama, stop it. If Ollama was already running when the plugin loaded, leave it alone.

### What the user sees

- A first-run modal during installation that walks through detection, install if needed, and model pull as one continuous progress experience.
- The status bar shows model readiness at all times.
- A single setting ("Ollama path: auto / manual") plus a "Restart Ollama" button in advanced settings.

### Deferred questions

The following are intentionally not specified for v1. They are recorded here so we can return to them without losing context.

- Cross-platform service integration. Should Ollama run as a macOS LaunchAgent, a Windows service, a Linux systemd unit? For v1, child-process is fine; long-term, OS-integrated is nicer (no restart cost per Obsidian session).
- Port collision handling. What if another process holds 11434? For v1, fail with a clear error. Long-term, negotiate an alternate port.
- Resource budgets. CPU / RAM / GPU caps for Ollama. For v1, Ollama's defaults. Long-term, user-configurable sliders.
- Ollama self-update. Ollama auto-updates on some platforms. When its API shifts, the plugin may break. Long-term, pin a supported version range and warn on mismatch.
- Bundling. Should the plugin ship Ollama to avoid the install step? Probably no — binary size, licensing, and update cadence all argue against bundling. Revisit if user friction proves high.
- GPU acceleration tuning. Apple Silicon, NVIDIA, and Intel Arc all work with the fixed v1 model set out of the box through Ollama; any acceleration tuning beyond Ollama's defaults is deferred.

## .coworkignore: indexing scope control

**Decision**: a gitignore-style pattern file at `vault/.coworkignore` that controls which files the indexer sees.

### What it affects

- **Indexing**: matched files are skipped entirely — not chunked, not embedded, not added to the `notes` table.
- **Retrieval**: because matched files never enter the index, they never appear in retrieval results.
- **File watcher**: events for matched paths are ignored, so edits do not trigger reindex attempts.

### What it does not affect

- **Ingestion targets**: where new notes get written is controlled by the "Inbox folder" setting, not `.coworkignore`.
- **Obsidian's own behavior**: Obsidian still shows matched files in the explorer, search, and graph — this is a Cowork-only control.
- **Hard-coded exclusions**: `.obsidian/`, `.git/`, `.trash/`, and `.coworkmd/` are always excluded regardless of `.coworkignore`. The ignore file cannot un-exclude them.

### Format

Gitignore-style globs. Chosen for familiarity: Obsidian users who sync via git or use `.obsidianignore` already know the syntax, and every common glob library supports it.

Supported syntax:

- `folder/` matches the folder and everything under it.
- `*.canvas` matches all canvas files in any folder.
- `Templates/**` matches everything under Templates at any depth.
- `!Templates/KeepMe.md` negates a prior exclusion.
- `# comment` ignores the rest of the line.

Evaluation is last-match-wins, consistent with gitignore.

### Default contents on first install

```
# Cowork does not index these by default. Edit or remove as you like.
Templates/
Attachments/
attachments/
assets/
*.canvas
*.excalidraw
```

Users with a Daily Notes workflow may want to exclude the daily notes folder, but we do not assume that — many users want their journals in the index.

### Edit surface

- Edited through the Settings tab (plain textarea with syntax hints and a live "this many files will be affected" counter).
- Saved as `vault/.coworkignore` so it travels with the vault.
- Changes are live: within 1 second of save, the indexer re-evaluates every note and removes or adds entries as needed. Large removals show a progress Notice.

### Per-operation rules (deferred)

Some users will eventually want more granular control — "index Daily Notes but never write new notes there," "include attachments in search results but do not chunk PDFs." The v1 `.coworkignore` applies uniformly to indexing scope. Finer rules are deferred because:

- They require a richer config format (YAML sections, or a separate file per operation).
- Few users need them at MVP scope.
- The combination of "Inbox folder" + `.coworkignore` covers most common cases.

If v2 adds per-operation rules, the path is a new `.coworkconfig.yaml` that subsumes `.coworkignore`, rather than proliferating dotfiles.
