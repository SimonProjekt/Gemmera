#!/usr/bin/env bash
set -euo pipefail

REPO="SimonProjekt/Gemmera"
MILESTONE="UI-plugin v1"

mk() {
  local title="$1" body_file="$2"; shift 2
  local labels=()
  for l in "$@"; do labels+=( -l "$l" ); done
  gh issue create --repo "$REPO" --title "$title" --milestone "$MILESTONE" \
    --body-file "$body_file" "${labels[@]}"
}

# Phase 1 — Skeleton + contracts
mk "Plugin skeleton: build, manifest, ribbon + open-chat command" \
  /tmp/uip-01-skeleton.md area:plugin area:build phase:1
mk "Cross-track contracts + LLM mock + Obsidian vault service" \
  /tmp/uip-02-contracts-mocks.md area:contracts area:plugin phase:1

# Phase 2 — Mocked end-to-end chat (M1 demo)
mk "Chat view (narrow): Svelte mount, ChatStore, streaming + cancel" \
  /tmp/uip-03-chat-view-narrow.md area:plugin phase:2
mk "NotePreviewModal + tool dispatcher (save_note create)" \
  /tmp/uip-04-preview-modal.md area:plugin area:tools phase:2
mk "Settings tab v1 + persistence + status bar entry point" \
  /tmp/uip-05-settings-statusbar.md area:settings area:plugin phase:2
mk "Wire real Ollama LLM behind LLMService factory (mock fallback)" \
  /tmp/uip-06-real-llm.md area:integration area:plugin phase:2

# Phase 3 — Full tool surface + history (M2)
mk "Tool dispatcher: all write tools + non-overridable DeleteConfirmModal" \
  /tmp/uip-07-tool-dispatcher-writes.md area:tools area:plugin phase:3
mk "Read tools via IndexService + citation chips with native hover" \
  /tmp/uip-08-read-tools-citations.md area:tools area:plugin phase:3
mk "Context menus + capture/ask commands" \
  /tmp/uip-09-context-capture-commands.md area:plugin phase:3
mk "Chat history drawer + DuckDB-shaped JSON persistence + retention" \
  /tmp/uip-10-history-persistence.md area:plugin area:storage phase:3

# Phase 4 — Polish, error handling, observability (M3)
mk "Error states: inline bubbles, recovery Notices, render boundary" \
  /tmp/uip-11-error-states.md area:plugin area:ops phase:4
mk "Dev-mode turn inspector modal" \
  /tmp/uip-12-turn-inspector.md area:plugin area:ops phase:4
mk "Live status bar driven by upstream state machine" \
  /tmp/uip-13-statusbar-live.md area:plugin area:ops phase:4
mk "Complete settings tab: indexing, privacy, advanced, .coworkignore" \
  /tmp/uip-14-settings-complete.md area:settings area:plugin phase:4
mk "Save Undo + ingestion-failure Details into inspector" \
  /tmp/uip-15-notices-undo.md area:plugin area:ops phase:4

# Phase 4 — Demo hardening / release
mk "Demo hardening + v0.1 release artifacts" \
  /tmp/uip-16-demo-hardening.md area:build area:plugin phase:4

echo "Done."
