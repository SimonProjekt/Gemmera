# UI-Plugin: End-to-end execution plan (Person B)

This is the execution plan for the Obsidian plugin / UI track. It sequences the work from empty repo to a polished v0.1 demo, and says what each PR delivers. Scope, surfaces, and decisions are pinned in `ui-surfaces.md` and `overview.md` — this doc is purely about *how we get there*, in what order, and against which contracts.

## Operating principles

- **Contract-first.** Everything the UI consumes from other tracks is an interface in `src/contracts/`. The UI never imports a concrete LLM or vault-index class; only `LLMService`, `VaultService`, `IndexService`. A `MockLLMService` and `MockVaultService` live alongside the contracts and are used until Person A / Person C ship real implementations.
- **Every PR is demoable.** No PR leaves main in a state that cannot be opened in Obsidian and shown to a TA. If the real LLM isn't wired up yet, the mock answers.
- **State on the plugin, not the leaf.** The chat view reads from a single `ChatStore` on the plugin instance so that popping between sidebar / tab / pop-out preserves state (see `ui-surfaces.md` §State and persistence).
- **Svelte for the view interior.** The Obsidian `ItemView` hosts a Svelte root. All reactive UI is Svelte; Obsidian API calls stay at the plugin boundary.
- **No silent vault writes.** Every write flows through `NotePreviewModal` (or `DeleteConfirmModal`) until the user toggles "Always preview" off in settings — and even then, deletes stay gated.

## Tech choices (pinned for the UI track)

- TypeScript, Obsidian plugin template.
- Svelte 5 (runes mode) for the view interior.
- esbuild via the standard Obsidian plugin build script.
- CSS container queries for the 600 px responsive breakpoint (no viewport media queries in the chat view).
- Vitest for unit tests on pure logic (store reducers, message parsing). UI is smoke-tested by hand against the mock LLM.

## Directory layout we are building toward

```
src/
  main.ts                      # Plugin entry — registerView, commands, ribbon, statusbar
  contracts/
    llm.ts                     # LLMService + ChatMessage + Tool + LLMResponse
    vault.ts                   # VaultService
    index.ts                   # IndexService (stub for now; Person C fills later)
    mocks/
      mock-llm.ts
      mock-vault.ts
  view/
    ChatView.ts                # ItemView host; mounts Svelte root
    ChatRoot.svelte            # Responsive container (narrow/wide)
    Composer.svelte
    MessageList.svelte
    Message.svelte
    CitationChip.svelte
    ContextPanel.svelte        # Wide-mode right column
    HistoryDrawer.svelte
  modals/
    NotePreviewModal.ts
    DeleteConfirmModal.ts
  settings/
    CoworkSettingsTab.ts
    settings-store.ts
  store/
    chat-store.ts              # Conversation state, streaming, cancellation
    persistence.ts             # chats.duckdb read/write — stubbed as JSON file in M1
  tools/
    tool-dispatcher.ts         # Maps LLM tool_call → VaultService calls → preview gate
  commands.ts                  # All `cowork.*` commands
  statusbar.ts
  ribbon.ts
styles.css
manifest.json
```

## Milestones

### M0 — Repo + skeleton plugin (Week 1, Day 1)

The plugin builds, loads in a dev vault, and opens an empty view in the right sidebar. Nothing smart happens yet. This milestone exists to unblock everything else: once it's green, every future PR is additive.

**PR 1 — `ui/00-skeleton`**
- Obsidian plugin template scaffolded.
- `manifest.json` with `isDesktopOnly: true`, id `cowork`, correct min Obsidian version.
- `npm run dev` hot-reloads into a local test vault via a symlink documented in `README.dev.md`.
- Empty `ChatView` registered under `CHAT_VIEW_TYPE`; ribbon icon opens it; command `cowork.open-chat` with `Ctrl/Cmd+Shift+K`.
- CI: typecheck + build + `npm run lint`.

### M1 — Mocked end-to-end chat (Week 1, Days 2–5)

