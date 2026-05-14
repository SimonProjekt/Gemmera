import { describe, expect, it } from "vitest";
import { isConfident } from "./classifier-thresholds";
import {
  ClassifierThresholds,
  DEFAULT_CLASSIFIER_THRESHOLDS,
} from "../contracts/classifier";

describe("isConfident", () => {
  // ─── Default thresholds ───────────────────────────────────────────────

  it("capture threshold 0.85: confident at exactly 0.85", () => {
    expect(isConfident("capture", 0.85)).toBe(true);
  });

  it("capture threshold 0.85: not confident below", () => {
    expect(isConfident("capture", 0.849)).toBe(false);
  });

  it("capture threshold 0.85: confident above", () => {
    expect(isConfident("capture", 0.86)).toBe(true);
  });

  it("ask threshold 0.70: confident at exactly 0.70", () => {
    expect(isConfident("ask", 0.70)).toBe(true);
  });

  it("ask threshold 0.70: not confident below", () => {
    expect(isConfident("ask", 0.699)).toBe(false);
  });

  it("mixed threshold 0.75: confident at exactly 0.75", () => {
    expect(isConfident("mixed", 0.75)).toBe(true);
  });

  it("mixed threshold 0.75: not confident below", () => {
    expect(isConfident("mixed", 0.749)).toBe(false);
  });

  it("meta threshold 0.70: confident at exactly 0.70", () => {
    expect(isConfident("meta", 0.70)).toBe(true);
  });

  it("meta threshold 0.70: not confident below", () => {
    expect(isConfident("meta", 0.699)).toBe(false);
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  it("returns false for confidence 0", () => {
    expect(isConfident("ask", 0)).toBe(false);
  });

  it("returns true for confidence 1.0 on any label", () => {
    expect(isConfident("capture", 1.0)).toBe(true);
    expect(isConfident("ask", 1.0)).toBe(true);
    expect(isConfident("mixed", 1.0)).toBe(true);
    expect(isConfident("meta", 1.0)).toBe(true);
  });

  // ─── Asymmetric thresholds: capture requires higher confidence ─────────

  it("capture is stricter than ask (0.85 > 0.70)", () => {
    // 0.72: passes ask threshold but fails capture
    expect(isConfident("ask", 0.72)).toBe(true);
    expect(isConfident("capture", 0.72)).toBe(false);
  });

  // ─── Custom thresholds ────────────────────────────────────────────────

  it("accepts custom thresholds", () => {
    const custom: ClassifierThresholds = {
      capture: 0.5,
      ask: 0.5,
      mixed: 0.5,
      meta: 0.5,
    };
    expect(isConfident("capture", 0.5, custom)).toBe(true);
    expect(isConfident("capture", 0.49, custom)).toBe(false);
  });

  // ─── Unknown label ────────────────────────────────────────────────────

  it("returns false for an unknown label", () => {
    expect(isConfident("unknown" as any, 0.9)).toBe(false);
  });

  // ─── Default thresholds are the documented anchor values ──────────────

  it("DEFAULT_CLASSIFIER_THRESHOLDS match the documented anchors", () => {
    expect(DEFAULT_CLASSIFIER_THRESHOLDS).toEqual({
      capture: 0.85,
      ask: 0.70,
      mixed: 0.75,
      meta: 0.70,
    });
  });
});
