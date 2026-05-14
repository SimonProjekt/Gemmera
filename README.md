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
ollama pull bge-reranker-v2-m3   # reranker (~600 MB)
```

### First run

On first activation Gemmera indexes your vault in the background — chunking and embedding every note. The chat panel is usable immediately; retrieval improves as indexing completes (~10–30 min for a 5 000-note vault on CPU).

Open the chat panel via the ribbon icon or **Ctrl+P → Gemmera: Öppna chatt**.

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

Tests cover the full tool-loop state machines, retry policy, classifier, chunker, embedding pipeline, and UI components — 641 tests across 58 files.

## Tidsplan — 4 veckor

### Vecka 1 ✅
- Plugin-skelett, Ollama-integration, chat-panel med konversationshistorik, Jonas Berg persona

### Vecka 2 ✅
- Verktyg för filskapande och uppdatering, preview-dialog, vault-sökning med citat

### Vecka 3 ✅
- Inkrementell indexering: markdown-chunker, hash-grindad pipeline, BGE-M3 embedder, BM25, reranker, rekonciliering

### Vecka 4 ✅
- Retry policy, Ollama lifecycle, responsive UI, citation chips, v0.1 release

## Team

Par-projekt. Person A: Ollama-integration, LLM-prompting, verktygsanrop, retrieval-pipeline. Person B: Obsidian-plugin-UI, chat-panel, preview-modal, komponenttestning. Båda deltar i planering varje vecka; review-rollen roterar.

Se [CONTRIBUTING.md](CONTRIBUTING.md) för hur man bidrar.
