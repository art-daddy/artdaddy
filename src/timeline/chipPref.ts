// The person's "Graphics chip: Auto / Off" switch, remembered on this PC (artdaddy.chipPref.v1). Off means the chip is never tested,
// offered or used: whoever would ask for a chip reads this first. A missing, damaged or foreign value is Auto. A write that fails is
// not a failure, and the choice still holds for this run of the app (as a chip set aside does in chipTest.ts).
import type { StorageLike } from "./pcClass";

export type ChipPref = "auto" | "off";

export const CHIP_PREF_KEY = "artdaddy.chipPref.v1";

/** Choices that could not be written, by the storage they were meant for. */
const unwritten = new WeakMap<object, ChipPref>();

/** The person's choice: Off only when exactly that was stored (or could not be stored); anything else is Auto. Never throws. */
export function readChipPref(store: StorageLike | null): ChipPref {
  try {
    if (!store) return "auto";
    const held = unwritten.get(store);
    if (held) return held;
    return store.getItem(CHIP_PREF_KEY) === "off" ? "off" : "auto";
  } catch {
    return "auto";
  }
}

/** Remembers the choice: Off is written, Auto removes the entry (so a full storage cannot keep Off on). A value that is
 *  neither is not a choice and writes nothing. Never throws. */
export function writeChipPref(store: StorageLike | null, pref: ChipPref): void {
  if (!store || (pref !== "off" && pref !== "auto")) return;
  try {
    if (pref === "off") store.setItem(CHIP_PREF_KEY, "off");
    else store.removeItem(CHIP_PREF_KEY);
    unwritten.delete(store);
  } catch {
    unwritten.set(store, pref);
  }
}
