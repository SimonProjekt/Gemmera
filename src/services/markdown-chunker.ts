import { createHash } from "node:crypto";
import {
  CHARS_PER_TOKEN,
  CHUNK_CEILING_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TARGET_TOKENS,
  Chunk,
  Chunker,
  ChunkerInput,
} from "../contracts";
import type { HeadingRef } from "../contracts";

const OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN;

interface Section {
  headingPath: string[];
  text: string;
}

interface Block {
  type: "prose" | "code";
  text: string;
}

export class MarkdownChunker implements Chunker {
  chunk(input: ChunkerInput): Chunk[] {
    const { path, title, content, headings } = input;

    const { body, bodyOffset } = stripFrontmatter(content);
    if (body.trim().length === 0) return [];

    const sections = buildSections(body, bodyOffset, headings);

    const chunks: Chunk[] = [];
    let ord = 0;
    for (const section of sections) {
      for (const body of splitSection(section.text)) {
        chunks.push(makeChunk({
          path,
          ord: ord++,
          headingPath: [title, ...section.headingPath],
          text: body,
        }));
      }
    }
    return chunks;
  }
}

function stripFrontmatter(content: string): { body: string; bodyOffset: number } {
  if (!content.startsWith("---")) return { body: content, bodyOffset: 0 };
  // Match a closing fence on its own line.
  const match = /\n---[ \t]*(\r?\n|$)/.exec(content.slice(3));
  if (!match) return { body: content, bodyOffset: 0 };
  const end = 3 + match.index + match[0].length;
  return { body: content.slice(end), bodyOffset: end };
}

function buildSections(body: string, bodyOffset: number, headings: HeadingRef[]): Section[] {
  const inBody = headings
    .filter((h) => h.offset >= bodyOffset)
    .map((h) => ({ ...h, offset: h.offset - bodyOffset }))
    .sort((a, b) => a.offset - b.offset);

  if (inBody.length === 0) {
    const text = body.trim();
    return text ? [{ headingPath: [], text }] : [];
  }

  const sections: Section[] = [];

  const lead = body.slice(0, inBody[0].offset).trim();
  if (lead) sections.push({ headingPath: [], text: lead });

  const stack: { level: number; text: string }[] = [];
  for (let i = 0; i < inBody.length; i++) {
    const h = inBody[i];
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });

    const newline = body.indexOf("\n", h.offset);
    const start = newline === -1 ? body.length : newline + 1;
    const end = inBody[i + 1] ? inBody[i + 1].offset : body.length;
    const text = body.slice(start, end).trim();
    if (text) {
      sections.push({ headingPath: stack.map((s) => s.text), text });
    }
  }

  return sections;
}

function splitSection(text: string): string[] {
  if (estTokens(text) <= CHUNK_CEILING_TOKENS) return [text];

  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let buffer = "";

  for (const block of blocks) {
    // Oversize code fence: emit alone, no overlap.
    if (block.type === "code" && estTokens(block.text) > CHUNK_CEILING_TOKENS) {
      if (buffer.trim()) chunks.push(buffer.trim());
      buffer = "";
      chunks.push(block.text);
      continue;
    }

    const tentative = buffer ? `${buffer}\n\n${block.text}` : block.text;

    // Buffer would exceed target: flush, restart with overlap tail.
    if (buffer && estTokens(tentative) > CHUNK_TARGET_TOKENS) {
      chunks.push(buffer.trim());
      const tail = takeOverlapTail(buffer);
      buffer = tail ? `${tail}\n\n${block.text}` : block.text;
    } else {
      buffer = tentative;
    }
  }

  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

const FENCE_RE = /^```[\s\S]*?^```/gm;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      pushProse(blocks, text.slice(cursor, start));
    }
    blocks.push({ type: "code", text: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    pushProse(blocks, text.slice(cursor));
  }
  return blocks;
}

function pushProse(blocks: Block[], slab: string): void {
  for (const para of slab.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (trimmed) blocks.push({ type: "prose", text: trimmed });
  }
}

function takeOverlapTail(text: string): string {
  if (text.length <= OVERLAP_CHARS) return text;
  const slice = text.slice(text.length - OVERLAP_CHARS);
  // Prefer breaking on a paragraph boundary so the overlap is a clean unit.
  const para = slice.indexOf("\n\n");
  if (para !== -1 && para < slice.length / 2) return slice.slice(para + 2).trim();
  return slice.trim();
}

function estTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface MakeChunkOpts {
  path: string;
  ord: number;
  headingPath: string[];
  text: string;
}

function makeChunk(opts: MakeChunkOpts): Chunk {
  const headerLine = opts.headingPath.filter((h) => h.length > 0).join(" > ");
  const textForEmbed = headerLine ? `${headerLine}\n\n${opts.text}` : opts.text;
  return {
    path: opts.path,
    ord: opts.ord,
    headingPath: opts.headingPath,
    text: opts.text,
    textForEmbed,
    tokenCount: estTokens(opts.text),
    // Hash covers what gets embedded — body + heading prefix — so a heading
    // rename invalidates the cached vector even when the body is byte-identical.
    contentHash: sha256(textForEmbed),
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
