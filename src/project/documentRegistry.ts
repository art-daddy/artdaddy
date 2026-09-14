// The app's single ProjectDocument registry + the wiring of a project's real children
// (editor + chat stores + tool host) into the document lifecycle. This is the composition
// layer, so — unlike the pure ProjectDocument/Registry/types — it may import the stores.
import {
  activateChatProject,
  deactivateChatProject,
  isChatExecutionCurrent,
  quiesceChatProject,
  resumeChatProject,
  saveProjectSessionNow,
  whenChatQuiescent,
} from "../store/chat";
import { activateEditorProject, deactivateEditorProject, useEditor } from "../store/editor";
import { flushPendingSession } from "../store/transcriptFile";
import { rearmTimelinePersist } from "../timeline/engine";
import { closeToolHost, openToolHost } from "../tools/host";
import { sweepArtifactCache, sweepOwnedMedia } from "../tools/mediaGc";
import { storeForProject } from "../lib/desktop";
import { projectDirFor } from "../tools/dataRoot";
import { captureError } from "../observability/sentry";
import { claimProjectLock, foreignProjectLock, releaseProjectLock } from "../tools/projectLock";
import { cancelWriteRecovery } from "../timeline/engine";
import { useProjectNotice } from "../store/projectNotice";
import type { ProjectChildren } from "./ProjectDocument";
import { ProjectDocumentRegistry } from "./ProjectDocumentRegistry";
import { setOpenDocumentResolver } from "./openDocuments";
import type { ProjectId } from "./types";

/** Warn when another machine already has this project open, then claim it. Best-effort and
 *  never blocks the open: a project on a shared drive is the only way this fires, and the
 *  answer to a stale lock has to be "you can still work". */
async function noteAndClaimProjectLock(id: ProjectId): Promise<void> {
  try {
    const store = await storeForProject(id);
    if (!store) return;
    const fs = store.fsForProjectRegistry();
    const held = await foreignProjectLock(fs, store.projectDir);
    if (held)
      useProjectNotice
        .getState()
        .notify(
          "This project is already open somewhere else. Editing it in both places will overwrite one of them.",
        );
    await claimProjectLock(fs, store.projectDir);
  } catch (e) {
    captureError(e, { scope: "project.open.lock" });
  }
}

/** Wire a project's real children into one document open/close. Editor + chat load in
 *  parallel; only the editor outcome gates "loaded"/"failed" (the workspace reveal depends
 *  on the editor), and a chat load failure is tolerated — matching the prior Shell logic.
 *  Exported for a focused wiring test. */
export function makeProjectChildren(id: ProjectId): ProjectChildren {
  return {
    open: async () => {
      const [, editorResult] = await Promise.allSettled([
        activateChatProject(id),
        activateEditorProject(id),
      ]);
      const outcome = editorResult.status === "fulfilled" ? editorResult.value : "failed";
      if (outcome !== "loaded") return "failed";
      // Claim the project AFTER a successful load, so a refused open leaves no lock behind.
      void noteAndClaimProjectLock(id);
      // Warm the WS-free tool host so local tools can run (fire-and-forget, as before).
      openToolHost(id).ready.catch(() => undefined);
      return "loaded";
    },
    saveTranscript: async () => {
      // Persist the LATEST transcript for the close SAVE phase, reporting success so a write failure
      // triggers Retry/Discard/Cancel. Finding #2: producers were already fenced + the turn retired at
      // close START (onBeginClose below). Here we AWAIT any already-admitted undo/redo/restore so it
      // lands IN FULL, THEN write the final snapshot through the ordered, failure-reporting queue (an
      // older queued snapshot can't clobber it). Re-runnable on retry.
      await whenChatQuiescent(id);
      return saveProjectSessionNow(id);
    },
    dispose: async () => {
      // Release BEFORE teardown: dispose is guaranteed to run, and a lock left behind makes
      // the next open of a Dropbox project warn about a session that ended cleanly.
      try {
        const st = await storeForProject(id);
        if (st) {
          cancelWriteRecovery(st.projectDir);
          await releaseProjectLock(st.fsForProjectRegistry(), st.projectDir);
        }
      } catch (e) {
        captureError(e, { scope: "project.dispose.lock" });
      }
      // Close-time media GC (Phase 7.2): drop owned library bytes that NO persisted reference can
      // restore (the catalog / the current timeline / any chat checkpoint). The in-memory undo stack
      // dies with close, so a just-cascade-deleted item's KEPT bytes become safe garbage now. Runs
      // BEFORE the stores deactivate + is best-effort — a sweep failure never blocks close.
      try {
        const gcStore = await storeForProject(id);
        if (gcStore) {
          await sweepOwnedMedia(gcStore);
          await sweepArtifactCache(gcStore);
        }
      } catch (e) {
        captureError(e, { scope: "project.dispose.gc" });
      }
      // Teardown AFTER a successful save (or an explicit Discard). Every step attempts INDEPENDENTLY, and
      // the editor deactivation — which INVALIDATES the project session so no late writer (undo persist,
      // no-document timeline fallback) can touch the folder after close — is GUARANTEED via finally, even
      // if the transcript drain throws (finding #3: a flush throw must never skip session invalidation).
      try {
        try {
          deactivateChatProject(id);
        } catch (e) {
          captureError(e, { scope: "project.dispose.chat" });
        }
        await flushPendingSession(await projectDirFor(id));
      } catch (e) {
        captureError(e, { scope: "project.dispose.flush" });
      } finally {
        try {
          deactivateEditorProject(id); // invalidate the session — ALWAYS, so nothing writes after close
        } catch (e) {
          captureError(e, { scope: "project.dispose.editor" });
        }
        try {
          closeToolHost(id);
        } catch (e) {
          captureError(e, { scope: "project.dispose.host" });
        }
      }
    },
  };
}

