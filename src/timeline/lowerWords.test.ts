// What a failed export tells the person to lower (E8-3): one sentence added where there is something true to say, and nothing where the cause is not known.
// 0.27.0's own sentences are held as literals below, copied from the words the unchanged build said, so a moved word fails here whatever the new code does.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EXPORT_REASON_CODES, type ExportReasonCode } from "../api/exportReason";
import { describeChipFailure, describeTryAgain, plainFailure } from "./exportWords";
import { describeLower } from "./lowerWords";

const PLAIN_0_27_0: Record<ExportReasonCode, string> = {
  none: "The export finished.",
  source_unavailable:
    "Some clips couldn't be read. They may have been moved or renamed, or are on a drive that is disconnected.",
  storage_unavailable:
    "ArtDaddy couldn't save to that folder. It may be read-only, the file may be open in another program, or the drive may be disconnected.",
  storage_full: "A drive ran out of space. Free up some space and try again.",
  memory_limit: "Your PC ran short of memory. Close other programs and try again.",
  time_limit: "The export took longer than ArtDaddy allows, or stopped making progress.",
  verification_failed:
    "The finished video didn't pass ArtDaddy's check, so it wasn't saved. Your project was not changed.",
  render_failed: "Something went wrong while exporting. Your project was not changed.",
  interrupted: "ArtDaddy closed while exporting. The unfinished file was removed.",
  cancelled: "The export was cancelled.",
  declined: "You chose not to continue.",
  unknown: "Something went wrong while exporting. Your project was not changed.",
};
const CHIP_0_27_0 = {
  card: "The graphics chip stopped this export. Try again uses the processor instead, which takes longer.",
  again:
    "The graphics chip stopped this export. Export it again and the processor will be used, which takes longer.",
  assistant:
    "The graphics chip stopped this export before it finished. It is set aside for a day: export again and the processor is used, which takes longer.",
} as const;

/** What each code is expected to gain. A new code added to the closed list has no row here, so this table stops compiling and the walk below fails. */
const ADVICE: Record<ExportReasonCode, "memory" | "time" | null> = {
  none: null,
  source_unavailable: null,
  storage_unavailable: null,
  storage_full: null,
  memory_limit: "memory",
  time_limit: "time",
  verification_failed: null,
  render_failed: null,
  interrupted: null,
  cancelled: null,
  declined: null,
  unknown: null,
};

const MEMORY =
  "To use less memory, lower the picture size or frame rate, or export a shorter section.";
const TIME_WITH_QUICK =
  "On this PC a lower picture size or frame rate, a shorter section, or Quick export is faster.";
const TIME_WITHOUT_QUICK =
  "On this PC a lower picture size or frame rate, or a shorter section, is faster.";
const CHIP_WITH_QUICK =
  "To make that shorter, lower the picture size or frame rate, or use Quick export.";
const CHIP_WITHOUT_QUICK = "To make that shorter, lower the picture size or frame rate.";

