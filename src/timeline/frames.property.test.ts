// Property tests for the frame/second projection.
//
// This module is where the contract's ONE hard rule lives: callers speak PROJECT
// FRAMES, the validator works in seconds, and the conversion between them must be
// total (no key silently missed, no key wrongly converted) and non-destructive
// (the caller's timeline is never mutated). Both failure directions matter — a
// coordinate left in frames validates against the wrong scale, and a non-coordinate
// converted by mistake corrupts unrelated data.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { OpError } from "./errors";
import { canvasFps, isNum, newId, parseTimestamp, toFrames, toSecondsView } from "./frames";
import type { Timeline } from "./model";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const fpsArb = fc.constantFrom(23.976, 24, 25, 29.97, 30, 50, 59.94, 60);

describe("toFrames", () => {
  it("rounds any number to a whole frame and is then idempotent", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fpsArb, (v, fps) => {
        const once = toFrames(v, fps);
        expect(Number.isInteger(once)).toBe(true);
        expect(toFrames(once, fps)).toBe(once);
      }),
      { numRuns: 400 },
    );
  });

  it("round-trips an integer through its own string form", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e6, max: 1e6 }), fpsArb, (n, fps) => {
        expect(toFrames(String(n), fps)).toBe(n);
      }),
      { numRuns: 300 },
    );
  });

  it("reads a timecode as SECONDS scaled by fps (never as a frame count)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
        fpsArb,
        (mm, ss, fps) => {
          const got = toFrames(`${mm}:${String(ss).padStart(2, "0")}`, fps);
          expect(got).toBe(Math.round((mm * 60 + ss) * fps));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("REJECTS a boolean — `true` must never silently become frame 1", () => {
    expect(() => toFrames(true, 30)).toThrow(OpError);
    expect(() => toFrames(false, 30)).toThrow(OpError);
  });

  it("rejects anything that isn't a time, rather than coercing it", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.object(),
          fc.array(fc.integer()),
          fc.string().filter((s) => !/^\s*[+-]?\d+\s*$/.test(s) && !s.includes(":")),
        ),
        (bad) => {
          expect(() => toFrames(bad, 30)).toThrow(OpError);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("names the unit in its rejection so the model can self-correct", () => {
    expect(() => toFrames("2.5s", 30)).toThrow(/PROJECT\s+FRAMES/i);
  });
});

describe("parseTimestamp", () => {
  it("accumulates sexagesimally for both MM:SS and H:MM:SS", () => {
    expect(parseTimestamp("1:00")).toBe(60);
    expect(parseTimestamp("1:00:00")).toBe(3600);
    expect(parseTimestamp("0:01:30.5")).toBeCloseTo(90.5);
  });

  it("passes a bare number straight through", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (n) => {
        expect(parseTimestamp(n)).toBe(n);
      }),
      { numRuns: 200 },
    );
  });

  it("throws on too few or too many segments instead of guessing", () => {
    expect(() => parseTimestamp("1:2:3:4")).toThrow(OpError);
    expect(() => parseTimestamp("abc")).toThrow(OpError);
    expect(() => parseTimestamp("1:xx")).toThrow(OpError);
  });
});

describe("canvasFps", () => {
  it("returns the canvas fps when it is usable", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 1000, noNaN: true }), (fps) => {
        expect(canvasFps({ canvas: { fps } } as Any)).toBe(fps);
      }),
      { numRuns: 200 },
    );
  });

  it("falls back to 30 for every unusable fps rather than dividing by zero", () => {
    for (const bad of [0, -1, NaN, undefined, null, "abc", {}]) {
      expect(canvasFps({ canvas: { fps: bad } } as Any)).toBe(30);
    }
    expect(canvasFps({} as Any)).toBe(30);
  });
});

describe("isNum / newId", () => {
  it("isNum accepts only real numbers", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(isNum(v)).toBe(typeof v === "number" && !Number.isNaN(v));
      }),
      { numRuns: 400 },
    );
  });

  it("newId always yields prefix_8hex", () => {
    fc.assert(
      fc.property(fc.constantFrom("clip", "track", "x"), (p) => {
        expect(newId(p)).toMatch(new RegExp(`^${p}_[0-9a-f]{8}$`));
      }),
      { numRuns: 200 },
    );
  });
});

// ── the projection ──────────────────────────────────────────────────────────

const COORD_KEYS = ["source_in", "source_out", "timeline_in", "timeline_out", "duration"];

const clipArb = fc.record({
  id: fc.string({ minLength: 1 }),
  timeline_in: fc.integer({ min: 0, max: 10000 }),
  timeline_out: fc.integer({ min: 1, max: 20000 }),
  source_in: fc.integer({ min: 0, max: 10000 }),
  source_out: fc.integer({ min: 1, max: 20000 }),
  opacity: fc.double({ min: 0, max: 1, noNaN: true }),
  label: fc.string(),
});

