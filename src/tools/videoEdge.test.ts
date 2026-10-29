// How big a clip is when it is uploaded for a video question. A clip LONGER than a minute is encoded at 480p, a shorter
// one stays 720p. The A/B behind the rule (3 clips x 720/480/360, 4 fps, the production video path): Gemini input tokens
// were identical at every size, the on-screen code was read perfectly at every size, and the file was 46-50% smaller at
// 480p. The upload (and the memory it costs on the server) is what the rule saves; an unknown length keeps the old size.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LONG_CLIP_EDGE, LONG_CLIP_SECONDS, SHORT_CLIP_EDGE, videoEdgeFor } from "./videoEdge";

describe("videoEdgeFor", () => {
  it.each([
    [0, 720],
    [5, 720],
    [59.9, 720],
    [60, 720], // "longer than 60 s": exactly a minute is still short
    [60.001, 480],
    [61, 480],
    [600, 480],
    [1800, 480],
  ])("a %s s clip is encoded at %sp", (seconds, edge) => expect(videoEdgeFor(seconds)).toBe(edge));

  it.each([null, undefined, Number.NaN, -5, Number.POSITIVE_INFINITY])(
    "keeps the old size when the length is not a usable number (%s)",
    (value) => expect(videoEdgeFor(value as number | null | undefined)).toBe(SHORT_CLIP_EDGE),
  );

  it("is the rule, for any length: 480 exactly when the clip is longer than the limit, never anything else", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100_000, noNaN: true }), (seconds) => {
        const edge = videoEdgeFor(seconds);
        expect([LONG_CLIP_EDGE, SHORT_CLIP_EDGE]).toContain(edge);
        expect(edge === LONG_CLIP_EDGE).toBe(seconds > LONG_CLIP_SECONDS);
      }),
      { numRuns: 300 },
    );
  });

  it("never gives a longer clip a larger picture than a shorter one", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 10_000, noNaN: true }), fc.double({ min: 0, max: 10_000, noNaN: true }), (a, b) => {
        const [short, long] = a <= b ? [a, b] : [b, a];
        expect(videoEdgeFor(long)).toBeLessThanOrEqual(videoEdgeFor(short));
      }),
    );
  });
});
