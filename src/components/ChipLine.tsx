// The chat card's line about what an export runs on, where that is the graphics chip: the line's own words and, for a chip the person switched off in the Export dialog, one sentence that says so. The card
// has no switch of its own: the chip is switched in the dialog's Graphics chip row alone (artdaddy.chipPref.v1), and an export that is running keeps going on the chip while the next ones use the processor.
import { exportFlag } from "../api/exportFlags";
import { readChipPref } from "../timeline/chipPref";

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
  // With the switch for Quick export off the card is what it was: the line and nothing else.
  const off = chip && exportFlag("quick_export") && readChipPref(storage()) === "off";
  return (
    <>
      <div className="mt-0.5 text-[11px] text-neutral-500">
        <span>{line}</span>
      </div>
      {off && (
        <div data-testid="export-card-chip-off" className="mt-0.5 text-[11px] text-neutral-500">
          {CHIP_TURNED_OFF_LINE}
        </div>
      )}
    </>
  );
}
