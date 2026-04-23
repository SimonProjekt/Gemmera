# UI Surfaces

Obsidian gives a plugin a well-defined set of UI surfaces. This document pins how Cowork uses each one, so future changes do not re-open settled questions. All decisions here assume the desktop-only scope committed to in `instruction.md`.

## Decision: responsive hybrid chat view

The chat lives in a single `ItemView` subclass that can be opened either in the right sidebar or as a main-area tab. The interior layout is responsive and adapts to its container width. Default location on first install is the right sidebar; users can pop out to a tab at any time, or drag the view into a new OS-level pop-out window.

This avoids the pane-vs-tab false choice. The ambient "ask about what I'm reading" use case stays in the sidebar. The heavy "ingest a long document" and "synthesize across ten notes" use cases get real estate in a tab.

## Primary view: ChatView

Registered once via `registerView(CHAT_VIEW, leaf => new ChatView(leaf, plugin))`. Opened through three entry points:

- A ribbon icon (left ribbon) that opens the view in the right sidebar if it is not already open.
- A command "Open Cowork chat" with a default hotkey of `Ctrl/Cmd+Shift+K`.
- User-driven drag of the view's tab between sidebar, main area, and pop-out windows, supported automatically by Obsidian.

### Responsive layout

Single breakpoint at container width 600 px. Use a CSS container query, not a viewport media query, so the layout responds to pane resizes rather than window resizes.

**Narrow mode (<600 px, typical sidebar):**

- Single column. Messages stacked top to bottom.
- Citations render as compact inline chips beneath each answer.
- Retrieval detail (chunks, scores, why-matched tags) hidden behind a "show sources" expander.
- Ingestion preview is shown as a modal (see below), because the pane has no room for inline preview.
- Drag-and-drop target is the input composer row at the bottom.

**Wide mode (≥600 px, typical tab or widened sidebar):**

- Two columns. Chat on the left takes roughly 60% of width; a context panel on the right takes 40%.
- The context panel contents change based on state: idle shows a recent-captures list; during a query it shows retrieved chunks with scores and why-matched tags; during ingestion it shows an inline note preview with no modal needed.
- Code blocks, tables, and Mermaid/Canvas embeds render at full width.
- Drag-and-drop target is the entire view.

Both modes share a header (conversation title, new-chat button, location toggle, settings shortcut) and a composer at the bottom (text input, attach button, send button).

### State and persistence

Conversation state lives on the plugin instance, not on the leaf. Popping between sidebar and tab, or detaching to a pop-out window, preserves the live chat.

Chat history is persisted to `vault/.coworkmd/chats.duckdb` — a separate file from the index, so users can delete chat history without losing the index. Each chat has a stable ID, an auto-generated title (editable, derived from the first user message), a created timestamp, and an ordered list of turns. Users can open prior chats via a "History" drawer inside the view.

Default retention is unlimited. A settings option lets users cap at N days or N chats.

### Streaming and cancellation

Answers stream token-by-token via Ollama's SSE endpoint. A Stop button replaces the Send button during generation. Cancellation is immediate: the model call is aborted, any in-flight tool calls complete but their results are dropped, and the partial answer is preserved in history with a "cancelled" marker so the user can edit and retry.

## Supporting surfaces

### Preview modal (pre-save confirmation)

A dedicated `Modal` subclass, `NotePreviewModal`, shown before any note is written to the vault. This modal appears regardless of whether the chat is in sidebar mode or tab mode, because it is a commit gate, not a conversation surface.

Contents:

