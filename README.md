# Gemmera

**DD1349 VT26 — Projektuppgift i introduktion till datalogi**

An Obsidian plugin that turns your vault into a local, private knowledge base powered by Google's Gemma model via Ollama. Chat with Gemma directly in Obsidian — it reads your notes, creates new ones, and answers questions with citations. Everything stays on your machine.

## Quick start

### Prerequisites

- [Obsidian](https://obsidian.md) ≥ 1.4
- [Ollama](https://ollama.ai) installed and running
- Node.js 18+ and npm (to build from source)
- ~8 GB RAM recommended

### Install from release (easiest)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. Create `<your-vault>/.obsidian/plugins/gemmera/` and copy the three files there.
3. In Obsidian: **Settings → Community plugins → Enable Gemmera**.

### Build from source

```bash
git clone https://github.com/SimonProjekt/Gemmera.git
cd Gemmera
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to `<your-vault>/.obsidian/plugins/gemmera/`.

### Pull the required models

```bash
ollama pull gemma3           # chat model (~5 GB)
ollama pull bge-m3           # embedding model (~1.2 GB)
```

### First run

On first activation Gemmera indexes your vault in the background — chunking and embedding every note. The chat panel is usable immediately; retrieval improves as indexing completes (~10–30 min for a 5 000-note vault on CPU).

Open the chat panel via the ribbon icon or from the Obsidian command palette.

## What it does

| Feature | Description |
|---|---|
| **Chat** | Ask questions about your vault; answers include clickable citation chips linking to the source notes |
| **Capture** | Paste or type raw content; Gemmera structures it into a new note with frontmatter, tags, and wikilinks |
| **Dedup detection** | Dropping content similar to an existing note shows an "append or save as new" prompt instead of creating a duplicate |
| **Hybrid retrieval** | Combines semantic (BGE-M3 embeddings), BM25, and wikilink-graph signals for recall |
| **Local only** | No cloud API calls; no data leaves your machine |

## Demo vault

The `demo-vault/` folder contains a fictional persona (Jonas Berg — Swedish diaries, letters, and book reviews) so everything works out of the box after install.

## Security principles

- Preview-before-write is on by default for all file changes.
- Deleting a note requires explicit confirmation — the dialog cannot be bypassed.
- Ollama runs locally; there is no cloud-API fallback.
- MIT license.

## Development

```bash
npm test          # run all unit tests (vitest)
npm run dev       # watch build for Obsidian hot-reload
npm run build     # production build → main.js
```

Tests cover the full tool-loop state machines, retry policy, classifier, chunker, embedding pipeline, and UI components. As of the v0.1.1 hardening audit, the suite contains 711 tests across 63 files.

## Project Timeline — 4 Weeks

### Week 1 ✅
- Plugin skeleton, Ollama integration, chat panel with conversation history, Jonas Berg demo persona

### Week 2 ✅
- File creation and update tools, preview dialog, vault search with citations

### Week 3 ✅
- Incremental indexing: Markdown chunker, hash-gated pipeline, BGE-M3 embedder, BM25, reconciliation

### Week 4 ✅
- Retry policy, Ollama lifecycle, responsive UI, citation chips, v0.1 release

## Team

Course team project. Person A focuses on Ollama integration, LLM prompting, tool calls, and the retrieval pipeline. Person B focuses on Obsidian plugin UI, the chat panel, preview modals, and component testing. The team plans together every week and rotates the reviewer role.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.
