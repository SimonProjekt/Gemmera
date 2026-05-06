import type { RouteDecision } from "./contracts/classifier";

export interface MessageDecoration {
  /** Inline label shown on the message in dev mode. Null when silent. */
  badge: string | null;
  /** Tooltip text on the badge. Null when no badge. */
  tooltip: string | null;
  /** True when the classifier silently routed to capture without user confirmation. */
  silentSave: boolean;
}

/**
 * Derive the message decoration for a single turn. Pure — no side effects.
 *
 * Silent mode (devMode=false): only silentSave is ever set.
 * Dev mode: badge and tooltip are populated from the decision.
 */
export function buildMessageDecoration(
  route: RouteDecision | null,
  devMode: boolean,
  alwaysPreviewBeforeSave: boolean,
): MessageDecoration {
  if (!route || !route.label) {
    return { badge: null, tooltip: null, silentSave: false };
  }

  // Silent saves: confident capture when the user hasn't opted into preview.
  const silentSave =
    route.label === "capture" &&
    !alwaysPreviewBeforeSave &&
    !route.needsDisambiguation;

  if (!devMode) {
    return { badge: null, tooltip: null, silentSave };
  }

  // Dev mode: show label + source annotation on every message.
  const { label, decision } = route;

  if (decision.source === "skip" && decision.skipReason) {
    return { badge: `${label} · skip`, tooltip: decision.skipReason, silentSave };
  }

  const confidence = decision.output?.confidence;
  const rationale = decision.output?.rationale || null;

  const badge =
    confidence !== undefined
      ? `${label} · ${confidence.toFixed(2)}`
      : `${label} · fallback`;

  return { badge, tooltip: rationale, silentSave };
}
