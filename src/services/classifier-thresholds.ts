/**
 * Confidence threshold gating — issue #77.
 *
 * Pure-function check against the asymmetric per-label thresholds
 * documented in planning/classifier.md §"Confidence thresholds".
 *
 * #77
 */

import {
  ClassifierThresholds,
  DEFAULT_CLASSIFIER_THRESHOLDS,
  IntentLabel,
} from "../contracts/classifier";

/**
 * Check whether a classifier output's confidence meets the threshold
 * for the given label.
 *
 * Returns `true` when confidence >= threshold.  Returns `false` for
 * unknown labels and for any confidence below the label's threshold.
 *
 * The caller uses `false` to trigger the disambiguation chip.
 */
export function isConfident(
  label: IntentLabel,
  confidence: number,
  thresholds: ClassifierThresholds = DEFAULT_CLASSIFIER_THRESHOLDS,
): boolean {
  const t = thresholds[label];
  if (t === undefined) return false;
  return confidence >= t;
}
