// The door "Advanced settings" of the Export dialog's Quality / Fast view (design D2) and the region behind it: the Frame rate and Quality rows and the Graphics chip row. Controlled: the view owns
// whether the door is open and every value, and this file only draws them. Every word comes from exportChoiceWords.ts.
//
// The region is ALWAYS mounted and carries the HTML `hidden` attribute while the door is closed (not a CSS class, so role queries skip it; not unmounted). The Graphics chip row inside it makes its
// first look when the dialog opens, and that look decides what Quality sends (spec F3): a row drawn only when the door is open would change what Quality sends.
import { useId, useLayoutEffect, useRef } from "react";

import { D2_WORDS } from "../timeline/exportChoiceWords";
import type { ExportQuality, ExportResolution } from "../timeline/exportOptions";
import ChipRow from "./ChipRow";
import { Field, selectCls } from "./exportFields";

export interface AdvancedSettingsProps {
  /** Whether the door is open. */
  open: boolean;
  /** The door was pressed. */
  onToggle: () => void;
  /** The line under the door. Not drawn when absent, null or empty. */
  summary?: string | null;
  /** The sentence about the faster setting (0.28.0's), drawn under the summary spot when not null. */
  fasterLine: string | null;
  /** The Frame rate list (`null` is the project's own rate). The row is drawn only when it has two entries or more: with one there is nothing to choose. */
  rates: { value: number | null; label: string }[];
  /** The shown rate (`null`: the project's own). */
  fps: number | null;
  onFps: (fps: number | null) => void;
  /** The Quality list. */
  qualities: { value: ExportQuality; label: string }[];
  quality: ExportQuality;
  onQuality: (quality: ExportQuality) => void;
  /** The Graphics chip row's basis. Null (no project): no row and no chip test, as in 0.28.0. */
  chip: null | {
    workload: { width: number; height: number; fps: number };
    /** The SHOWN size: the chip is tested at the size class the export will deliver. */
    resolution: ExportResolution;
    fps: number | null;
    /** The person changed what the app does about the chip (its switch, Try it again now). */
    onChange: () => void;
    /** The chip row's first look has answered, told before paint. */
    onDrawn: (drawn: boolean) => void;
  };
  /** Fast is the choice: the chip row's note for the passed state says what a Fast export does. */
  fastChosen?: boolean;
}

// The owner's sentence for the state where the chip passed its test (OD-5); the other four states keep the row's own notes. With Fast chosen the sentence does not say when the chip is used: a Fast
// export uses a chip that passed.
const CHIP_NOTES = { auto_passed: D2_WORDS.chipNotePassed } as const;
const CHIP_NOTES_FAST = { auto_passed: D2_WORDS.chipNotePassedFast } as const;

const doorCls = "flex items-center gap-[7px] text-xs text-neutral-300";
const triangleCls =
  "inline-block h-0 w-0 border-y-[3.5px] border-l-[5px] border-y-transparent border-l-neutral-400";

const rateValue = (value: number | null): string => (value === null ? "" : String(value));

export default function AdvancedSettings({
  open,
  onToggle,
  summary = null,
  fasterLine,
  rates,
  fps,
  onFps,
  qualities,
  quality,
  onQuality,
  chip,
  fastChosen = false,
}: AdvancedSettingsProps): JSX.Element {
  const doorId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  // Closed, `hidden` takes the region out of the tab order and out of the accessibility tree in a browser; `inert` says the same to anything that does not read that attribute. A property, not a
  // prop: React 18 does not know the attribute.
  useLayoutEffect(() => {
    if (regionRef.current) regionRef.current.inert = !open;
  }, [open]);

  return (
    <>
      <button
        type="button"
        id={doorId}
        aria-expanded={open}
        aria-controls="export-advanced"
        onClick={onToggle}
        className={doorCls}
      >
        <span aria-hidden="true" className={`${triangleCls}${open ? " rotate-90" : ""}`} />
        {D2_WORDS.door}
      </button>
      {/* No flex or grid class on the region: its display would override `hidden`. */}
      <div
        ref={regionRef}
        id="export-advanced"
        data-testid="export-advanced"
        role="group"
        aria-labelledby={doorId}
        hidden={!open}
        className="mt-2.5 space-y-3"
      >
        {summary !== null && summary !== "" && (
          <p className="text-xs leading-snug text-neutral-300">{summary}</p>
        )}
        {fasterLine !== null && (
          <p className="text-xs leading-snug text-neutral-400">{fasterLine}</p>
        )}
        {rates.length >= 2 && (
          <Field label={D2_WORDS.rateLabel}>
            <select
              aria-label={D2_WORDS.rateName}
              value={rateValue(fps)}
              onChange={(e) => onFps(e.target.value === "" ? null : Number(e.target.value))}
              className={selectCls}
            >
              {rates.map((rate) => (
                <option key={rateValue(rate.value)} value={rateValue(rate.value)}>
                  {rate.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={D2_WORDS.qualityLabel}>
          <select
            aria-label={D2_WORDS.qualityName}
            value={quality}
            onChange={(e) => onQuality(e.target.value as ExportQuality)}
            className={selectCls}
          >
            {qualities.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
        {chip !== null && (
          <ChipRow
            workload={chip.workload}
            resolution={chip.resolution}
            fps={chip.fps}
            onChange={chip.onChange}
            onDrawn={chip.onDrawn}
            notes={fastChosen ? CHIP_NOTES_FAST : CHIP_NOTES}
          />
        )}
      </div>
    </>
  );
}
