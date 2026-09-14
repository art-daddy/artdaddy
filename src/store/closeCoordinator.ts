// The retryable close/switch coordinator (Step 2). Switching projects or closing the app CLOSES the
// current project FIRST (other NLEs save-before-close); on a failed final save it STAYS on the current
// project and surfaces Retry / Discard / Cancel. Route-driven switches funnel through useProjectSwitch
// so a failed close can VETO the navigation (guardrail 4).
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { create } from "zustand";

import { projectDocuments } from "../project/documentRegistry";
import { asProjectId } from "../project/types";

/** A close that FAILED its final save — the document is retained (live, editable). `target` is where
 *  to go once it closes cleanly (a project id, or null for "no project"); `exit` closes the OS window
 *  instead (app quit).
 *
 *  `kind` says whether the close has already RUN. "failed" = the save ran and failed, so the document
 *  is mid-close and Cancel must re-admit it. "unsaved" = we have not started closing yet and are
 *  asking first, so Cancel must NOT call cancelClose — there is nothing to un-quiesce. */
export interface PendingClose {
  failedId: string;
  target: string | null;
  exit?: boolean;
  kind?: "failed" | "unsaved";
}

interface CloseCoordState {
  /** Non-null while a close failed and the Retry/Discard/Cancel modal is up. */
  pending: PendingClose | null;
  /** A retry/discard is in flight (disables the modal actions). */
  busy: boolean;
  setPending: (p: PendingClose) => void;
  clearPending: () => void;
  setBusy: (b: boolean) => void;
  /** The desktop shell registers how to actually close the OS window once the guard clears
   *  (guardrail 5 re-entry). Null on web. */
  exitHandler: (() => void) | null;
  setExitHandler: (fn: (() => void) | null) => void;
}

export const useCloseCoordinator = create<CloseCoordState>((set) => ({
  pending: null,
  busy: false,
  setPending: (pending) => set({ pending }),
  clearPending: () => set({ pending: null, busy: false }),
  setBusy: (busy) => set({ busy }),
  exitHandler: null,
  setExitHandler: (exitHandler) => set({ exitHandler }),
}));

/** Route path for a switch target (a project id, or null = the no-project home). */
export function projectPath(target: string | null): string {
  return target ? `/p/${encodeURIComponent(target)}` : "/";
}

/** Controlled project switch: close the CURRENT project first and navigate ONLY on a clean close.
 *  A failed final save STAYS on the current project (no navigation) and raises the Retry/Discard/Cancel
 *  modal. Every project-switch UI funnels through this so the close outcome can veto the switch. */
export function useProjectSwitch(): (target: string | null) => Promise<void> {
  const nav = useNavigate();
  const loc = useLocation();
  return useCallback(
    async (target: string | null) => {
      const currentId = loc.pathname.startsWith("/p/")
        ? decodeURIComponent(loc.pathname.slice(3))
        : null;
      if (!currentId || currentId === target) {
        nav(projectPath(target)); // nothing to close, or a no-op re-select
        return;
      }
      const outcome = await projectDocuments.close(asProjectId(currentId));
      if (outcome.ok) nav(projectPath(target));
      else useCloseCoordinator.getState().setPending({ failedId: currentId, target });
    },
    [nav, loc.pathname],
  );
}