const timelineArb = fc
  .record({
    fps: fpsArb,
    clips: fc.array(clipArb, { maxLength: 6 }),
  })
  .map(
    ({ fps, clips }) =>
      ({
        units: "frames",
        canvas: { width: 1080, height: 1920, fps },
        tracks: [{ id: "v1", kind: "video", z: 0, clips }],
      }) as unknown as Timeline,
  );

describe("toSecondsView", () => {
  it("divides EVERY coordinate key by fps and leaves every other number alone", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        const fps = tl.canvas!.fps as number;
        const view = toSecondsView(tl) as Any;
        const before = (tl as Any).tracks[0].clips;
        const after = view.tracks[0].clips;
        after.forEach((c: Any, i: number) => {
          for (const k of COORD_KEYS) {
            if (typeof before[i][k] === "number") expect(c[k]).toBeCloseTo(before[i][k] / fps, 9);
          }
          expect(c.opacity).toBe(before[i].opacity); // not a coordinate
          expect(c.label).toBe(before[i].label);
          expect(c.id).toBe(before[i].id);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("never mutates the caller's timeline (the frames copy stays authoritative)", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        const snapshot = JSON.stringify(tl);
        toSecondsView(tl);
        expect(JSON.stringify(tl)).toBe(snapshot);
      }),
      { numRuns: 300 },
    );
  });

  it("drops the units marker so the view can't be converted twice", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        expect((toSecondsView(tl) as Any).units).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it("is the identity for a timeline that is already in seconds", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        const seconds = { ...tl, units: "seconds" } as Timeline;
        expect(toSecondsView(seconds)).toBe(seconds);
      }),
      { numRuns: 200 },
    );
  });

  it("keeps the canvas fps in fps (it is not a coordinate)", () => {
    fc.assert(
      fc.property(timelineArb, (tl) => {
        expect((toSecondsView(tl) as Any).canvas.fps).toBe(tl.canvas!.fps);
      }),
      { numRuns: 200 },
    );
  });

  it("converts keyframe times too — an animation must not stay in frames", () => {
    fc.assert(
      fc.property(
        fpsArb,
        fc.array(
          fc.record({
            t: fc.integer({ min: 0, max: 600 }),
            v: fc.double({ noNaN: true, min: 0, max: 1 }),
          }),
          {
            minLength: 1,
            maxLength: 5,
          },
        ),
        (fps, kfs) => {
          const tl = {
            units: "frames",
            canvas: { fps },
            tracks: [{ id: "v1", kind: "video", z: 0, clips: [{ id: "c", opacity: kfs }] }],
          } as unknown as Timeline;
          const out = (toSecondsView(tl) as Any).tracks[0].clips[0].opacity;
          out.forEach((k: Any, i: number) => {
            expect(k.t).toBeCloseTo(kfs[i].t / fps, 9);
            expect(k.v).toBe(kfs[i].v); // the VALUE is not a time
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it("converts a coordinate no matter how deeply it is nested", () => {
    const tl = {
      units: "frames",
      canvas: { fps: 30 },
      tracks: [
        { id: "v1", kind: "video", z: 0, clips: [{ id: "c", meta: { nested: { duration: 60 } } }] },
      ],
    } as unknown as Timeline;
    expect((toSecondsView(tl) as Any).tracks[0].clips[0].meta.nested.duration).toBeCloseTo(2);
  });

  it("leaves a non-numeric coordinate untouched instead of producing NaN", () => {
    const tl = {
      units: "frames",
      canvas: { fps: 30 },
      tracks: [{ id: "v1", kind: "video", z: 0, clips: [{ id: "c", duration: "later" }] }],
    } as unknown as Timeline;
    expect((toSecondsView(tl) as Any).tracks[0].clips[0].duration).toBe("later");
  });

  it("never produces a non-finite coordinate", () => {
    // Walk the VALUES. `JSON.stringify` renders a numeric NaN/Infinity as `null`, so a regex
    // over the serialized text could never catch the thing this is named after — all it could
    // ever match was a STRING containing those letters, which a generated label eventually did.
    const numbers = function* (v: unknown, path = "$"): Generator<[string, number]> {
      if (typeof v === "number") yield [path, v];
      else if (Array.isArray(v))
        for (const [i, x] of v.entries()) yield* numbers(x, `${path}[${i}]`);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) yield* numbers(x, `${path}.${k}`);
    };
    fc.assert(
      fc.property(timelineArb, (tl) => {
        for (const [path, n] of numbers(toSecondsView(tl))) {
          expect(Number.isFinite(n), `${path} = ${n}`).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