- Editable title.
- Editable folder path (defaults to `Inbox/`, with the user's preferred inbox folder configurable in settings).
- Editable frontmatter, rendered as a form over the JSON contract from `rag.md` with type-aware widgets for tags, aliases, and status.
- Markdown body preview rendered via `MarkdownRenderer.renderMarkdown` so it looks identical to Obsidian's native rendering.
- A "split into multiple notes" toggle that, when enabled, shows a list of proposed notes and lets the user confirm each independently.
- Confirm / Edit / Cancel buttons.

The "Always preview before save" setting defaults to on. When off, Cowork writes directly to `Inbox/` with the proposed content and surfaces a Notice with an Undo action (the undo reverts the file write via `vault.trash`).

In wide mode, an "inline preview" setting (default: off) collapses the modal step and surfaces the same form in the context panel. Users who do heavy ingestion can flip this on.

### Settings tab

A `PluginSettingTab`, `CoworkSettingsTab`, with the following sections:

- **General**: inbox folder, default note location, `.coworkignore` editor.
- **Model**: Ollama path (detected or manual). The orchestration model, embedding model, and reranker are fixed in v1 (Gemma 4 E4B + BGE-M3 + bge-reranker-v2-m3) and shown as read-only status with "re-pull" buttons.
- **Indexing**: pause/resume, rebuild index, last-indexed timestamp, excluded folders, re-chunk on config change.
- **Chat**: preview-before-save default, inline-preview toggle in wide mode, chat history retention, streaming on/off.
- **Privacy**: what gets logged to `events.duckdb`, buttons to clear history, clear index, clear logs.
- **Advanced**: developer-mode toggle (exposes the turn inspector), golden-set runner, eval metrics chart.

### Status bar

A single `StatusBarItem` at the right end of Obsidian's status bar. Shows, in order of precedence:

1. Active cold-start or rebuild: "Indexing 1,240 / 5,000" with a small progress dot.
2. Active query: "Thinking…" with a subtle spinner.
3. Active ingestion: "Ingesting…" with a subtle spinner.
4. Idle and healthy: model name and readiness, e.g. "Gemma 4 E4B · ready".
5. Idle but unhealthy: warning state, e.g. "Ollama not running — click to fix".

Clicking the status bar item opens the chat view in its current default location.

### Ribbon icon

One left-ribbon icon (chat-bubble glyph) that opens the chat. Right-click gives a menu: "Open in sidebar", "Open in tab", "Open in new window", "Settings".

### Commands (exhaustive list for v1)

All registered via `addCommand` so they appear in the command palette and are bindable to hotkeys.

- `cowork.open-chat` — default hotkey `Ctrl/Cmd+Shift+K`.
- `cowork.open-chat-tab` — no default.
- `cowork.new-chat` — no default.
- `cowork.capture-selection` — default `Ctrl/Cmd+Shift+C`. Sends the active editor selection into the chat composer with capture intent pre-selected.
- `cowork.capture-active-note` — sends the whole active note into the composer.
- `cowork.ask-about-active-note` — opens the chat with a pre-filled prompt including a wikilink to the active note.
- `cowork.reindex-active-note` — force re-chunk and re-embed of the active note.
- `cowork.rebuild-index` — full vault re-scan.
- `cowork.pause-indexer` / `cowork.resume-indexer`.
- `cowork.open-turn-inspector` — power-user debugger view, dev mode only.

### Context menus

Registered via Obsidian's `editor-menu`, `file-menu`, and `files-menu` workspace events.

- Editor selection menu: "Cowork: capture selection", "Cowork: ask about this selection".
- Single file menu in the explorer: "Cowork: ask about this note", "Cowork: find related notes", "Cowork: reindex this note".
- Multi-file menu: "Cowork: ask across these notes", "Cowork: synthesize these notes".

### Notices

Used for transient feedback only. Shown for:

- "Note saved to `Inbox/<title>.md`" with an Undo action.
- "Ingestion failed: <short reason>" with a Details action that opens the turn inspector.
- "Ollama not running — start it?" with a Start action (attempts to launch Ollama).
- "Indexing paused automatically (low battery)" with a Resume action.

Notices are not used for success on every operation — only for things the user might want to undo or act on.

### Hover preview compatibility

Citations in chat answers use Obsidian's standard wikilink format under the hood, so hovering a citation triggers Obsidian's built-in hover preview for free. Clicking opens the cited note in the main area. Modifier-click splits, matching Obsidian's default behavior — Cowork does not override it.

## What we deliberately do not touch

To minimize friction with the rest of Obsidian and the plugin ecosystem, Cowork does not:

- Modify the reading view or the editor's rendering pipeline. No CodeMirror extensions in v1.
- Inject content into notes silently. Every edit is either explicit user action or atomic, reversible, and marked with the `cowork` frontmatter block.
- Override core hotkeys. All Cowork commands either have novel default hotkeys or none at all; users can rebind freely.
- Add items to the left sidebar. File explorer, search, and bookmarks belong to Obsidian and the user's other plugins.
- Create custom file types or custom views for existing file types. Notes remain plain Markdown; any Canvas synthesis outputs (v2) remain standard `.canvas` files.

## Keyboard flow

A keyboard-first user should be able to:

1. `Ctrl/Cmd+Shift+K` opens the chat in the sidebar with focus in the composer.
2. Typing, then `Enter`, sends. `Shift+Enter` inserts a newline.
3. `Esc` while composing clears the composer; a second `Esc` closes the chat.
4. `Ctrl/Cmd+Enter` in the composer forces "ingest" intent for the current content, useful when auto-classification picks the wrong mode.
5. After an answer, `Tab` cycles through citations. `Enter` on a focused citation opens the note; `Shift+Enter` splits it into a new pane.
6. In the preview modal: `Tab` cycles fields, `Ctrl/Cmd+Enter` confirms save, `Esc` cancels.

## Accessibility

- All interactive elements have ARIA roles and labels.
- Focus states are visible, not suppressed.
- Color contrast meets WCAG AA against Obsidian's default theme and popular community themes (Minimal, Things).
- Respect Obsidian's font-size setting; do not hard-code pixel values for text.
- Avoid flashing or fast motion during query streaming — loading states are a subtle progress dot, not a rotating spinner.

## Out of scope for v1

Given the desktop-only commitment:

- Mobile layout variants are not designed.
- Touch-target sizing and swipe gestures are not addressed.
- Canvas-first synthesis outputs land in v2 (ship standard Markdown synthesis notes first).
- Graph view highlighting of cited notes lands in v2.
- Localization (i18n scaffolding) lands in v2.

These are tracked in a future `roadmap.md`, not here.
