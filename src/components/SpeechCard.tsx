// The speech card in the chat pane, beside the export card: how the transcription of the files the
// assistant is waiting for is going.
//
// It is a view of what `cardView` made of the speech work, and nothing else: nothing is written into the
// conversation, no tokens are spent, and it keeps no state of its own. A note is put away by telling
// whoever owns the view, which then gives a view without it.
import type { CardView } from "../tools/speechTimeLine";

export default function SpeechCard({
  view,
  onDismiss,
}: {
  view: CardView | null;
  onDismiss: (id: string) => void;
}): JSX.Element | null {
  if (view === null) return null;
  return (
    <section
      role="status"
      aria-label="speech"
      data-testid="speech-card"
      className="mb-2 space-y-1 rounded-lg border border-edge bg-neutral-900/60 px-3 py-2 text-xs"
    >
      {view.lines.map((line, i) => (
        <div key={i} className="tabular-nums text-neutral-200">
          {line}
        </div>
      ))}
      {view.notes.map((note, i) => (
        // The place as well as the id: two notes may share an id, and each is still shown.
        <div
          key={`${i}:${note.id}`}
          className="flex items-start justify-between gap-2 text-amber-300"
        >
          <span className="min-w-0">{note.text}</span>
          <button
            type="button"
            aria-label="dismiss"
            onClick={() => onDismiss(note.id)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-none text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          >
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
