// Every word of the Export dialog's Quality / Fast view (design D2), once. The owner's copy: exact words, straight apostrophes, ASCII "x". Nothing in a
// component carries one of these sentences; a component imports them from here (a guard test holds that). Pure: no React, no store, no switch.
//
// The ids (S01, S05 ...) are the rows of the UI spec's strings table (section 2), so a word can be traced to its source. A word the page does not carry is marked
// [A] in the spec and flagged in the lane's report; the strings that are a 0.28.0 constant are imported, never copied, so there is one of each.
import type { ExportQuality } from "./exportOptions";
import { FASTER_SETTING_LINE } from "./exportWords";

/** The fixed words, by what they are for. A person sees every one of these as it is written here. */
export const D2_WORDS = {
  /** S01 the title of the dialog. */
  title: "Export video",
  /** S02, S03 the two choices. */
  choiceQuality: "Quality",
  choiceFast: "Fast",
  /** S02 [A] the accessible name of the choice row (lower case, like "export mode" was). */
  choiceGroupName: "export choice",
  /** S05 the tooltip on the figure that follows Fast. */
  figureTip: "Typical speed-up; your PC may differ.",
  /** S07 the row label, and the select's accessible name (the name Q2's tests use). */
  resolutionLabel: "Resolution",
  resolutionName: "resolution",
  /** S10 the door. */
  door: "Advanced settings",
  /** S14 the line for the faster setting, behind the door, Quality only: the 0.28.0 constant itself (OD-6). */
  fasterSetting: FASTER_SETTING_LINE,
  /** S15 the frame rate row. */
  rateLabel: "Frame rate",
  rateName: "frame rate",
  /** S16 the quality row. */
  qualityLabel: "Quality",
  qualityName: "quality",
  /** S18 the Graphics chip note for the state where the chip passed its test (OD-5, owner's yes of 18 Nov: the page's sentence with the clause "the picture can differ slightly" kept, in 0.28.0's own
   *  words). The other four notes are 0.28.0's (`CHIP_ROW_NOTES`). */
  chipNotePassed:
    "Auto: used when it saves time. The file is usually larger and the picture can differ slightly.",
  /** S19, S20 the footer. */
  cancel: "Cancel",
  exportAction: "Export",
  /** S21 the question's title. */
  questionTitle: "Are you sure?",
  /** S23 question (a) where the figure may not be claimed (a size or a rate was changed). */
  questionQuicker: "This is a big export. Fast would be quicker.",
  /** S24 question (b). */
  questionOwnSettings: "These settings make a big export. Fast's own settings would be quicker.",
  /** S25 question (a)'s buttons: the second and the third (the first is `cancel`). */
  exportAtQuality: "Export at Quality",
  useFast: "Use Fast",
  /** S26 question (b)'s buttons: the second and the third. */
  exportWithThese: "Export with these settings",
  useFastSettings: "Use Fast's settings",
} as const;

/** OD-5: the clause of the 0.28.0 chip note that is still left out ("When it is used, the file is usually larger and the picture can differ slightly. It passed ArtDaddy's test on this PC.").
 *  "the picture can differ slightly" is back in `D2_WORDS.chipNotePassed` (the owner's yes); this one stays out until the owner asks. Restoring it is one edit there; nothing reads it. */
export const CHIP_NOTE_DROPPED_CLAUSES = Object.freeze({
  passedTest: "It passed ArtDaddy's test",
});

/** S09 the size presets as the list names them (the page's and 0.28.0's words). */
export const RESOLUTION_WORDS = Object.freeze({
  "2160p": "2160p (4K)",
  "1440p": "1440p",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
} as const);

/** S16 the three qualities, names only (the page shows no hint). */
export const QUALITY_WORDS: Readonly<Record<ExportQuality, string>> = Object.freeze({
  high: "High",
  medium: "Medium",
  low: "Low",
});

/** The figure as the page writes it: whole as `4`, otherwise one decimal as `2.5`. A figure that is not a finite number gives nothing. */
export function figureNumber(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  const tenth = Math.round(n * 10) / 10;
  return Number.isInteger(tenth) ? String(tenth) : tenth.toFixed(1);
}

/** S04 the figure on the Fast label without its brackets: `4x`, `2.5x`. */
export function describeFigure(n: number): string {
  const text = figureNumber(n);
  return text === "" ? "" : `${text}x`;
}

/** S04 the figure as it follows the word Fast: `(4x)`. */
export function figureBrackets(n: number): string {
  const text = describeFigure(n);
  return text === "" ? "" : `(${text})`;
}

/** S06 what a screen reader is told of the figure, before the tooltip: `About 4 times faster.` */
export function figureSpoken(n: number): string {
  return `About ${figureNumber(n)} times faster.`;
}

/** A frame rate as a person reads it: whole as `30`, otherwise at most two decimals (29.97 stays 29.97, 23.976 gives 23.98). */
export function formatRate(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : String(Math.round(fps * 100) / 100);
}

/** S08 the Resolution list's first entry: the picture the export makes of the project. */
export function sameAsProjectSize(width: number, height: number): string {
  return `Same as project (${width} x ${height})`;
}

/** S15 a Frame rate entry below the project's own. */
export function rateEntry(fps: number): string {
  return `${formatRate(fps)} fps`;
}

/** S15 the Frame rate list's first entry: the project's own rate. */
export function sameAsProjectRate(fps: number): string {
  return `Same as project (${rateEntry(fps)})`;
}

/** S11, S12, S13 the line under the door. Quality: the project's own size and rate and the quality it starts on. Fast: one size smaller where the project has a smaller size, up to
 *  the rate cap, the quality Fast starts on and the faster compression. Built from the figures it is given, so the lab's bundle is the only place a number lives. */
export function summaryWords(
  choice: "quality" | "fast",
  figures: { smallerSize: boolean; maxFps: number; quality: ExportQuality },
): string {
  const quality = `${QUALITY_WORDS[figures.quality]} quality`;
  if (choice === "quality") return `Project size and frame rate, ${quality}.`;
  const parts = [
    ...(figures.smallerSize ? ["One size smaller"] : []),
    `${figures.smallerSize ? "up" : "Up"} to ${formatRate(figures.maxFps)} frames a second`,
    quality,
    "faster compression",
  ];
  return `${parts.join(", ")}.`;
}

/** S22, S23, S24 the sentence of the question. (a) is asked of Quality: with a figure it says how much quicker Fast would be, without one (a size or a rate was changed, so the figure
 *  would be untrue) it says only that Fast would be quicker. (b) is asked of Fast with heavier settings. Never a time. */
export function questionWords(kind: "a" | "b", figure: number | null): string {
  if (kind === "b") return D2_WORDS.questionOwnSettings;
  return figure === null || describeFigure(figure) === ""
    ? D2_WORDS.questionQuicker
    : `This is a big export. Fast would be about ${describeFigure(figure)} faster.`;
}

/** S25, S26 the three buttons of the question, in order: the plain Cancel, the outlined one that exports as it is, the primary one that uses Fast's settings. */
export function questionButtons(kind: "a" | "b"): readonly [string, string, string] {
  return kind === "a"
    ? [D2_WORDS.cancel, D2_WORDS.exportAtQuality, D2_WORDS.useFast]
    : [D2_WORDS.cancel, D2_WORDS.exportWithThese, D2_WORDS.useFastSettings];
}
