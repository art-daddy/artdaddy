// Property tests over the band's axis. It is two functions, but they are the ONE place that
// answers "which pixel is this level" for the line, the key handles and the commit — so the
// rule that matters is that they are each other's inverse, not that either has a nice formula.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { bandFrac, bandGain, MAX_BAND_GAIN } from "./volumeBand";

const gain = fc.double({ min: 0, max: MAX_BAND_GAIN, noNaN: true });
const frac = fc.double({ min: 0, max: 1, noNaN: true });

describe("volume band axis", () => {
  it("round-trips a level through a position and back", () => {
    fc.assert(
      fc.property(gain, (g) => {
        expect(bandGain(bandFrac(g))).toBeCloseTo(g, 9);
      }),
    );
  });

  it("round-trips a position through a level and back", () => {
    fc.assert(
      fc.property(frac, (f) => {
        expect(bandFrac(bandGain(f))).toBeCloseTo(f, 9);
      }),
    );
  });

  it("is monotonic: louder is never LOWER on the band", () => {
    // The scenario "clicking low makes a quieter key than clicking high" depends on this, and a
    // sign flip would pass a round-trip test while inverting the whole gesture. Non-strict
    // because two levels a denormal apart genuinely land on the same pixel fraction.
    fc.assert(
      fc.property(gain, gain, (a, b) => {
        if (a > b) expect(bandFrac(a)).toBeLessThanOrEqual(bandFrac(b));
      }),
    );
  });

  it("...and a MEANINGFUL difference in level is a real difference in position", () => {
    // The non-strict rule above would also hold for a constant function, so pin that levels
    // far enough apart to matter actually separate.
    fc.assert(
      fc.property(fc.double({ min: 0, max: MAX_BAND_GAIN - 0.01, noNaN: true }), (a) => {
        expect(bandFrac(a + 0.01)).toBeLessThan(bandFrac(a));
      }),
    );
  });

  it("pins the ends and clamps beyond them", () => {
    expect(bandFrac(0)).toBe(1); // silence at the bottom
    expect(bandFrac(MAX_BAND_GAIN)).toBe(0); // loudest at the top
    expect(bandFrac(MAX_BAND_GAIN * 5)).toBe(0); // a louder-than-band value still draws in range
    expect(bandFrac(-3)).toBe(1);
    expect(bandGain(-1)).toBe(MAX_BAND_GAIN);
    expect(bandGain(9)).toBe(0);
  });

  it("survives a non-finite input rather than drawing at NaN", () => {
    expect(bandFrac(Number.NaN)).toBe(bandFrac(1));
    expect(bandGain(Number.NaN)).toBe(MAX_BAND_GAIN);
  });
});