describe("E8-3: what to lower after a failure", () => {
  it("says the copy pack's sentence for memory, for time and for the graphics chip", () => {
    expect(describeLower({ code: "memory_limit", quick: false })).toBe(MEMORY);
    expect(describeLower({ code: "time_limit", quick: true })).toBe(TIME_WITH_QUICK);
    expect(describeLower({ code: "time_limit", quick: false })).toBe(TIME_WITHOUT_QUICK);
    expect(describeLower({ code: "verification_failed", chipFailed: true, quick: true })).toBe(
      CHIP_WITH_QUICK,
    );
    expect(describeLower({ code: "verification_failed", chipFailed: true, quick: false })).toBe(
      CHIP_WITHOUT_QUICK,
    );
  });

  it("does not name Quick for a memory failure, whether or not Quick exists", () => {
    expect(describeLower({ code: "memory_limit", quick: true })).toBe(MEMORY);
    expect(describeLower({ code: "memory_limit", quick: true })).not.toMatch(/quick/i);
  });

  it("walks every failure code of the closed list: each one gains exactly what the table says, and every other code gains nothing", () => {
    expect(Object.keys(ADVICE).sort()).toEqual([...EXPORT_REASON_CODES].sort());
    for (const code of EXPORT_REASON_CODES)
      for (const quick of [true, false]) {
        const said = describeLower({ code, quick });
        const kind = ADVICE[code];
        if (kind === "memory") expect(said, code).toBe(MEMORY);
        else if (kind === "time")
          expect(said, code).toBe(quick ? TIME_WITH_QUICK : TIME_WITHOUT_QUICK);
        else expect(said, `${code} (quick ${quick})`).toBe("");
      }
  });

  it("gives the chip's sentence for a chip failure whatever the code under it says, and nothing for a failure the chip did not cause", () => {
    for (const code of EXPORT_REASON_CODES)
      for (const quick of [true, false]) {
        expect(describeLower({ code, chipFailed: true, quick }), code).toBe(
          quick ? CHIP_WITH_QUICK : CHIP_WITHOUT_QUICK,
        );
        // not a chip failure: the flag being false or absent is the same
        expect(describeLower({ code, chipFailed: false, quick })).toBe(
          describeLower({ code, quick }),
        );
      }
  });

  it("names Quick exactly where Quick exists: a property over every code, chip state and availability", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EXPORT_REASON_CODES),
        fc.boolean(),
        fc.boolean(),
        (code, chipFailed, quick) => {
          const said = describeLower({ code, chipFailed, quick });
          const mentionsQuick = /quick/i.test(said);
          const canMentionQuick = chipFailed || code === "time_limit";
          expect(mentionsQuick).toBe(quick && canMentionQuick);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("speaks of the picture size, the frame rate and a shorter section, the things the person can change, and promises nothing", () => {
    const every: string[] = [];
    for (const code of EXPORT_REASON_CODES)
      for (const chipFailed of [true, false])
        for (const quick of [true, false]) {
          const said = describeLower({ code, chipFailed, quick });
          if (said) every.push(said);
        }
    expect(every.length).toBeGreaterThan(0);
    for (const said of every) {
      expect(said).toMatch(/picture size/);
      expect(said).toMatch(/frame rate/);
      // advice, never a promise of a result
      expect(said).not.toMatch(
        /same (pixels?|quality|picture|look)|identical|exactly|guarantee|will (finish|work|be fixed)|\d+\s*(x|times)\b/i,
      );
      expect(said).not.toMatch(/NaN|Infinity|undefined|null|\[object/);
    }
  });

  it("leaves 0.27.0's words for every failure code, and for the chip's three audiences, as they were, byte for byte", () => {
    for (const code of EXPORT_REASON_CODES)
      expect(plainFailure(code), code).toBe(PLAIN_0_27_0[code]);
    for (const audience of ["card", "again", "assistant"] as const)
      expect(describeChipFailure(audience)).toBe(CHIP_0_27_0[audience]);
    // Try again's own sentence keeps being said as it was
    expect(describeTryAgain("memory_limit", 0, 2)).toBe(
      "Try again uses a gentler setting: it needs less memory and may take longer.",
    );
    expect(describeTryAgain("time_limit", 0, 2)).toBe(
      "Try again uses a gentler setting: it needs less memory and may take longer.",
    );
  });

  it("never throws and says nothing true or false it cannot know, whatever it is given", () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        const said = describeLower(junk as never);
        expect(typeof said).toBe("string");
        expect([
          "",
          MEMORY,
          TIME_WITH_QUICK,
          TIME_WITHOUT_QUICK,
          CHIP_WITH_QUICK,
          CHIP_WITHOUT_QUICK,
        ]).toContain(said);
      }),
      { numRuns: 300 },
    );
    expect(describeLower({ code: "memory_limit" } as never)).toBe(MEMORY);
    // a code this build has never heard of is not a reason to say anything
    expect(describeLower({ code: "disk_on_fire", quick: true } as never)).toBe("");
  });
});