A user can open the chat, type a message, see a streamed reply from the mock LLM, see a proposed file creation as a tool call, confirm it in a preview modal, and find the resulting note in the vault. The real LLM is not wired; `MockLLMService` returns scripted answers so the full UI path can be exercised in isolation.

This is Person B's **Friday v1 deliverable** from the parent plan.

**PR 2 — `ui/01-contracts-and-mocks`**
- `src/contracts/llm.ts`, `vault.ts`, `index.ts` matching the types from the parent plan (`LLMService`, `VaultService`, `ChatMessage`, `LLMResponse`, `Tool`, `SearchResult`).
- `MockLLMService` with a small scripted-reply map: recognizes keywords ("create", "search", plain chat) and returns the appropriate `LLMResponse` (text stream, or a `tool_call` for `save_note`).
- `MockVaultService` backed by Obsidian's real `Vault` API — this is the *actual* vault service; only the LLM is mocked in M1. (Naming: the file is `real-vault.ts` exporting `ObsidianVaultService`; the "mock" vault is only used in Vitest.)
- Vitest smoke tests for the mock LLM and for parsing a streamed response.

**PR 3 — `ui/02-chat-view-narrow`**
- Svelte root mounted inside `ChatView`. Narrow-mode layout only (single column, composer at bottom).
- `ChatStore` with: `messages[]`, `streamingMessageId`, `pendingToolCall`, `cancel()`, `send(text)`.
- Streaming render: tokens append into the in-flight assistant message as they arrive from the (mock) `AsyncGenerator<string>`.
- `Send` ↔ `Stop` button swap during generation. `Stop` aborts the generator and marks the partial answer `cancelled` in the store (see `ui-surfaces.md` §Streaming and cancellation).
- Enter sends, Shift+Enter newlines, Esc clears, second Esc closes — matching §Keyboard flow.

**PR 4 — `ui/03-preview-modal`**
- `NotePreviewModal` with editable title, folder path (defaults to `Inbox/`), frontmatter form, Markdown body preview via `MarkdownRenderer.renderMarkdown`.
- `tool-dispatcher.ts`: when the LLM emits a `tool_call` for `save_note` with `mode: "create"`, the dispatcher opens the modal, awaits Confirm/Cancel, and then invokes `VaultService.createFile` on confirm.
- Confirm writes the note; Cancel drops the tool call and appends a system message in the chat ("Save cancelled.").
- Manual test checklist added to `README.dev.md`.

**PR 5 — `ui/04-settings-and-statusbar`**
- `CoworkSettingsTab` with the Week-1 subset of §Settings tab: General (inbox folder, default note location), Chat (preview-before-save toggle — default on, streaming on/off), Model (read-only status placeholder).
- `settings-store.ts` persists via Obsidian's `loadData` / `saveData`.
- Status bar item showing static "Gemma (mock) · ready" for now. Click opens the chat.
- `cowork.new-chat`, `cowork.open-chat-tab` commands.

**M1 exit criteria** (demo script):
1. Fresh install → ribbon click → chat opens in sidebar.
2. Type "create a note about dogs" → mock LLM streams a reply and emits a `save_note` tool call → preview modal shows → Confirm → file appears under `Inbox/`.
3. Type "hello" → mock LLM streams a plain-text reply with no tool call.
4. Mid-stream Stop aborts; partial answer is retained and marked cancelled.

### M1.5 — Friday v1 integration with Person A's real LLM (Week 1, end)

**PR 6 — `integration/01-real-llm`**
- Add `OllamaLLMService implements LLMService` (Person A delivers the implementation; this PR is the wire-up from the UI side).
- `LLMServiceFactory` in `main.ts` picks between `OllamaLLMService` and `MockLLMService` based on a dev-only setting. Default is `ollama`; fallback to mock if Ollama is unreachable, with a Notice.
- Mock stays in the tree and in CI — it is now our offline/demo fallback, not just a stub.

