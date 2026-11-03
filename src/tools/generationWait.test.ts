import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { generationWait, MAX_RETRY_S, MIN_ETA_S, MIN_RETRY_S } from "./generationWait";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const secondsAgo = (s: number): number => NOW / 1000 - s;

// The estimate is a guide for a caller that will not be told when the media lands. What must hold
// is what a caller can lean on: it is always a usable number, it does not shrink to nothing for a
// job that is overdue, and it never asks the caller to come back sooner than it is worth.
describe("generationWait", () => {
  const kind = fc.oneof(
    fc.constantFrom("image", "audio", "video"),
    fc.string(),
    fc.constant(undefined),
  );
  // Anything a catalog row could hold in `added_at`, including nonsense.
  const added = fc.oneof(
    fc.double({ min: 1, max: 4e9 }),
    fc.double(),
    fc.constantFrom(undefined, 0, -5, NaN, Infinity),
  );

  it("is a usable answer for ANY job, kind and clock: whole numbers within the stated bounds", () => {
    fc.assert(
      fc.property(
        kind,
        added,
        fc.oneof(fc.double({ min: 0, max: 5e12 }), fc.double()),
        (k, a, now) => {
          const w = generationWait({ kind: k, added_at: a as number | undefined }, now);
          expect(Number.isInteger(w.eta_s)).toBe(true);
          expect(w.eta_s).toBeGreaterThanOrEqual(MIN_ETA_S);
          expect(Number.isInteger(w.retry_after_s)).toBe(true);
          expect(w.retry_after_s).toBeGreaterThanOrEqual(MIN_RETRY_S);
          expect(w.retry_after_s).toBeLessThanOrEqual(MAX_RETRY_S);
          // Asking again is never advised for later than the job is expected to take.
          expect(w.retry_after_s).toBeLessThanOrEqual(w.eta_s);
          expect(typeof w.slow).toBe("boolean");
        },
      ),
    );
  });

  // A catalog row is a JSON file the person can edit: a kind that is the name of something every
  // object has must be just an unknown kind (found by the property above: "constructor" gave NaN).
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "treats the kind %j as an unknown kind",
    (k) => {
      const w = generationWait({ kind: k, added_at: secondsAgo(1) }, NOW);
      expect(w).toEqual(generationWait({ kind: "mystery", added_at: secondsAgo(1) }, NOW));
      expect(Number.isInteger(w.eta_s)).toBe(true);
    },
  );

  it("only ever lowers the estimate as a job ages, until it is overdue; an overdue job is never promised under a minute", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("image", "audio", "video", "other"),
        // Real ages only: a start that cannot be read is "just begun" (tested below), not an age.
        fc.double({ min: 0, max: 3_600, noNaN: true }),
        fc.double({ min: 0, max: 3_600, noNaN: true }),
        (k, x, y) => {
          const [young, old] = x <= y ? [x, y] : [y, x];
          const a = generationWait({ kind: k, added_at: secondsAgo(young) }, NOW);
          const b = generationWait({ kind: k, added_at: secondsAgo(old) }, NOW);
          if (!a.slow && !b.slow) expect(b.eta_s).toBeLessThanOrEqual(a.eta_s);
          if (b.slow) expect(b.eta_s).toBeGreaterThanOrEqual(60);
          // Once overdue, always overdue.
          if (a.slow) expect(b.slow).toBe(true);
        },
      ),
    );
  });

  it("tells a video from an image: a job just started takes longer for video, and any job is overdue after an hour", () => {
    const fresh = (k: string) => generationWait({ kind: k, added_at: secondsAgo(1) }, NOW);
    expect(fresh("video").eta_s).toBeGreaterThan(fresh("audio").eta_s);
    expect(fresh("audio").eta_s).toBeGreaterThan(fresh("image").eta_s);
    for (const k of ["image", "audio", "video", "mystery"]) {
      const w = generationWait({ kind: k, added_at: secondsAgo(3_600) }, NOW);
      expect(w.slow, k).toBe(true);
    }
  });

  it("treats a missing, zero, negative or future start as a job that has just begun, not as an error", () => {
    const begun = generationWait({ kind: "audio", added_at: secondsAgo(0) }, NOW);
    for (const bad of [undefined, 0, -10, NaN, Infinity, NOW / 1000 + 600]) {
      expect(generationWait({ kind: "audio", added_at: bad }, NOW), String(bad)).toEqual(begun);
    }
    expect(generationWait({ kind: "audio", added_at: secondsAgo(5) }, NaN).slow).toBe(false);
  });
});
