import { describe, expect, it } from "vitest";
import type { NoteSpec } from "../contracts/ingest";
import type { NotePreviewResult } from "./note-preview-modal";
import { reduceSplitOutcomes, type OneOutcome } from "./split-preview";

function spec(overrides: Partial<NoteSpec> = {}): NoteSpec {
  return {
    title: "Topic A",
    type: "source",
    tags: ["t1"],
    aliases: [],
    source: "chat-paste",
    entities: [],
    related: [],
    status: "inbox",
    summary: "Notes about Topic A.",
    key_points: [],
    body_markdown: "## Topic A\n\nbody",
    cowork: {
      source: "ingest",
      run_id: "run-1",
      model: "test-model",
      version: "0.0.1",
      confidence: "high",
    },
    ...overrides,
  };
}

function result(overrides: Partial<NotePreviewResult> = {}): NotePreviewResult {
  return {
    confirmed: true,
    title: "Edited title",
    folder: "Inbox/",
    type: "source",
    status: "inbox",
    tags: ["edited"],
    aliases: [],
    summary: "Edited summary.",
    ...overrides,
  };
}

const saved = (r?: Partial<NotePreviewResult>): OneOutcome => ({ kind: "saved", result: result(r) });
const skipped: OneOutcome = { kind: "skipped" };
const cancelled: OneOutcome = { kind: "cancelled" };

describe("reduceSplitOutcomes — split-mode acceptance (#160)", () => {
  it("returns split_confirm with every candidate when each is saved", () => {
    const candidates = [spec({ title: "A" }), spec({ title: "B" }), spec({ title: "C" })];
    const out = reduceSplitOutcomes(candidates, [
      saved({ title: "A!" }),
      saved({ title: "B!" }),
      saved({ title: "C!" }),
    ]);
    expect(out.action).toBe("split_confirm");
    if (out.action !== "split_confirm") return;
    expect(out.confirmed.map((c) => c.title)).toEqual(["A!", "B!", "C!"]);
  });

  it("preserves order by candidate index", () => {
    const candidates = [spec({ title: "first" }), spec({ title: "second" }), spec({ title: "third" })];
    const out = reduceSplitOutcomes(candidates, [
      saved({ title: "1" }),
      skipped,
      saved({ title: "3" }),
    ]);
    if (out.action !== "split_confirm") throw new Error("expected split_confirm");
    expect(out.confirmed.map((c) => c.title)).toEqual(["1", "3"]);
  });

  it("skip preserves siblings — skipping one does not cancel the rest", () => {
    const candidates = [spec({ title: "A" }), spec({ title: "B" })];
    const out = reduceSplitOutcomes(candidates, [skipped, saved({ title: "B!" })]);
    if (out.action !== "split_confirm") throw new Error("expected split_confirm");
    expect(out.confirmed).toHaveLength(1);
    expect(out.confirmed[0].title).toBe("B!");
  });

  it("cancel-all ships whatever was already confirmed", () => {
    const candidates = [spec({ title: "A" }), spec({ title: "B" }), spec({ title: "C" })];
    const out = reduceSplitOutcomes(candidates, [saved({ title: "kept" }), cancelled]);
    if (out.action !== "split_confirm") throw new Error("expected split_confirm");
    expect(out.confirmed).toHaveLength(1);
    expect(out.confirmed[0].title).toBe("kept");
  });

  it("collapses to plain cancel when nothing was confirmed before cancel-all", () => {
    const candidates = [spec({ title: "A" }), spec({ title: "B" })];
    const out = reduceSplitOutcomes(candidates, [skipped, cancelled]);
    expect(out.action).toBe("cancel");
  });

  it("collapses to plain cancel when every candidate is skipped (no writes)", () => {
    const candidates = [spec({ title: "A" }), spec({ title: "B" })];
    const out = reduceSplitOutcomes(candidates, [skipped, skipped]);
    expect(out.action).toBe("cancel");
  });

  it("carries non-edited NoteSpec fields through unchanged (body, source, cowork)", () => {
    const candidates = [
      spec({ title: "orig", body_markdown: "## orig body", source: "chat-paste" }),
    ];
    const out = reduceSplitOutcomes(candidates, [saved({ title: "renamed" })]);
    if (out.action !== "split_confirm") throw new Error("expected split_confirm");
    const c = out.confirmed[0];
    expect(c.title).toBe("renamed");
    expect(c.body_markdown).toBe("## orig body");
    expect(c.source).toBe("chat-paste");
    expect(c.cowork.run_id).toBe("run-1");
  });
});
