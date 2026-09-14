// Property/fuzz tests for transition parsing + progress.
//
// `parseTransitionIn` reads UNTRUSTED shape: the model writes `transition_in`, and
// a malformed one must degrade to "no transition", never to a NaN duration that
// reaches the render plan. So the fuzz runs both directions — nothing malformed
// survives as a transition, and nothing well-formed is silently dropped.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { Clip } from "./model";
import {
  assertNever,
  parseTransitionIn,
  TRANSITION_KINDS,
  TRANSITION_LABELS,
  transitionProgress,
  type TransitionIn,
} from "./transition";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const clipWith = (transition_in: unknown): Clip => ({ id: "c", transition_in }) as unknown as Clip;

describe("parseTransitionIn — nothing malformed survives", () => {
  it("never throws, whatever it is handed", () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        expect(() => parseTransitionIn(clipWith(junk))).not.toThrow();
      }),
      { numRuns: 600 },
    );
  });

  it("returns null or a transition with a POSITIVE finite duration — never NaN", () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        const got = parseTransitionIn(clipWith(junk));
        if (got !== null) {
          expect(Number.isFinite(got.duration)).toBe(true);
          expect(got.duration).toBeGreaterThan(0);
          expect(typeof got.kind).toBe("string");
          expect(got.kind.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 600 },
    );
  });

  it("rejects a non-positive, NaN or infinite duration", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRANSITION_KINDS),
        fc.constantFrom(0, -1, -0.5, NaN, Infinity, -Infinity),
        (kind, duration) => {
          expect(parseTransitionIn(clipWith({ kind, duration }))).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects a duration that isn't a number (a string frame count is not a frame count)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRANSITION_KINDS),
        fc.oneof(fc.string(), fc.boolean(), fc.constant(null), fc.object()),
        (kind, duration) => {
          expect(parseTransitionIn(clipWith({ kind, duration }))).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rejects a missing or empty kind", () => {
    for (const kind of ["", null, undefined, 3, {}]) {
      expect(parseTransitionIn(clipWith({ kind, duration: 15 }))).toBeNull();
    }
  });

  it("returns null for an absent clip or absent transition", () => {
    expect(parseTransitionIn(null)).toBeNull();
    expect(parseTransitionIn(undefined)).toBeNull();
    expect(parseTransitionIn({ id: "c" } as unknown as Clip)).toBeNull();
  });
});

describe("parseTransitionIn — nothing legitimate is dropped", () => {
  it("accepts every contract kind with a positive duration and preserves both", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRANSITION_KINDS),
        fc.double({ min: 0.001, max: 600, noNaN: true }),
        (kind, duration) => {
          expect(parseTransitionIn(clipWith({ kind, duration }))).toEqual({ kind, duration });
        },
      ),
      { numRuns: 300 },
    );
  });

  it("carries `expr` through only when it is a string", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (expr) => {
        expect(parseTransitionIn(clipWith({ kind: "custom", duration: 10, expr }))).toEqual({
          kind: "custom",
          duration: 10,
          expr,
        });
      }),
      { numRuns: 200 },
    );
    expect(parseTransitionIn(clipWith({ kind: "custom", duration: 10, expr: 42 }))).toEqual({
      kind: "custom",
      duration: 10,
    });
  });

  it("ignores unknown extra keys rather than failing the whole transition", () => {
    expect(parseTransitionIn(clipWith({ kind: "crossfade", duration: 12, wat: 1 }))).toEqual({
      kind: "crossfade",
      duration: 12,
    });
  });
});

describe("transitionProgress", () => {
  const t = (duration: number): TransitionIn => ({ kind: "crossfade", duration });

  it("is null outside the window and a legal [0,1] factor inside it", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 600, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (dur, rel) => {
          const p = transitionProgress(t(dur), rel);
          if (rel < 0 || rel > dur) {
            expect(p).toBeNull();
          } else {
            expect(p).not.toBeNull();
            expect(p!).toBeGreaterThanOrEqual(0);
            expect(p!).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 600 },
    );
  });

  it("runs 0 → 1 across the window, hitting both ends exactly", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 600, noNaN: true }), (dur) => {
        expect(transitionProgress(t(dur), 0)).toBe(0);
        expect(transitionProgress(t(dur), dur)).toBeCloseTo(1, 9);
      }),
      { numRuns: 300 },
    );
  });

  it("never goes backwards as the playhead advances (no flicker mid-blend)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 240 }), (dur) => {
        let prev = -1;
        for (let rel = 0; rel <= dur; rel += 1) {
          const p = transitionProgress(t(dur), rel)!;
          expect(p).toBeGreaterThanOrEqual(prev);
          prev = p;
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is null for no transition or a non-positive duration", () => {
    expect(transitionProgress(null, 0)).toBeNull();
    expect(transitionProgress({ kind: "crossfade", duration: 0 }, 0)).toBeNull();
    expect(transitionProgress({ kind: "crossfade", duration: -5 }, 0)).toBeNull();
  });
});

describe("contract drift guards", () => {
  it("every declared kind has an inspector label (a new kind can't ship unlabelled)", () => {
    for (const k of TRANSITION_KINDS) {
      expect(TRANSITION_LABELS[k], `no label for "${k}"`).toBeTypeOf("string");
      expect(TRANSITION_LABELS[k].length).toBeGreaterThan(0);
    }
    expect(Object.keys(TRANSITION_LABELS).sort()).toEqual([...TRANSITION_KINDS].sort());
  });

  it("assertNever throws if an unhandled kind ever reaches a switch at runtime", () => {
    expect(() => assertNever("whip-2" as never)).toThrow(/unhandled transition kind/);
  });

  it("a kind outside the contract still parses (the plan coerces it) but is named", () => {
    // The parser is deliberately permissive on `kind`; the render plan is what
    // coerces an unknown kind to crossfade. Pinning this stops a future "tighten
    // the parser" change from silently dropping a transition instead.
    const got = parseTransitionIn(clipWith({ kind: "not-a-real-kind", duration: 10 }));
    expect(got).toEqual({ kind: "not-a-real-kind", duration: 10 });
    expect((TRANSITION_KINDS as readonly string[]).includes((got as Any).kind)).toBe(false);
  });
});
