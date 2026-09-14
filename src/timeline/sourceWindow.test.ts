import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { resolveSourceWindow, touchesSourceWindow } from "./sourceWindow";

const base = {
  sourceIn: 0,
  sourceOut: 90,
  length: 90,
  speed: 1,
  speedChanged: false,
  totalFrames: null as number | null,
};

describe("resolveSourceWindow — trim vs slip", () => {
  it("a lone source_in SLIPS: same length, later content", () => {
    const r = resolveSourceWindow({ sourceIn: 30 }, base);
    expect(r.length).toBe(90);
    expect([r.sourceIn, r.sourceOut]).toEqual([30, 120]);
  });

  it("source_in + duration TRIMS: the head moves AND the clip shortens", () => {
    const r = resolveSourceWindow({ sourceIn: 30, duration: 60 }, base);
    expect(r.length).toBe(60);
    expect([r.sourceIn, r.sourceOut]).toEqual([30, 90]);
  });

  it("a lone source_out slips from the tail: the head follows, length held", () => {
    const r = resolveSourceWindow({ sourceOut: 120 }, base);
    expect(r.length).toBe(90);
    expect([r.sourceIn, r.sourceOut]).toEqual([30, 120]);
  });

  it("both edges TRIM: the window itself sets the length", () => {
    const r = resolveSourceWindow({ sourceIn: 30, sourceOut: 90 }, base);
    expect(r.length).toBe(60);
    expect([r.sourceIn, r.sourceOut]).toEqual([30, 90]);
  });

  it("both edges beat a contradicting duration, and say so", () => {
    const r = resolveSourceWindow({ sourceIn: 30, sourceOut: 90, duration: 90 }, base);
    expect(r.length).toBe(60);
    expect(r.notes.join(" ")).toContain("ignored duration=90");
  });

  it("a duration that AGREES with the window is not reported as a conflict", () => {
    const r = resolveSourceWindow({ sourceIn: 30, sourceOut: 90, duration: 60 }, base);
    expect(r.notes).toEqual([]);
  });

  it("duration alone tail-trims: the head stays where it was", () => {
    const r = resolveSourceWindow({ duration: 60 }, { ...base, sourceIn: 10, sourceOut: 100 });
    expect([r.sourceIn, r.sourceOut, r.length]).toEqual([10, 70, 60]);
  });
});

describe("resolveSourceWindow — speed", () => {
  it("a speed change alone holds the SOURCE content and rescales the length", () => {
    const r = resolveSourceWindow({}, { ...base, speed: 2, speedChanged: true });
    expect(r.length).toBe(45); // 90 source frames at 2x
    expect([r.sourceIn, r.sourceOut]).toEqual([0, 90]);
  });

  it("an explicit duration beats the speed rescale", () => {
    const r = resolveSourceWindow({ duration: 30 }, { ...base, speed: 2, speedChanged: true });
    expect(r.length).toBe(30);
    expect(r.sourceOut - r.sourceIn).toBe(60); // 30 timeline frames consume 60 at 2x
  });

  it("slipping a sped-up clip keeps its length and consumes speed-scaled source", () => {
    const r = resolveSourceWindow({ sourceIn: 30 }, { ...base, speed: 2, length: 45 });
    expect(r.length).toBe(45);
    expect([r.sourceIn, r.sourceOut]).toEqual([30, 120]);
  });
});

describe("resolveSourceWindow — source bounds", () => {
  const bounded = { ...base, totalFrames: 100 };

  it("a slip past the tail stops at the rail with its length intact", () => {
    const r = resolveSourceWindow({ sourceOut: 200 }, bounded);
    expect(r.length).toBe(90);
    expect([r.sourceIn, r.sourceOut]).toEqual([10, 100]);
    expect(r.notes.join(" ")).toContain("end of the source");
  });

  it("an EXPLICIT source_in is never moved to make room — the clip shortens instead", () => {
    const r = resolveSourceWindow({ sourceIn: 60, duration: 90 }, bounded);
    expect(r.sourceIn).toBe(60); // the head they asked for, untouched
    expect(r.sourceOut).toBe(100);
    expect(r.length).toBe(40);
    expect(r.notes.join(" ")).toContain("shortened");
  });

  it("a window longer than the whole source collapses to the whole source", () => {
    const r = resolveSourceWindow({ duration: 500 }, bounded);
    expect([r.sourceIn, r.sourceOut]).toEqual([0, 100]);
    expect(r.notes.join(" ")).toContain("only 100 frames");
  });

  it("clamps a slip off the FRONT to 0 and keeps the length", () => {
    const r = resolveSourceWindow({ sourceOut: 30 }, bounded);
    expect(r.sourceIn).toBe(0);
    expect(r.length).toBe(90);
  });

  it("an unknown source length (unprobeable / image / text) is never clamped", () => {
    const r = resolveSourceWindow({ sourceIn: 5000 }, { ...base, totalFrames: null });
    expect(r.sourceIn).toBe(5000);
    expect(r.notes).toEqual([]);
  });
});

