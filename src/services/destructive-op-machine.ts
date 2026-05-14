import type { EventLog, EventLogEntry, JobQueue, VaultService } from "../contracts";
import type { TurnStatusCallback } from "./turn-status";
import { labelForState } from "./turn-status";

// ── Op types ──────────────────────────────────────────────────────────────────

export type DestructiveOp =
  | { kind: "delete"; path: string }
  | { kind: "rename"; from: string; to: string; affectedLinkCount: number };

export type ConfirmDecision = "confirmed" | "cancelled";

/**
 * Called when Gemma invokes `delete_note`. The handler MUST show an explicit
 * confirmation modal. It is called unconditionally — no setting, flag, or
 * caller option can bypass it. Non-overridable by design.
 *
 * `contentPreview` is the first 800 characters of the file, included so the
 * modal can show the user what they are about to delete.
 */
export type DeleteConfirmHandler = (
  path: string,
  contentPreview: string,
) => Promise<ConfirmDecision>;

/**
 * Called when Gemma invokes `rename_or_move_note`. The operation is safe and
 * reversible (Obsidian maintains link integrity), so the caller may auto-confirm
 * when the user has disabled "Always preview."
 */
export type RenameConfirmHandler = (
  from: string,
  to: string,
  affectedLinkCount: number,
) => Promise<ConfirmDecision>;

export type DestructiveOutcome =
  | { kind: "done"; op: DestructiveOp }
  | { kind: "cancelled" };

export interface DestructiveOpDeps {
  vault: VaultService;
  jobQueue: JobQueue;
  /**
   * Always called for `delete_note` — non-overridable regardless of any
   * settings. The handler is responsible for showing the mandatory modal.
   */
  confirmDelete: DeleteConfirmHandler;
  /**
   * Called for `rename_or_move_note`. May auto-confirm when the caller opts
   * out of always-preview, since rename is safe and reversible.
   */
  confirmRename: RenameConfirmHandler;
  eventLog?: EventLog;
  turnId?: string;
  /** Called synchronously on each state entry so the UI can update its status chip. */
  onStateChange?: TurnStatusCallback;
}

// ── State names ───────────────────────────────────────────────────────────────

const STATES = {
  confirm: "CONFIRM",
  execute: "EXECUTE",
  updateIndex: "UPDATE_INDEX",
  done: "DONE",
  cancelled: "CANCELLED",
  failed: "TOOL_FAILED",
} as const;

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Drives the destructive-op mini state machine (#44):
 *   TOOL_CALL → CONFIRM → EXECUTE → UPDATE_INDEX → DONE
 *                       ↘ CANCELLED (user declined)
 *
 * Delete always requires an explicit confirmation modal — non-overridable.
 * Rename uses a standard preview gate that the caller may auto-confirm.
 */
export async function runDestructiveOp(
  op: DestructiveOp,
  deps: DestructiveOpDeps,
): Promise<DestructiveOutcome> {
  const turnId = deps.turnId ?? crypto.randomUUID();
  let prevState = "TOOL_CALL";

  const enter = async (state: string, payload?: Record<string, unknown>) => {
    deps.onStateChange?.(state, labelForState(state));
    if (!deps.eventLog) return;
    const entry: EventLogEntry = {
      turnId,
      kind: "enter",
      state,
      fromState: prevState,
      timestamp: Date.now(),
      triggeringEvent: payload
        ? { kind: "tool_result", name: state, payload }
        : null,
    };
    await deps.eventLog.write(entry);
    prevState = state;
  };

  // ── CONFIRM ───────────────────────────────────────────────────────────────
  await enter(STATES.confirm, { op: op.kind });

  let decision: ConfirmDecision;
  if (op.kind === "delete") {
    let contentPreview = "";
    try {
      const full = await deps.vault.read(op.path);
      contentPreview = full.slice(0, 800);
    } catch {
      contentPreview = "(could not read file)";
    }
    // confirmDelete is ALWAYS called — the handler owns the non-overridable modal.
    decision = await deps.confirmDelete(op.path, contentPreview);
  } else {
    decision = await deps.confirmRename(op.from, op.to, op.affectedLinkCount);
  }

  if (decision === "cancelled") {
    await enter(STATES.cancelled, { from: "confirm" });
    return { kind: "cancelled" };
  }

  // ── EXECUTE ───────────────────────────────────────────────────────────────
  await enter(STATES.execute, { op: op.kind });
  try {
    if (op.kind === "delete") {
      await deps.vault.trash(op.path);
    } else {
      await deps.vault.rename(op.from, op.to);
    }
  } catch (err) {
    await enter(STATES.failed, { reason: stringifyError(err) });
    throw err;
  }

  // ── UPDATE_INDEX ──────────────────────────────────────────────────────────
  if (op.kind === "delete") {
    deps.jobQueue.enqueue({ kind: "delete", path: op.path });
  } else {
    deps.jobQueue.enqueue({ kind: "rename", from: op.from, to: op.to });
  }
  await enter(STATES.updateIndex, { op: op.kind });

  // ── DONE ──────────────────────────────────────────────────────────────────
  await enter(STATES.done, { op: op.kind });
  return { kind: "done", op };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
