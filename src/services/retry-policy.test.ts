import { describe, expect, it, vi } from "vitest";
import {
  RetryBudget,
  withFeedbackRetry,
  withInfraRetry,
  withJsonRetry,
} from "./retry-policy";
import { HARD_STOPS } from "../contracts";

// ── RetryBudget ───────────────────────────────────────────────────────────────

describe("RetryBudget", () => {
  it("allows retries up to MAX_RETRIES_PER_TURN", () => {
    const budget = new RetryBudget();
    for (let i = 0; i < HARD_STOPS.MAX_RETRIES_PER_TURN; i++) {
      expect(budget.canRetry()).toBe(true);
      expect(budget.consume()).toBe(true);
    }
    expect(budget.canRetry()).toBe(false);
    expect(budget.consume()).toBe(false);
  });

  it("tracks the count of consumed slots", () => {
    const budget = new RetryBudget();
    expect(budget.count).toBe(0);
    budget.consume();
    expect(budget.count).toBe(1);
    budget.consume();
    expect(budget.count).toBe(2);
  });

  it("supports a custom max", () => {
    const budget = new RetryBudget(1);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
  });
});

// ── withJsonRetry ─────────────────────────────────────────────────────────────

describe("withJsonRetry — model-output validity (invalid JSON)", () => {
  it("returns parsed value on first-call success", async () => {
    const fn = vi.fn().mockResolvedValue('{"ok":true}');
    const result = await withJsonRetry(fn, JSON.parse, new RetryBudget());
    expect(result).toEqual({ ok: true, value: { ok: true } });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries once on invalid JSON and succeeds", async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce('{"answer":42}');
    const budget = new RetryBudget();
    const result = await withJsonRetry(fn, JSON.parse, budget);
    expect(result).toEqual({ ok: true, value: { answer: 42 } });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(budget.count).toBe(1);
  });

  it("returns invalid_json when both calls fail", async () => {
    const fn = vi.fn().mockResolvedValue("still not json");
    const result = await withJsonRetry(fn, JSON.parse, new RetryBudget());
    expect(result).toEqual({ ok: false, reason: "invalid_json" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("returns budget_exhausted without retrying when budget is already empty", async () => {
    const fn = vi.fn().mockResolvedValue("not json");
    const budget = new RetryBudget(0);
    const result = await withJsonRetry(fn, JSON.parse, budget);
    expect(result).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("budget carries across multiple withJsonRetry calls within a turn", async () => {
    const budget = new RetryBudget(1);
    // First call uses the one retry slot.
    const fn1 = vi.fn()
      .mockResolvedValueOnce("bad")
      .mockResolvedValueOnce('{"x":1}');
    await withJsonRetry(fn1, JSON.parse, budget);
    expect(budget.count).toBe(1);

    // Second call: budget exhausted, should not retry.
    const fn2 = vi.fn().mockResolvedValue("bad");
    const result = await withJsonRetry(fn2, JSON.parse, budget);
    expect(result).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("uses a custom parse function — returns null to signal failure", async () => {
    const strictParse = (raw: string): number | null => {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const fn = vi.fn()
      .mockResolvedValueOnce("not a number")
      .mockResolvedValueOnce("42");
    const result = await withJsonRetry(fn, strictParse, new RetryBudget());
    expect(result).toEqual({ ok: true, value: 42 });
  });
});

// ── withFeedbackRetry ─────────────────────────────────────────────────────────

describe("withFeedbackRetry — schema-valid-but-rule-violating output", () => {
  it("returns value on first-call success (no validation error)", async () => {
    const fn = vi.fn().mockResolvedValue("good");
    const validate = () => null; // always valid
    const retryFn = vi.fn();
    const result = await withFeedbackRetry(fn, validate, retryFn, new RetryBudget());
    expect(result).toEqual({ ok: true, value: "good" });
    expect(retryFn).not.toHaveBeenCalled();
  });

  it("retries with error feedback and succeeds on second call", async () => {
    const fn = vi.fn().mockResolvedValue("invalid");
    const validate = (v: string) => (v === "invalid" ? "value must not be 'invalid'" : null);
    const retryFn = vi.fn().mockResolvedValue("valid");
    const budget = new RetryBudget();
    const result = await withFeedbackRetry(fn, validate, retryFn, budget);
    expect(result).toEqual({ ok: true, value: "valid" });
    expect(retryFn).toHaveBeenCalledWith("value must not be 'invalid'", undefined);
    expect(budget.count).toBe(1);
  });

  it("returns validation_failed when both calls are invalid", async () => {
    const fn = vi.fn().mockResolvedValue("bad");
    const validate = () => "still bad";
    const retryFn = vi.fn().mockResolvedValue("still bad");
    const result = await withFeedbackRetry(fn, validate, retryFn, new RetryBudget());
    expect(result).toEqual({ ok: false, reason: "validation_failed", value: "still bad" });
  });

  it("returns budget_exhausted when budget is empty before first retry", async () => {
    const fn = vi.fn().mockResolvedValue("bad");
    const validate = () => "error";
    const retryFn = vi.fn();
    const budget = new RetryBudget(0);
    const result = await withFeedbackRetry(fn, validate, retryFn, budget);
    expect(result).toEqual({ ok: false, reason: "budget_exhausted", value: "bad" });
    expect(retryFn).not.toHaveBeenCalled();
  });

  it("passes signal to both fn and retryFn", async () => {
    const signal = AbortSignal.timeout(5000);
    const fn = vi.fn().mockResolvedValue("bad");
    const validate = () => "error";
    const retryFn = vi.fn().mockResolvedValue("good");
    await withFeedbackRetry(fn, validate, retryFn, new RetryBudget(), signal);
    expect(fn).toHaveBeenCalledWith(signal);
    expect(retryFn).toHaveBeenCalledWith("error", signal);
  });
});

// ── withInfraRetry ────────────────────────────────────────────────────────────

describe("withInfraRetry — transient infrastructure failures", () => {
  const noSleep = () => Promise.resolve();

  it("returns result on first-call success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withInfraRetry(fn, 500, undefined, noSleep);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries once after delay and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce("recovered");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withInfraRetry(fn, 500, undefined, sleep);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("throws on second failure (caller decides: Notice or re-queue)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Ollama not running"));
    await expect(withInfraRetry(fn, 500, undefined, noSleep)).rejects.toThrow(
      "Ollama not running",
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects delayMs: 250 for embedder, 500 for Ollama", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    await withInfraRetry(fn, 250, undefined, sleep);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("does NOT consume from RetryBudget (infra retries are transport-level)", async () => {
    const budget = new RetryBudget();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce("ok");
    await withInfraRetry(fn, 500, undefined, noSleep);
    // Budget should be untouched.
    expect(budget.count).toBe(0);
    expect(budget.canRetry()).toBe(true);
  });
});