describe("touchesSourceWindow", () => {
  it("is true only for a source edge, not for a bare duration", () => {
    expect(touchesSourceWindow({ duration: 30 })).toBe(false);
    expect(touchesSourceWindow({ sourceIn: 0 })).toBe(true);
    expect(touchesSourceWindow({ sourceOut: 30 })).toBe(true);
    expect(touchesSourceWindow({})).toBe(false);
  });
});

// ── laws ──────────────────────────────────────────────────────────────────────
// These are the rules that must survive a rewrite of the resolver, not a restatement
// of its arithmetic. Parity is the one validateTimeline enforces (TOL 0.05), so a
// violation here is an edit the engine would reject outright.

const arbState = fc.record({
  sourceIn: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }),
  length: fc.integer({ min: 1, max: 400 }),
  speed: fc.constantFrom(0.25, 0.5, 1, 1.5, 2, 4),
  speedChanged: fc.boolean(),
  totalFrames: fc.option(fc.integer({ min: 1, max: 2000 }), { nil: null }),
});

const arbReq = fc.record(
  {
    sourceIn: fc.option(fc.integer({ min: -200, max: 900 }), { nil: null }),
    sourceOut: fc.option(fc.integer({ min: -200, max: 900 }), { nil: null }),
    duration: fc.option(fc.integer({ min: 1, max: 600 }), { nil: null }),
  },
  { requiredKeys: [] },
);

/** Reject the inverted windows the tool rejects before ever calling the resolver. */
const wellFormed = (req: { sourceIn?: number | null; sourceOut?: number | null }): boolean =>
  !(typeof req.sourceIn === "number" && typeof req.sourceOut === "number") ||
  req.sourceOut > req.sourceIn;

describe("resolveSourceWindow — laws", () => {
  it("ALWAYS returns a window in parity with the length (what validateTimeline demands)", () => {
    fc.assert(
      fc.property(arbReq, arbState, (req, st) => {
        fc.pre(wellFormed(req));
        const state = { ...st, sourceOut: st.sourceIn === undefined ? undefined : st.sourceIn + 1 };
        const r = resolveSourceWindow(req, state);
        expect(r.sourceOut - r.sourceIn).toBe(Math.round(r.length * st.speed));
      }),
      { numRuns: 400 },
    );
  });

  it("ALWAYS returns a usable window: in >= 0, out > in, length >= 1", () => {
    fc.assert(
      fc.property(arbReq, arbState, (req, st) => {
        fc.pre(wellFormed(req));
        const r = resolveSourceWindow(req, { ...st, sourceOut: undefined });
        expect(r.sourceIn).toBeGreaterThanOrEqual(0);
        expect(r.sourceOut).toBeGreaterThan(r.sourceIn);
        expect(r.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 400 },
    );
  });

  it("NEVER reads past the end of a source whose length we know", () => {
    fc.assert(
      fc.property(arbReq, arbState, (req, st) => {
        fc.pre(wellFormed(req));
        const total = st.totalFrames ?? 600;
        // A source too short to cover even ONE output frame at this speed cannot
        // hold a clip at all; the resolver has no error channel, so that case is
        // out of scope rather than silently "handled".
        fc.pre(total >= Math.round(Math.max(1, Math.ceil(0.5 / st.speed)) * st.speed));
        const r = resolveSourceWindow(req, { ...st, sourceOut: undefined, totalFrames: total });
        expect(r.sourceOut).toBeLessThanOrEqual(total);
      }),
      { numRuns: 400 },
    );
  });

  it("a lone source_in NEVER changes the length (the slip law)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 1, max: 300 }),
        (sIn, length) => {
          // Unbounded source, speed 1: nothing can clamp, so only the rule applies.
          const r = resolveSourceWindow(
            { sourceIn: sIn },
            { ...base, length, sourceOut: undefined, totalFrames: null },
          );
          expect(r.length).toBe(length);
          expect(r.sourceIn).toBe(sIn);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("re-applying its own output changes nothing (idempotent at >= 1x)", () => {
    fc.assert(
      fc.property(arbReq, arbState, (req, st) => {
        fc.pre(wellFormed(req));
        // Below 1x, length -> consumed is not injective (several lengths round to
        // the same number of source frames), so a window cannot encode its length.
        // That is why a sub-1x both-edges request gets the "snapped" note.
        fc.pre(st.speed >= 1);
        const state = { ...st, sourceOut: undefined };
        const once = resolveSourceWindow(req, state);
        const twice = resolveSourceWindow(
          { sourceIn: once.sourceIn, sourceOut: once.sourceOut },
          {
            ...state,
            sourceIn: once.sourceIn,
            sourceOut: once.sourceOut,
            length: once.length,
            speedChanged: false,
          },
        );
        expect([twice.sourceIn, twice.sourceOut, twice.length]).toEqual([
          once.sourceIn,
          once.sourceOut,
          once.length,
        ]);
      }),
      { numRuns: 300 },
    );
  });
});
