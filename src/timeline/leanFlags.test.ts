// What the six remote switches mean TOGETHER (Phase 3a), over every state they can be in: `readLeanFlags` is the one place the switches become the builder's options.
// The zoom mask needs the held pictures: on the reported reel the mask alone peaked above 0.27.0 and above the app's limit for the export, and the held pictures
// repay it, so no state of the switches may leave the mask on without them.
import { afterEach, describe, expect, it } from "vitest";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { LEAN_FLAG_NAMES, readLeanFlags } from "./leanOptions";
import { LEAN_FIXES, type LeanFix } from "./leanRecord";

/** Every state of the six switches: 2^6 = 64 sets of the ones that are on. */
const STATES: ReadonlyArray<ReadonlySet<LeanFix>> = Array.from(
  { length: 1 << LEAN_FIXES.length },
  (_unused, bits) => new Set(LEAN_FIXES.filter((_fix, index) => (bits >> index) & 1)),
);

function setSwitches(on: ReadonlySet<LeanFix>): void {
  for (const fix of LEAN_FIXES) __setExportFlag(LEAN_FLAG_NAMES[fix] as never, on.has(fix));
}
const named = (on: ReadonlySet<LeanFix>): string => `switches on: [${[...on].join(", ")}]`;

describe("readLeanFlags over every state of the six switches", () => {
  afterEach(() => __resetExportFlags());

  it("walks all 64 states", () => {
    expect(STATES).toHaveLength(64);
  });

  it("is disable-only: no fix is on whose own switch is off", () => {
    for (const on of STATES) {
      setSwitches(on);
      const got = readLeanFlags();
      for (const fix of LEAN_FIXES)
        if (got[fix]) expect(on.has(fix), `${fix}, ${named(on)}`).toBe(true);
    }
  });

  it("never leaves the zoom mask on without the held pictures", () => {
    for (const on of STATES) {
      setSwitches(on);
      const got = readLeanFlags();
      if (got.zoom) expect(got.stills, named(on)).toBe(true);
    }
  });

  it("couples nothing else: every other fix is exactly its own switch, and the zoom is exactly its own switch while the held pictures are on", () => {
    for (const on of STATES) {
      setSwitches(on);
      const got = readLeanFlags();
      for (const fix of LEAN_FIXES) {
        if (fix === "zoom" && !on.has("stills")) continue;
        expect(got[fix], `${fix}, ${named(on)}`).toBe(on.has(fix));
      }
    }
  });

  it("the shipping state, every switch on (the compiled default), turns all six on", () => {
    __resetExportFlags();
    expect(readLeanFlags()).toEqual({
      zoom: true,
      fades: true,
      dip: true,
      stills: true,
      grade: true,
      decoders: true,
    });
  });
});
