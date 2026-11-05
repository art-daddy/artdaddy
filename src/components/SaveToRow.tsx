// The Save to row of the question about the exported file's room: where the video goes now, or the folder the
// person picked instead, Browse, and Undo once a pick would move the file. The dialog and the card above the chat box
// both draw it from the one open question, so a pick made in either is the one either Continue carries. Choosing a
// folder changes nothing by itself: the export starts again there only when the person presses Continue.
import { pickFolder } from "../lib/pickFolder";
import {
  chooseQuestionFolder,
  movesTheFile,
  type QuestionFolder,
} from "../store/exportQuestionHost";
import { displayFolder } from "../timeline/exportQuestions";
import { cn } from "./ui";

export default function SaveToRow({
  id,
  folder,
  compact = false,
}: {
  id: number;
  folder: QuestionFolder;
  compact?: boolean;
}): JSX.Element {
  const shown = displayFolder(folder.picked ?? folder.now);
  const browse = async (): Promise<void> => {
    try {
      const chosen = await pickFolder("Save the video to", folder.picked ?? folder.now);
      if (chosen) chooseQuestionFolder(id, chosen);
    } catch {
      /* a picker that cannot open is a person who chose nothing */
    }
  };
  return (
    <div
      role="group"
      aria-label="Save to"
      className={cn("flex items-center gap-2", compact ? "mt-2 text-xs" : "mt-3 text-sm")}
    >
      <span className="text-neutral-400">Save to</span>
      <span
        title={shown}
        className="min-w-0 flex-1 truncate rounded-md bg-neutral-950/60 px-2 py-1 text-neutral-100"
      >
        {shown}
      </span>
      <button
        type="button"
        onClick={() => void browse()}
        className="rounded-md px-2 py-1 text-neutral-200 underline underline-offset-2 hover:bg-neutral-800"
      >
        Browse…
      </button>
      {movesTheFile(folder) && (
        <button
          type="button"
          onClick={() => void chooseQuestionFolder(id, null)}
          className="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-800"
        >
          Undo
        </button>
      )}
    </div>
  );
}
