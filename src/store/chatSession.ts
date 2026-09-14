// Client-owned SessionState derivation. The stateless server persists no session,
// so the client owns the running cost/tokens + undo/redo flags for display and
// reopen. Pure functions over the turns list.
import type { ApprovalMode, SessionState } from "../api/types";
import type { Turn } from "./chatTranscript";

/** Client-owned undo/redo availability, derived from the turns. */
export function undoFlags(turns: Turn[]): { can_undo: boolean; can_redo: boolean } {
  return {
    can_undo: turns.some((t) => !t.undone),
    can_redo: turns.length > 0 && Boolean(turns[turns.length - 1].undone),
  };
}

/** Build a client-side SessionState: cost/tokens carry from the last server turn
 *  (or 0), undo/redo derive from the turns. */
export function localSession(
  turns: Turn[],
  mode: ApprovalMode,
  base?: SessionState | null,
): SessionState {
  return {
    cost_usd: base?.cost_usd ?? 0,
    input_tokens: base?.input_tokens ?? 0,
    context_tokens: base?.context_tokens ?? 0,
    output_tokens: base?.output_tokens ?? 0,
    reasoning_tokens: base?.reasoning_tokens ?? 0,
    approval_mode: base?.approval_mode ?? mode,
    finished: base?.finished ?? true,
    pending: base?.pending ?? false,
    final_mp4: base?.final_mp4,
    ...undoFlags(turns),
  };
}
