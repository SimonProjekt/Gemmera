#!/usr/bin/env bash
# Create issues for the UI-surfaces v1 milestone.
# Convention: each issue uses --body-file pointing to /tmp/ui-*.md
set -euo pipefail

REPO="SimonProjekt/Gemmera"
MILESTONE="UI-surfaces v1"

mk() {
  local slug="$1"; shift
  local title="$1"; shift
  local labels="$1"; shift
  local body="$1"; shift
  local path="/tmp/ui-${slug}.md"
  printf '%s\n' "$body" > "$path"
  gh issue create --repo "$REPO" --title "$title" --label "$labels" --milestone "$MILESTONE" --body-file "$path"
}

# ---------- Phase 1: ChatView shell + responsive layout ----------

mk "chatview-itemview" \
  "ChatView ItemView scaffold + entry points" \
  "area:ui,phase:1" \
  "Implement the \`ChatView\` \`ItemView\` subclass registered via \`registerView(CHAT_VIEW, ...)\`. Default open location: right sidebar. Support drag between sidebar, main-area tab, and OS-level pop-out windows.

Entry points:
- Left ribbon icon (chat-bubble glyph) opens view in sidebar if not already open.
- Command \`cowork.open-chat\` with default hotkey \`Ctrl/Cmd+Shift+K\`.
- Drag/move via Obsidian's standard tab handles.

### Acceptance
- \`ChatView\` registers and opens in sidebar on first install.
- Hotkey opens chat with focus in composer.
- View survives drag from sidebar to tab to pop-out without losing live state (state lives on plugin instance — see separate state issue).
- Header renders: conversation title, new-chat button, location toggle, settings shortcut.
- Composer renders at bottom: text input, attach button, send button.

### Reference
\`planning/ui-surfaces.md\` — \"Primary view: ChatView\" and \"Decision: responsive hybrid chat view\". The plugin lifecycle scaffolding (manifest, build, registerView wiring at the plugin level) belongs to UI-plugin v1."

mk "responsive-layout" \
  "Responsive narrow/wide layout via CSS container query" \
  "area:ui,phase:1" \
  "Implement single-breakpoint responsive layout at container width 600 px using a CSS container query (not viewport media query) so layout responds to pane resize.

**Narrow (<600 px):** single column, messages stacked, citations as compact inline chips, retrieval detail behind a \"show sources\" expander, ingestion preview as modal, drag-drop target = composer row.

**Wide (≥600 px):** two columns, chat left ~60%, context panel right ~40%. Code blocks/tables/Mermaid render at full width. Drag-drop target = entire view.

### Acceptance
- Resizing the pane crosses the 600 px breakpoint and swaps layout without scroll jumps.
- Both modes render the shared header and composer.
- Wide mode reserves the right column for the context panel (content wired in a later issue).
- No JS resize listener needed — purely CSS container query.

### Reference
\`planning/ui-surfaces.md\` — \"Responsive layout\"."

mk "context-panel" \
  "Context panel content states (idle / query / ingestion)" \
  "area:ui,phase:1" \
  "Implement the right-side context panel shown only in wide mode. Contents change based on state:

- **Idle:** recent-captures list.
- **Active query:** retrieved chunks with scores and why-matched tags.
- **Active ingestion:** inline note preview (when \"inline preview\" setting is on — see preview modal issue).

### Acceptance
- Panel switches automatically based on chat state machine.
- Recent captures pull from the chat history store.
- Query state shows chunk text, score, and why-matched tags as supplied by retrieval (\`area:retrieval\` payload contract).
- Hidden in narrow mode.

### Reference
\`planning/ui-surfaces.md\` — \"Wide mode\" bullet about context panel. Cross-ref \`planning/rag.md\` for the retrieval payload shape."

# ---------- Phase 2: Chat behavior — state, streaming, citations ----------

mk "chat-state-persistence" \
  "Plugin-level chat state and chats.duckdb persistence" \
  "area:chat,area:storage,phase:2" \
  "Conversation state lives on the plugin instance, not on the leaf, so popping between sidebar/tab/pop-out preserves the live chat. Persist chat history to \`vault/.coworkmd/chats.duckdb\` — separate from the index.

Schema per chat: stable ID, auto-generated title (editable, derived from first user message), created timestamp, ordered list of turns. \"History\" drawer inside the view lists prior chats.

Default retention: unlimited. Settings option to cap at N days or N chats (UI lives in Settings tab issue).

### Acceptance
- Chats survive plugin reload and Obsidian restart.
- Detaching the view to a pop-out window keeps the conversation live.
- History drawer opens, lists chats, and lets the user load a prior chat.
- Title auto-generates from first user message and is editable inline.
- Deleting \`chats.duckdb\` does not affect the RAG index file.

### Reference
\`planning/ui-surfaces.md\` — \"State and persistence\"."

mk "streaming-cancellation" \
  "Token streaming + Stop button with immediate cancellation" \
  "area:chat,phase:2" \
  "Stream answers token-by-token via Ollama's SSE endpoint. The Send button becomes a Stop button during generation.

Cancellation behavior: model call aborted immediately; any in-flight tool calls complete but their results are dropped; the partial answer is preserved in history with a \"cancelled\" marker so the user can edit and retry.

### Acceptance
- Tokens render as they arrive with no perceptible buffering.
- Stop interrupts within ~100 ms of click.
- Cancelled turn is visually distinct and labelled.
- Edit-and-retry from a cancelled turn produces a new turn (does not overwrite).

### Reference
\`planning/ui-surfaces.md\` — \"Streaming and cancellation\"."

mk "citations-rendering" \
  "Citation chips + hover preview + keyboard cycling" \
  "area:ui,area:chat,phase:2" \
  "Render citations under each answer using Obsidian's standard wikilink format so hover preview, click-to-open, and modifier-click splits work for free.

- Narrow mode: compact inline chips beneath the answer.
- Wide mode: same chips, with the right-hand context panel showing chunk detail when a chip is focused/hovered.
- Keyboard: after an answer, \`Tab\` cycles citations; \`Enter\` opens; \`Shift+Enter\` opens in split.
- Surface a \"needs review\" flag per citation when retrieval marks low confidence.

### Acceptance
- Hovering a chip triggers Obsidian's native hover preview.
- Click opens the cited note in the main area; modifier-click splits (Obsidian default; do not override).
- \`Tab\` order is left-to-right across chips.
- \"Needs review\" chips are visually distinct (warning color, accessible label).

### Reference
\`planning/ui-surfaces.md\` — \"Hover preview compatibility\" and narrow/wide layout sections. Cross-ref \`planning/rag.md\` for citation payload + needs-review flag."

# ---------- Phase 3: Inbox / preview / capture surfaces ----------

mk "preview-modal" \
  "NotePreviewModal — pre-save commit gate" \
  "area:inbox,phase:3" \
  "\`NotePreviewModal\` is a dedicated \`Modal\` subclass shown before any note is written to the vault. Appears regardless of sidebar/tab mode because it is a commit gate, not a conversation surface.

Contents:
- Editable title.
- Editable folder path (defaults to \`Inbox/\`, configurable in settings).
- Editable frontmatter rendered as a form over the JSON contract from \`rag.md\`, with type-aware widgets for tags, aliases, status.
- Markdown body preview via \`MarkdownRenderer.renderMarkdown\` so it matches Obsidian's native rendering.
- \"Split into multiple notes\" toggle: when enabled, lists proposed notes and lets user confirm each independently.
- Confirm / Edit / Cancel buttons.

### Acceptance
- Modal blocks file write until confirmed.
- Frontmatter editor enforces the \`rag.md\` schema (rejects invalid types).
- Body preview is visually identical to native rendering.
- Split mode produces N independent confirm flows; cancelling one does not cancel the others.
- Keyboard: \`Tab\` cycles fields, \`Ctrl/Cmd+Enter\` confirms, \`Esc\` cancels.

### Reference
\`planning/ui-surfaces.md\` — \"Preview modal (pre-save confirmation)\". Cross-ref \`planning/rag.md\` for frontmatter contract."

mk "direct-save-undo" \
  "Direct-save path + Notice with Undo (preview-off mode)" \
  "area:inbox,phase:3" \
  "When \"Always preview before save\" is off, Cowork writes directly to the configured inbox folder with the proposed content and surfaces a Notice with an Undo action. Undo reverts the write via \`vault.trash\`.

Also implement the wide-mode \"inline preview\" setting (default off) that collapses the modal step and surfaces the same preview form in the right context panel.

### Acceptance
- Toggling preview-off and saving writes the file and shows the Notice with Undo.
- Undo trashes the file via \`vault.trash\` (recoverable from .trash).
- Inline-preview mode in wide layout shows the form in the context panel and never opens a modal; in narrow layout it falls back to the modal.

### Reference
\`planning/ui-surfaces.md\` — \"Preview modal (pre-save confirmation)\" final two paragraphs."

mk "capture-commands-context-menus" \
  "Capture commands and editor/file context menus" \
  "area:ui,area:chat,phase:3" \
  "Implement the v1 capture commands and context-menu integrations:

Commands (all via \`addCommand\`):
- \`cowork.capture-selection\` — default \`Ctrl/Cmd+Shift+C\`. Sends active editor selection to chat composer with capture intent pre-selected.
- \`cowork.capture-active-note\` — sends whole active note.
- \`cowork.ask-about-active-note\` — opens chat with pre-filled prompt including a wikilink to the active note.
- \`cowork.new-chat\`, \`cowork.open-chat-tab\` (no defaults).

Context menus via \`editor-menu\`, \`file-menu\`, \`files-menu\` workspace events:
- Editor selection: \"Cowork: capture selection\", \"Cowork: ask about this selection\".
- Single file: \"Cowork: ask about this note\", \"Cowork: find related notes\", \"Cowork: reindex this note\".
- Multi-file: \"Cowork: ask across these notes\", \"Cowork: synthesize these notes\".

### Acceptance
- All commands appear in the command palette and accept user-rebinding.
- Capture-selection hotkey works from any open editor.
- Right-click on a single file in the explorer shows the three Cowork items.
- Right-click on multi-selection shows the two multi-file items.
- Ask-about-active-note inserts a working wikilink into the composer.

### Reference
\`planning/ui-surfaces.md\` — \"Commands (exhaustive list for v1)\" and \"Context menus\". Indexer commands (\`reindex-active-note\`, \`rebuild-index\`, \`pause-indexer\`, \`resume-indexer\`) are covered in the indexing-controls issue."

# ---------- Phase 4: Status, settings, ops surfaces ----------

mk "status-bar-indexing-pill" \
  "Status bar item with precedence-ordered states" \
  "area:ui,area:ops,phase:4" \
  "Single \`StatusBarItem\` at the right end of Obsidian's status bar. Shows in this precedence order:

1. Active cold-start or rebuild: \"Indexing 1,240 / 5,000\" with a small progress dot.
2. Active query: \"Thinking…\" with subtle spinner.
3. Active ingestion: \"Ingesting…\" with subtle spinner.
4. Idle and healthy: model name and readiness, e.g. \"Gemma 4 E4B · ready\".
5. Idle but unhealthy: warning state, e.g. \"Ollama not running — click to fix\".

Clicking opens chat in current default location.

### Acceptance
- Only one item is ever shown; precedence is strict.
- Indexing counter updates live during cold-start.
- Spinners are subtle (no fast rotation — see accessibility issue).
- Click opens chat.
- Unhealthy state click triggers the relevant Notice action (e.g. start Ollama).

### Reference
\`planning/ui-surfaces.md\` — \"Status bar\"."

mk "ribbon-and-notices" \
  "Ribbon icon menu + transient Notice patterns" \
  "area:ui,phase:4" \
  "Left-ribbon icon (chat-bubble glyph) opens chat. Right-click menu: \"Open in sidebar\", \"Open in tab\", \"Open in new window\", \"Settings\".

Notices (transient feedback only — not used for routine success):
- \"Note saved to \`Inbox/<title>.md\`\" with Undo action.
- \"Ingestion failed: <short reason>\" with Details action that opens the turn inspector.
- \"Ollama not running — start it?\" with Start action (attempts to launch Ollama).
- \"Indexing paused automatically (low battery)\" with Resume action.

### Acceptance
- Ribbon left-click opens chat in default location.
- Ribbon right-click shows the four-item menu.
- Each Notice variant fires from the right trigger and exposes its action button.
- Notices are not shown for every successful save/query (only the four cases above).

### Reference
\`planning/ui-surfaces.md\` — \"Ribbon icon\" and \"Notices\"."

mk "settings-tab" \
  "CoworkSettingsTab — all six sections" \
  "area:settings,phase:4" \
  "Implement \`CoworkSettingsTab\` (\`PluginSettingTab\`) with these sections:

- **General:** inbox folder, default note location, \`.coworkignore\` editor.
- **Model:** Ollama path (detected or manual). Orchestration model, embedding model, reranker fixed in v1 (Gemma 4 E4B + BGE-M3 + bge-reranker-v2-m3) shown read-only with \"re-pull\" buttons.
- **Indexing:** pause/resume, rebuild index, last-indexed timestamp, excluded folders, re-chunk on config change.
- **Chat:** preview-before-save default (default on), inline-preview toggle (wide mode, default off), chat history retention, streaming on/off.
- **Privacy:** what gets logged to \`events.duckdb\`, buttons to clear history, clear index, clear logs.
- **Advanced:** developer-mode toggle (exposes turn inspector), golden-set runner, eval metrics chart.

### Acceptance
- All six sections render with the listed controls.
- Read-only model fields show current version and a working re-pull button.
- \`.coworkignore\` editor saves to the vault with proper validation.
- Toggles persist across reload.
- Clear-history / clear-index / clear-logs prompt for confirmation before destructive action.

### Reference
\`planning/ui-surfaces.md\` — \"Settings tab\". Cross-ref \`planning/rag.md\` for index/embedding model contracts."

mk "indexing-controls" \
  "Indexer command bindings + settings wiring" \
  "area:ops,area:ui,phase:4" \
  "Wire the indexer commands so they appear in the command palette and are usable from the Settings → Indexing section:

- \`cowork.reindex-active-note\` — force re-chunk and re-embed of the active note.
- \`cowork.rebuild-index\` — full vault re-scan.
- \`cowork.pause-indexer\` / \`cowork.resume-indexer\`.

These commands drive the same backend operations exposed by the Settings → Indexing buttons.

### Acceptance
- All four commands appear in the palette and are rebindable.
- Pause/resume reflects in the status-bar pill within 1 s.
- Rebuild-index prompts for confirmation (it is destructive of incremental progress).
- Reindex-active-note is a no-op (with toast) when no editor is active.

### Reference
\`planning/ui-surfaces.md\` — \"Commands (exhaustive list for v1)\" indexer entries and \"Settings tab → Indexing\"."

mk "keyboard-flow-a11y" \
  "Keyboard-first flow + accessibility pass" \
  "area:a11y,area:ui,phase:4" \
  "Implement the keyboard flow and accessibility commitments end-to-end.

Keyboard flow:
1. \`Ctrl/Cmd+Shift+K\` opens chat in sidebar with composer focus.
2. \`Enter\` sends; \`Shift+Enter\` newline.
3. \`Esc\` clears composer; second \`Esc\` closes chat.
4. \`Ctrl/Cmd+Enter\` in composer forces \"ingest\" intent.
5. After answer: \`Tab\` cycles citations; \`Enter\` opens; \`Shift+Enter\` splits.
6. Preview modal: \`Tab\` cycles fields, \`Ctrl/Cmd+Enter\` confirms, \`Esc\` cancels.

Accessibility:
- All interactive elements have ARIA roles and labels.
- Focus states visible, not suppressed.
- Color contrast meets WCAG AA against default theme + Minimal + Things community themes.
- Respect Obsidian's font-size setting; no hard-coded pixel text sizes.
- No flashing or fast motion during streaming — subtle progress dot, not rotating spinner.

### Acceptance
- Full chat → cite → open flow completable without a mouse.
- Axe / aria-lint clean against ChatView, NotePreviewModal, SettingsTab.
- Manual contrast check passes on the three named themes.
- Streaming indicator does not exceed safe-motion thresholds.

### Reference
\`planning/ui-surfaces.md\` — \"Keyboard flow\" and \"Accessibility\"."

mk "turn-inspector" \
  "Turn inspector (dev-mode debugger view)" \
  "area:ui,area:ops,phase:4" \
  "Power-user debugger view exposed only when developer-mode is on (Settings → Advanced).

Command: \`cowork.open-turn-inspector\`. Surfaces, per turn: prompt sent, retrieved chunks with scores, tool calls + arguments + results, model output stream, latency breakdown, any errors. Opens from the \"Details\" action on ingestion-failed Notices.

### Acceptance
- Hidden when dev-mode is off (no command, no menu entry).
- Selecting a turn from chat history opens its inspector.
- Ingestion-failed Notice → Details opens the inspector for the failing turn.
- All retrieved chunk scores and why-matched tags are visible.

### Reference
\`planning/ui-surfaces.md\` — \"Commands\" (\`cowork.open-turn-inspector\`), \"Settings tab → Advanced\", and \"Notices\" (Details action)."

echo
echo "Done. Verify with:"
echo "  gh issue list --repo $REPO --milestone \"$MILESTONE\""
