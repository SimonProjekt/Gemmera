import { describe, expect, it } from "vitest";
import { isAbortError, StreamingState } from "./streaming-state";

describe("StreamingState", () => {
  it("starts idle", () => {
    const s = new StreamingState();
    expect(s.isStreaming()).toBe(false);
  });

  it("begin() returns an AbortSignal and marks streaming", () => {
    const s = new StreamingState();
    const signal = s.begin();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(s.isStreaming()).toBe(true);
  });

  it("cancel() aborts the signal and returns true", () => {
    const s = new StreamingState();
    const signal = s.begin();
    expect(s.cancel()).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(s.isStreaming()).toBe(false);
  });

  it("cancel() on idle returns false and is a no-op", () => {
    const s = new StreamingState();
    expect(s.cancel()).toBe(false);
  });

  it("end() clears streaming without aborting the signal", () => {
    const s = new StreamingState();
    const signal = s.begin();
    s.end();
    expect(s.isStreaming()).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  it("begin() while already streaming aborts the previous controller", () => {
    const s = new StreamingState();
    const first = s.begin();
    const second = s.begin();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(s.isStreaming()).toBe(true);
  });

  it("subsequent cancel() after begin/cancel is a no-op", () => {
    const s = new StreamingState();
    s.begin();
    s.cancel();
    expect(s.cancel()).toBe(false);
  });
});

describe("isAbortError", () => {
  it("recognizes DOMException AbortError", () => {
    const err = new DOMException("Aborted", "AbortError");
    expect(isAbortError(err)).toBe(true);
  });

  it("recognizes an Error with name=AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("rejects non-AbortError errors", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(new TypeError("nope"))).toBe(false);
    expect(isAbortError("string")).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
