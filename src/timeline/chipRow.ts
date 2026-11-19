// The pure model of the Export dialog's "Graphics chip" row: which of its states it is in, whether it is drawn, what it says and the
// one link it offers. The lane draws it. Nothing here tests a chip, reads the PC or reads a flag: a test is never asked for from here,
// and with the switch on Off no state asks for one.
import type { ChipPref } from "./chipPref";

export type ChipRowState =
  "none" | "checking" | "auto_passed" | "auto_not_passed" | "set_aside" | "off";

/** The link the row offers in its state, if any: switching it back to Auto, or trying a chip that stopped an export again before its
 *  day is up. The row never offers to switch the chip off: that is the radio's Off, in the dialog. */
export type ChipRowAction = "turn_on" | "try_again_now";

export interface ChipRowInput {
  /** The app found a chip of a known maker on this PC. */
  found: boolean;
  pref: ChipPref;
  /** The per-PC test for the delivered picture's size class is running or waiting its turn. */
  testing: boolean;
  /** What that test says (or the one remembered): `unknown` until it has said anything. */
  verdict: "passed" | "not_passed" | "unknown";
  /** The chip stopped an export and is set aside for a day. */
  setAside: boolean;
  /** The server's switches that let a chip be used at all (the maker's own and `chip_default`) are on. */
  flagsOn: boolean;
  /** `quick_export` is on. Off, the old Mode row comes back and this row is not drawn, unless the person's own Off is stored: that is drawn, so it can be undone. */
  quickFlagOn: boolean;
  /** The delivered picture is in a size class the chip is tested and used at. A picture wider than 3840 pixels or above 3840 by 2160 pixels (8K, for one) or above 60 frames a second is not: the
   *  processor makes those, and Auto has nothing true to say of the chip there. */
  sizeServed: boolean;
}

export interface ChipRowModel {
  state: ChipRowState;
  /** Whether the row is drawn at all; `none` is exactly the rows that are not. */
  visible: boolean;
  note: string | null;
  action: ChipRowAction | null;
}

/** The row's words, as the copy pack has them. (The hints about an old NVIDIA driver or a switched-off Intel chip are not the
 *  row's: they have their own module.) */
export const CHIP_ROW_NOTES: Readonly<Record<Exclude<ChipRowState, "none">, string>> = {
  checking: "Checking this PC's graphics chip…",
  // The cost of the chip is said here, before the start, because the Export dialog no longer shows the old Mode row (which said it) where this row is drawn.
  auto_passed:
    "Auto: used on this PC. The file is usually larger. It passed ArtDaddy's test on this PC.",
  auto_not_passed:
    "Auto: not used. The graphics chip did not pass ArtDaddy's test on this PC, so exports use the processor.",
  set_aside:
    "The graphics chip stopped an export on this PC, so it is set aside for a day. Try it again now",
  off: "Off: the graphics chip is not tested, offered or used on this PC. Everything runs on the processor.",
};

const ACTIONS: Readonly<Record<Exclude<ChipRowState, "none">, ChipRowAction | null>> = {
  checking: null,
  auto_passed: null,
  auto_not_passed: null,
  set_aside: "try_again_now",
  off: "turn_on",
};

const hidden = (): ChipRowModel => ({ state: "none", visible: false, note: null, action: null });

/** The state the row is in when it is drawn. Off wins over everything (never tested, offered or used); a chip set aside is not
 *  tested again either; a test that is running beats an older answer (it may be for another picture size); an answer that has
 *  not come yet is shown as checking. */
function stateOf(
  input: Partial<Record<keyof ChipRowInput, unknown>>,
): Exclude<ChipRowState, "none"> {
  if (input.pref === "off") return "off";
  if (input.setAside === true) return "set_aside";
  if (input.testing === true) return "checking";
  if (input.verdict === "passed") return "auto_passed";
  if (input.verdict === "not_passed") return "auto_not_passed";
  return "checking";
}

/** The row's model. The person's own Off is drawn wherever a chip is found, whatever the server's switches and the picture's size say: it holds whatever they say, so it must
 *  always be there to undo. Auto is drawn only where it has something true to say: the server allows the chip and this row, and the picture is in a size class the chip serves.
 *  Anything that is not exactly what the type says is read as the quiet answer (no row), and nothing throws. */
export function chipRowModel(input: ChipRowInput): ChipRowModel {
  try {
    if (input === null || typeof input !== "object") return hidden();
    const fields: Partial<Record<keyof ChipRowInput, unknown>> = input;
    if (fields.found !== true) return hidden();
    if (
      fields.pref !== "off" &&
      (fields.flagsOn !== true || fields.quickFlagOn !== true || fields.sizeServed !== true)
    )
      return hidden();
    const state = stateOf(fields);
    return { state, visible: true, note: CHIP_ROW_NOTES[state], action: ACTIONS[state] };
  } catch {
    return hidden();
  }
}
