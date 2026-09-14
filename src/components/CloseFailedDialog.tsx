// The retryable-close modal (guardrail 6). Shown when a project's final save FAILED on
// close/switch/exit: the document is kept alive (memory + undo intact) and the user chooses
// Retry (re-save), Discard (destroy dirty state — confirmed), or Keep editing (Cancel — return to
// the project with a fresh gate/job scope). A modal overlay pattern, like AboutDialog's.
import { useNavigate } from "react-router-dom";

import { confirmDestructive } from "../lib/confirm";
import { projectDocuments } from "../project/documentRegistry";
import { asProjectId } from "../project/types";
import { projectPath, useCloseCoordinator } from "../store/closeCoordinator";

export default function CloseFailedDialog() {
  const nav = useNavigate();
  const pending = useCloseCoordinator((s) => s.pending);
  const busy = useCloseCoordinator((s) => s.busy);
  const setBusy = useCloseCoordinator((s) => s.setBusy);
  const setPending = useCloseCoordinator((s) => s.setPending);
  const clearPending = useCloseCoordinator((s) => s.clearPending);
  const exitHandler = useCloseCoordinator((s) => s.exitHandler);

  if (!pending) return null;
  const { failedId, target, exit, kind } = pending;
  const unsaved = kind === "unsaved"; // asking BEFORE the close, not reporting a failed one

  // The project finally closed cleanly (retry succeeded) or was discarded — go where the switch/exit
  // was headed: quit the app (exit) or navigate to the target project.
  const finish = () => {
    clearPending();
    if (exit) exitHandler?.();
    else nav(projectPath(target));
  };

  // "Save and quit" (unsaved) and "Retry save" (failed) are the same action against the same door;
  // only the label differs. A save that fails here becomes the failed-close case rather than a
  // dead end, so the user still gets Discard / Keep editing.
  const save = async () => {
    setBusy(true);
    try {
      const outcome = unsaved
        ? await projectDocuments.close(asProjectId(failedId))
        : await projectDocuments.retryClose(asProjectId(failedId));
      if (outcome.ok) finish();
      else if (unsaved) setPending({ ...pending, kind: "failed" });
    } catch {
      /* close() is designed never to reject, but a defensive catch guarantees we never freeze */
      if (unsaved) setPending({ ...pending, kind: "failed" });
    } finally {
      setBusy(false); // finding #5: never leave the recovery modal stuck busy after a throw
    }
  };

  const discard = async () => {
    const ok = await confirmDestructive(
      "Discard unsaved changes and close this project? This can't be undone.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await projectDocuments.discardClose(asProjectId(failedId)); // tear down despite the dirty state
      finish();
    } catch {
      /* teardown threw — fall through to re-enable the actions so the user can retry / keep editing */
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    // Only a close that actually STARTED needs un-quiescing; the unsaved prompt never began one.
    if (!unsaved) projectDocuments.cancelClose(asProjectId(failedId));
    clearPending();
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={unsaved ? "unsaved changes" : "close failed"}
        className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-100 shadow-xl"
      >
        <h1 className="text-lg font-semibold tracking-tight">
          {unsaved
            ? exit
              ? "Save changes before quitting?"
              : "Save changes before closing?"
            : "Couldn't save this project"}
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          {unsaved
            ? "This project has edits that haven't reached disk yet."
            : "The final save failed, so the project wasn't closed and your work is still here. Retry the save, discard the unsaved changes, or keep editing."}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {unsaved ? "Cancel" : "Keep editing"}
          </button>
          <button
            type="button"
            onClick={() => void discard()}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            {unsaved ? "Discard changes" : "Discard"}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
          >
            {busy
              ? "Saving…"
              : unsaved
                ? exit
                  ? "Save and quit"
                  : "Save and close"
                : "Retry save"}
          </button>
        </div>
      </div>
    </div>
  );
}