### M2 — Wide mode + full CRUD + richer tool handling (Week 2)

The plugin can be dragged to a main-area tab and presents a two-column layout. All write tools from `tool-loop.md` are wired up to preview gates; the delete modal is non-overridable.

**PR 7 — `ui/05-wide-mode-layout`**
- CSS container query at 600 px switches `ChatRoot` to two-column layout.
- `ContextPanel.svelte` shows: idle → recent captures list (stubbed from chat history); during a query → pending tool-call details / retrieved chunks (chunks are a stub until Person C's index lands); during ingestion → the inline preview form when the user has enabled the "inline preview" setting.
- Inline-preview mode short-circuits `NotePreviewModal` in wide mode only.
- Tab entry point via `cowork.open-chat-tab`; drag between sidebar and tab preserves conversation (verifies store-on-plugin design).

**PR 8 — `ui/06-tool-dispatcher-all-writes`**
- `tool-dispatcher.ts` handles `save_note(mode=append)`, `update_frontmatter`, `rename_or_move_note`, `delete_note`, `create_synthesis_note`.
- `DeleteConfirmModal` is a separate modal class, required even when "Always preview" is off. Includes note title, path, and a 1-word "delete" typed confirmation for extra friction.
- Append mode uses the dated-heading convention from `tool-loop.md`.
- Rename/move calls `FileManager.renameFile` so incoming links update atomically.

**PR 9 — `ui/07-read-tools-and-citations`**
- Tool dispatcher handles read tools (`search_notes`, `get_note`, `find_related_notes`, `list_folder`) by delegating to `IndexService`. Until Person C's index is real, `StubIndexService` returns fixture results drawn from the demo vault.
- Citations in assistant replies render as wikilink chips (`CitationChip.svelte`). Hovering triggers Obsidian's native hover preview (uses standard wikilink format, no custom hover logic). Click opens the note; modifier-click splits — inherited from Obsidian, not overridden.
- Tab cycles through citations; Enter opens; Shift+Enter splits.

**PR 10 — `ui/08-context-menus-and-capture-commands`**
- `editor-menu`, `file-menu`, `files-menu` handlers for the commands listed in `ui-surfaces.md` §Context menus.
- `cowork.capture-selection` (`Ctrl/Cmd+Shift+C`), `cowork.capture-active-note`, `cowork.ask-about-active-note`.
- Selection / active note is inserted into the composer with a small chip indicating capture vs. ask intent.

**PR 11 — `ui/09-chat-history-drawer`**
- `HistoryDrawer.svelte` lists prior chats with title, timestamp, turn count.
- Persistence layer v1: JSON file at `vault/.coworkmd/chats.json`. The `chats.duckdb` migration is deferred to M3 to avoid blocking on DuckDB setup; the persistence API surface is already DuckDB-shaped so the swap is internal.
- Chat retention setting (N days / N chats / unlimited — default unlimited).
- Auto-title from first user message.

**M2 exit criteria**:
- Drag chat from sidebar to tab mid-conversation; state is preserved, layout swaps to two-column.
- All six write tools fire through the correct preview path. Delete forces the typed confirmation even with Always-preview off.
- Citations are clickable and hoverable, matching native Obsidian behavior.
- Closing and reopening Obsidian restores the previous chat list.

### M3 — Streaming polish, error handling, observability UI (Week 3)

The UI stops feeling like a demo and starts feeling like a product. This milestone is where failure modes get first-class treatment.

**PR 12 — `ui/10-error-states`**
- Ollama-down, model-missing, timeout, and tool-error paths all render as inline error bubbles in the message list with a Retry affordance.
- Notice-based recovery for common cases: "Ollama not running — Start" (attempts `child_process.spawn`), "Indexing paused (low battery) — Resume".
- Global error boundary around `ChatRoot` so a Svelte render error doesn't kill the view.

**PR 13 — `ui/11-turn-inspector`**
- Dev-mode-only command `cowork.open-turn-inspector`.
- Modal showing, per turn: user input, classifier verdict, tool calls in order with args and results, model raw output, final rendered answer, elapsed time per step.
- Readable JSON dump with copy-to-clipboard.

**PR 14 — `ui/12-status-bar-live`**
- Status bar reflects real state (indexing progress, thinking, ingesting, idle healthy, idle unhealthy) per `ui-surfaces.md` §Status bar precedence order.
- Click opens chat in its current default location.

**PR 15 — `ui/13-settings-complete`**
- Full settings tab per §Settings tab: Indexing (pause/resume, rebuild, last-indexed, excluded folders), Privacy (clear history / index / logs), Advanced (dev-mode toggle, golden-set runner entry point, eval metrics chart — the chart is allowed to be a placeholder until Person C's eval data lands).
- `.coworkignore` editor textarea with live validation.

**PR 16 — `ui/14-notices-and-undo`**
- Notices for saves include an Undo action that calls `vault.trash` on the just-written file.
- "Ingestion failed" notice includes a Details action that opens the turn inspector scrolled to the failed step.

**M3 exit criteria**:
- Killing Ollama mid-stream produces a clean error bubble and a Notice with a Start action, not a stack trace.
- Turn inspector shows a complete trace of every tool call for the last turn.
- Settings tab matches `ui-surfaces.md` 1:1.

### M4 — Demo polish (Week 4)

**PR 17 — `ui/15-a11y-pass`**
- ARIA roles and labels on every interactive element.
- Focus states visible; keyboard-only flow from composer through citations verified.
- Color contrast checked against default + Minimal + Things themes.

**PR 18 — `ui/16-demo-hardening`**
- Run through the 5 day-one acceptance tests from `overview.md`, fix anything flaky.
- `README.md` install & quickstart with screenshots.
- `styles.css` pass — spacing, density, dark mode verified.
- Tag `v0.1`.

## Dependencies on other tracks (and the fallbacks)

| Needs | From | Fallback until it ships |
|---|---|---|
| `OllamaLLMService` | Person A | `MockLLMService` with scripted replies — stays in repo as demo fallback. |
| Real `IndexService` (search, get, related) | Person C | `StubIndexService` backed by the demo vault's fixture results. |
| Demo vault content | Person C | Ship a 5-file handcrafted minivault under `demo-vault/` in the UI repo for local dev. |
| `chats.duckdb` schema | Person C (shared DB work) | JSON-file persistence behind the same interface; swap is internal. |

Every dependency has a fallback that is already checked in, so the UI track cannot be blocked by another track's delivery.

## Risks specific to the UI track

- **Svelte-in-ItemView lifecycle bugs.** Mounting and unmounting Svelte cleanly when Obsidian destroys a leaf is the most common source of memory leaks. Mitigation: one lifecycle helper (`mountSvelte(target, Component, props)`) used by every `ItemView` and `Modal`; Vitest DOM smoke test for mount/unmount symmetry.
- **Streaming + cancel races.** Aborting an in-flight `AsyncGenerator` while the UI is appending tokens must not leave the store in an inconsistent state. Mitigation: a single `turnId` per turn; any streamed token arriving after cancel is dropped by the store.
- **Preview gate bypass.** Any new tool added later must go through the dispatcher. Mitigation: `tool-dispatcher.ts` is the *only* caller of `VaultService` mutation methods, enforced by a lint rule (`no-restricted-imports` banning `VaultService` write methods outside the dispatcher file).
- **Wide-mode state leaks.** Dragging to a tab must not spawn a second chat. Mitigation: `ChatStore` on the plugin instance; `ChatView` subscribes but never owns state.

## Out of scope for the UI track in v1

Explicitly not in any PR above, tracked for v2:

- CodeMirror extensions or reading-view modifications.
- Custom file types or non-Markdown outputs.
- Canvas synthesis rendering.
- Graph view highlighting of cited notes.
- Mobile layout.
- i18n scaffolding.
