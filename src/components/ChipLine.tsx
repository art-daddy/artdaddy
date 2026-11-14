// The chat card's line about what an export runs on, where that is the graphics chip: the line's own words, and a quiet "Turn off" for a
// person who only exports from the chat and never opens the Export dialog. It is the same switch as the dialog's row (artdaddy.chipPref.v1):
// the export that is running keeps going on the chip, and the next ones use the processor.
import { useReducer } from "react";

import { exportFlag } from "../api/exportFlags";
import { readChipPref, writeChipPref } from "../timeline/chipPref";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export const CHIP_TURNED_OFF_LINE =
  "Graphics chip turned off. This export keeps going; the next exports use the processor.";

export default function ChipLine({ line, chip }: { line: string; chip: boolean }): JSX.Element {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // With the switch for Quick export off the card is what it was: the line and nothing else.
  const offer = chip && exportFlag("quick_export");
  const off = offer && readChipPref(storage()) === "off";
  return (
    <>
      <div className="mt-0.5 text-[11px] text-neutral-500">
        <span>{line}</span>
        {offer && !off && (
          <>
            <span> · </span>
            <button
              type="button"
              aria-label="turn off the graphics chip"
              onClick={() => {
                writeChipPref(storage(), "off");
                redraw();
              }}
              className="underline underline-offset-2 hover:text-neutral-300"
            >
              Turn off
            </button>
          </>
        )}
      </div>
      {off && (
        <div data-testid="export-card-chip-off" className="mt-0.5 text-[11px] text-neutral-500">
          {CHIP_TURNED_OFF_LINE}
        </div>
      )}
    </>
  );
}