/** The single source of truth for which project is open. Shell routes activation through
 *  `projectDocuments.open(id)` / `.close(id)` instead of orchestrating the stores directly. */
export const projectDocuments = new ProjectDocumentRegistry(makeProjectChildren, (id) => ({
  // Origin fence: a commit carrying a superseded chat execution's origin is rejected at the gate.
  isOriginCurrent: (o) => isChatExecutionCurrent(id, o),
  // A final timeline save that could not persist on close (survived the autosave's retries) is a
  // potential lost edit — report it instead of completing close silently.
  onCloseSaveFailed: (pid) =>
    captureError(new Error(`timeline autosave failed on close for project ${pid}`), {
      scope: "project.close",
    }),
  // Re-arm a FRESH timeline persist (reset retry budget) when the close SAVE finds the in-memory
  // timeline still dirty (finding #3): a Retry after the async autosave exhausted its retries must
  // re-attempt the actual disk write, not just re-flush a drained autosave. Guarded to the still-live
  // editor store for THIS project so it can never write the in-memory timeline into another project.
  rearmTimelineSave: (doc) => {
    const ed = useEditor.getState();
    if (ed.store && ed.projectId === doc.id) rearmTimelinePersist(ed.store, doc);
  },
  // A child teardown that threw AFTER a durable save (finding #4): the close still completes (data is
  // safe); report the leak instead of retaining a half-disposed document as editable.
  onDisposeFailed: (pid, error) =>
    captureError(error instanceof Error ? error : new Error(`dispose failed for project ${pid}`), {
      scope: "project.dispose",
    }),
  // Cancelling a failed close (Keep editing) must re-admit the chat producers quiesced during the SAVE
  // (finding #2), else send()/undo stay fenced and the user can't edit.
  onReopen: (pid) => resumeChatProject(pid),
  // Close chat admission the INSTANT close begins (finding #2): raise the fence + retire the turn +
  // normalize its state synchronously, so no chat op is admitted from the start of close, not just once
  // the SAVE phase is reached.
  onBeginClose: (pid) => quiesceChatProject(pid),
}));

// Inject the DIR -> AUTHORITY-document lookup the mutation executor uses to route commits through this
// document's gate, breaking the engine -> registry import cycle (the engine depends only on the leaf
// resolver; this composition module already depends on the registry + stores). One-way. It resolves to
// `getAuthority` (open | close-failed | mid-close), NOT `get` (open-only): the CLOSING doc must stay the
// runtime authority so a late commit routes through its (closing) gate and is REJECTED, instead of
// finding "no document" and slipping past admission on a bare lock (reviewer blocker 1). UI open-
// visibility still uses `get()`; this is the ownership view.
setOpenDocumentResolver((id) => projectDocuments.getAuthority(id));
