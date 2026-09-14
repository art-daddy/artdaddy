// "Report a problem": collect the user's description BEFORE uploading, so a report
// carries what went wrong instead of just a transcript. Send stays disabled until the
// note has non-whitespace text; a failed upload keeps the dialog (and the typed text)
// open to retry.
import { useEffect, useRef, useState } from "react";

// Matches the server's _NOTE_MAX (feedback.py), which truncates beyond this.
const NOTE_MAX = 2000;

export default function ReportProblemDialog({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setNote("");
      setFailed(false);
      setBusy(false);
      textareaRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const canSend = note.trim().length > 0 && !busy;

  const send = async () => {
    const trimmed = note.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await onSubmit(trimmed);
    setBusy(false);
    if (!ok) setFailed(true); // keep the dialog + text so the user can retry
  };

  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6"
      onKeyDown={(e) => {
        if (e.key === "Escape") cancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-problem-title"
        className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-neutral-100 shadow-xl"
      >
        <h1 id="report-problem-title" className="text-lg font-semibold tracking-tight">
          Report a problem
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Tell us what went wrong. We&apos;ll include this chat&apos;s transcript and your timeline
          (no media files) so we can reproduce it.
        </p>
        <textarea
          ref={textareaRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX}
          rows={5}
          disabled={busy}
          aria-label="What went wrong?"
          placeholder="What did you expect, and what happened instead?"
          className="mt-4 w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent focus:outline-none disabled:opacity-50"
        />
        {failed && (
          <p role="alert" className="mt-2 text-xs text-red-300">
            Couldn&apos;t reach the server. Your note is still here — try again.
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            title={canSend ? undefined : "Describe the problem first"}
            className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send report"}
          </button>
        </div>
      </div>
    </div>
  );
}
