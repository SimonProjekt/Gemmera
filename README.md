# Gemmera — Local AI Knowledge Base for Obsidian

An Obsidian plugin that turns your vault into a local, private knowledge base powered by Google's Gemma model. Chat with Gemma directly inside Obsidian, and the model creates and updates interlinked wiki pages with `[[wikilinks]]` on your behalf — all without any data leaving your machine.

## Features

- **Chat interface** — talk to Gemma in a sidebar panel inside Obsidian.
- **File creation from chat** — Gemma can create new Markdown files with `[[wikilinks]]` based on the conversation (e.g., "make a note about what we just discussed").
- **Updating existing pages** — Gemma can read and append content to existing files, with a preview before changes are written.
- **Vault search** — Gemma can look up content across your vault's files and answer with source citations.
- **Intent classification** — an auto-classifier routes each turn between capture (save a note) and ask (query the vault).
- **Hybrid retrieval** — semantic (vector) + lexical (BM25) + link-graph signals fused via reciprocal rank fusion.
- **Streaming responses** — token-by-token output with a Stop button for immediate cancellation.
- **Chat history** — persistent sessions with inline rename, retention controls, and pop-out window support.
- **Pre-save commit gate** — a modal lets you edit title, type, status, tags, and aliases before a new note is written, validated against the frontmatter schema.

The "Jonas Berg" persona (diaries, letters, and book reviews in Swedish) ships as a demo vault so everything works right after installation.

## Installation

- **Clone the repo** — `git clone` the Gemmera repo to any location.
- **Install dependencies** — `npm install` in the project directory.
- **Build the plugin** — `npm run build` to generate `main.js`.
- **Copy to your vault** — place `main.js`, `manifest.json`, and `styles.css` in `<vault>/.obsidian/plugins/gemmera/`.
- **Pull models via Ollama** — `ollama pull gemma4` for chat and `ollama pull bge-m3` for indexing.
- **Enable** — turn on Gemmera under Obsidian Settings → Community plugins.

On first activation the plugin builds a local index over your vault (chunks + embeddings) in `<vault>/.coworkmd/`. For a vault of ~5,000 notes this takes 10–30 minutes on CPU; chat is usable immediately and retrieval improves as indexing progresses.

## Dependencies

- **Obsidian** (≥ 1.5)
- **Node.js** and **npm** — for building.
- **Ollama** — installed locally (the plugin detects a running instance or spawns one automatically).
- **Gemma 4** — pulled via Ollama (size depends on your hardware).
- **BGE-M3** — embeddings model for indexing (`ollama pull bge-m3`, ~1.2 GB).
- **Recommended:** ~8 GB RAM for smaller models, more for larger variants.

## Security Principles

- Preview-before-write is the default for all file changes.
- Append-only updates to existing pages.
- Deletion requires explicit confirmation in the UI.
- Runs locally via Ollama. No cloud API fallback.
- MIT license.

## Technical Stack

TypeScript, Obsidian Plugin API, Gemma 4 via Ollama (local), Markdown with Obsidian-compatible wikilinks.

## Development

```bash
npm test          # run unit tests (621 tests across 57 files)
npm run build     # production bundle
npm run typecheck # TypeScript type check (tsc --noEmit)
```

## Project Status

Core MVP is complete: chat with streaming, intent classification, hybrid retrieval, note CRUD with preview gate, chat history with retention, and incremental indexing. See open issues for remaining work.

See [planning/overview.md](planning/overview.md) for the full architecture document.
