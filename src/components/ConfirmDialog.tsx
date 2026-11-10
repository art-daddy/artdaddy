// A small in-app yes/no question for the chat panel: delete a chat, or go back over work made
// outside the chat. The OS confirm box is a bare string; these need a title, the thing named, and
// buttons that say what they do. Same overlay pattern as ReportProblemDialog.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { captureError } from "../observability/sentry";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** The confirming action throws something away: its button is red, and Cancel is the focused one so
   *  a stray Enter keeps the work. */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const cancel = () => {
    if (!busy) onCancel();
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } catch (e) {
      // The dialog stays usable (Cancel, or try again); the failure is reported rather than left
      // as an unhandled rejection from a click handler.
      captureError(e, { scope: "confirm_dialog", dialog: title });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-100 shadow-xl"
      >
        <h1 id={titleId} className="text-lg font-semibold tracking-tight">
          {title}
        </h1>
        <div id={bodyId} className="mt-2 text-sm text-neutral-400">
          {children}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className={
              destructive
                ? "rounded-md bg-red-600/90 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                : "rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
            }
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
