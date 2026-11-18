// The two choices of the Export dialog's Quality / Fast view (design D2): one radio group, with the lab's speed-up figure after the word Fast and the tooltip that says what it is.
// Every word comes from exportChoiceWords.ts. The view decides the figure (null draws the plain word: no figure, no tooltip, no description); this row only shows it.
import { useId, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

import type { Choice } from "../timeline/exportChoiceView";
import { D2_WORDS, figureBrackets, figureSpoken } from "../timeline/exportChoiceWords";

export interface ChoiceRowProps {
  /** The selected choice: the checked radio follows it. */
  choice: Choice;
  /** The lab's speed-up for Fast. Null draws the plain word: no figure, no tooltip, no description. */
  figure: number | null;
  /** A pick of either radio. Called from onChange and from onClick, because picking the radio that is already checked fires a click but no change: the handler must be idempotent. */
  onPick: (choice: Choice) => void;
  /** Set to a function that closes the tooltip and says whether it was open (the dialog's Escape asks it first). Null again when the row unmounts. */
  closeTip: MutableRefObject<(() => boolean) | null>;
}

const cardCls =
  "flex items-center gap-2 rounded-md border border-edge px-2.5 py-[7px] text-[13px] leading-[18px] text-neutral-200 has-[:checked]:border-neutral-500 has-[:checked]:bg-raised/70 has-[:checked]:text-neutral-100";
const figureCls = "cursor-help border-b border-dotted border-neutral-500 text-neutral-300";
// The invisible strip (before:) covers the 8px between the tooltip and the card, so the pointer can travel onto the tooltip without leaving the hover area.
const tipCls =
  "absolute right-[-10px] bottom-[calc(100%+8px)] z-[6] w-[196px] rounded-md border border-neutral-600 bg-[#0b0b0d] px-2 py-1.5 text-[11px] leading-snug text-neutral-200 shadow-lg before:absolute before:inset-x-0 before:top-full before:h-[10px]";

export default function ChoiceRow({
  choice,
  figure,
  onPick,
  closeTip,
}: ChoiceRowProps): JSX.Element {
  // Hover and focus both set it and both clear it: the tooltip is open from the last of them until the next pointer leave, blur or Escape.
  const [shown, setShown] = useState(false);
  const spokenId = useId();
  const tipId = useId();
  // A figure that cannot be written (not a finite number) is no figure.
  const figureWords =
    figure !== null && figureBrackets(figure) !== ""
      ? { brackets: figureBrackets(figure), spoken: figureSpoken(figure) }
      : null;
  const open = shown && figureWords !== null;

  // The dialog's Escape handler asks from outside React, so what was last drawn is kept in a ref.
  const openRef = useRef(false);
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);
  useLayoutEffect(() => {
    const close = (): boolean => {
      if (!openRef.current) return false;
      openRef.current = false;
      setShown(false);
      return true;
    };
    closeTip.current = close;
    return () => {
      if (closeTip.current === close) closeTip.current = null;
    };
  }, [closeTip]);

  return (
    <div
      role="radiogroup"
      aria-label={D2_WORDS.choiceGroupName}
      data-testid="export-choice"
      className="flex gap-2"
    >
      <label className={`${cardCls} min-w-0 flex-1`}>
        <input
          type="radio"
          name="export-choice"
          value="quality"
          checked={choice === "quality"}
          onChange={() => onPick("quality")}
          onClick={() => onPick("quality")}
          className="accent-accent"
        />
        <span>{D2_WORDS.choiceQuality}</span>
      </label>
      {/* The tooltip sits beside the label, not in it: a click on the tooltip must not pick Fast, and its words are not part of the radio's name. */}
      <div
        className="relative min-w-0 flex-1"
        onMouseEnter={() => setShown(true)}
        onMouseLeave={() => setShown(false)}
      >
        <label className={cardCls}>
          <input
            type="radio"
            name="export-choice"
            value="fast"
            checked={choice === "fast"}
            onChange={() => onPick("fast")}
            onClick={() => onPick("fast")}
            onFocus={() => setShown(true)}
            onBlur={() => setShown(false)}
            aria-describedby={figureWords ? `${spokenId} ${tipId}` : undefined}
            className="accent-accent"
          />
          <span>
            {D2_WORDS.choiceFast}
            {figureWords && (
              <>
                {" "}
                <span className={figureCls}>{figureWords.brackets}</span>
              </>
            )}
          </span>
        </label>
        {figureWords && (
          <>
            <span id={spokenId} className="sr-only">
              {figureWords.spoken}
            </span>
            {/* Always in the page while a figure is shown: the Fast radio is described by it even while it is hidden. */}
            <div
              id={tipId}
              role="tooltip"
              hidden={!open}
              data-testid="export-fast-tip"
              className={tipCls}
            >
              {D2_WORDS.figureTip}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
