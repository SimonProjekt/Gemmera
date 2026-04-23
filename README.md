# Gemmera - Personal Knowledge Base

A local, privacy-first knowledge base that turns your documents into an
interconnected wiki using Gemma 4 and Obsidian.

Drop in raw files (journals, notes, articles), run `kb compile`, and get
an AI-compiled wiki with `[[wikilinks]]`, tags and summaries ready to
explore in Obsidian's graph view. Ask questions with `kb ask` and find
problems with `kb lint`. No data leaves your computer.

Inspired by [Andrej Karpathy's LLM Knowledge Base](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern.
Ships with a generated fictional persona ("Jonas Berg") as demo data
so everything works right after cloning.

## Commands

- `kb compile` — Builds the wiki from `raw/` with Gemma 4 locally
- `kb ask "your question"` — Answers with source citations from the wiki
- `kb lint` — Finds contradictions, orphan pages and broken links

## Stack

Python · Gemma 4 via Ollama · Obsidian · Markdown on disk

## Status

Under development — DD1349 VT26, KTH
