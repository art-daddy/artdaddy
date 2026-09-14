// Property tests for the animation algebra.
//
// The load-bearing invariant of this module is PARITY: `sampleAnim` drives the
// WebGL preview and `compileAnim` drives the ffmpeg export, and the two must agree
// for every keyframe curve — otherwise the user sees one animation and ships
// another. Example-based tests cannot cover that; so this file evaluates the
// compiled ffmpeg expression with a small interpreter for the subset the compiler
// emits (if / lt / clip / pow + arithmetic) and asserts it tracks the sampler.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { compileAnim, fadeMul, sampleAnim } from "./anim";
import type { Keyframe } from "./model";

const EASES = [
  undefined,
  "linear",
  "hold",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "nonsense",
] as const;

/** Strictly increasing keyframe times (frames), so no segment has zero span. */
const keyframesArb = fc
  .array(
    fc.record({
      gap: fc.integer({ min: 1, max: 40 }),
      v: fc.double({ min: -500, max: 500, noNaN: true }),
      ease: fc.constantFrom(...EASES),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((rows) => {
    let t = 0;
    return rows.map((r, i) => {
      t = i === 0 ? 0 : t + r.gap;
      const kf: Keyframe = { t, v: r.v };
      if (r.ease) kf.ease = r.ease as Keyframe["ease"];
      return kf;
    });
  });

// ── a tiny evaluator for the ffmpeg expression subset compileAnim emits ──────

function evalExpr(src: string, T: number): number {
  let i = 0;
  const skip = (): void => {
    while (i < src.length && src[i] === " ") i += 1;
  };
  const atom = (): number => {
    skip();
    if (src[i] === "(") {
      i += 1;
      const v = add();
      skip();
      i += 1; // ")"
      return v;
    }
    const fn = /^(if|lt|clip|pow)\(/.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      const args: number[] = [];
      for (;;) {
        args.push(add());
        skip();
        if (src[i] === ",") {
          i += 1;
          continue;
        }
        i += 1; // ")"
        break;
      }
      switch (fn[1]) {
        case "if":
          return args[0] ? args[1] : args[2];
        case "lt":
          return args[0] < args[1] ? 1 : 0;
        case "clip":
          return Math.min(Math.max(args[0], args[1]), args[2]);
        default:
          return Math.pow(args[0], args[1]);
      }
    }
    if (src[i] === "T") {
      i += 1;
      return T;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (!num) throw new Error(`unparsable at ${i}: ${src.slice(i, i + 30)}`);
    i += num[0].length;
    return Number(num[0]);
  };
  const unary = (): number => {
    skip();
    if (src[i] === "-") {
      i += 1;
      return -unary();
    }
    if (src[i] === "+") {
      i += 1;
      return unary();
    }
    return atom();
  };
  const mul = (): number => {
    let v = unary();
    for (;;) {
      skip();
      if (src[i] === "*") {
        i += 1;
        v *= unary();
      } else if (src[i] === "/") {
        i += 1;
        v /= unary();
      } else return v;
    }
  };
  const add = (): number => {
    let v = mul();
    for (;;) {
      skip();
      if (src[i] === "+") {
        i += 1;
        v += mul();
      } else if (src[i] === "-") {
        i += 1;
        v -= mul();
      } else return v;
    }
  };
  return add();
}

describe("the expression evaluator itself is trustworthy", () => {
  it("evaluates the constructs compileAnim emits", () => {
    expect(evalExpr("3.500000", 0)).toBeCloseTo(3.5);
    expect(evalExpr("T", 7)).toBe(7);
    expect(evalExpr("(T-2.000000)", 7)).toBeCloseTo(5);
    expect(evalExpr("if(lt(T,5.000000),1.000000,2.000000)", 4)).toBeCloseTo(1);
    expect(evalExpr("if(lt(T,5.000000),1.000000,2.000000)", 6)).toBeCloseTo(2);
    expect(evalExpr("clip(T,0,1)", 5)).toBe(1);
    expect(evalExpr("clip(T,0,1)", -5)).toBe(0);
    expect(evalExpr("pow(T,2)", 3)).toBe(9);
    expect(evalExpr("(1-pow(1-T,2))", 0)).toBe(0);
    expect(evalExpr("(pow(T,2)*(3-2*T))", 1)).toBeCloseTo(1);
  });
});

describe("sampleAnim invariants", () => {
  it("never leaves the range of its keyframe values (no easing overshoot)", () => {
    fc.assert(
      fc.property(keyframesArb, fc.double({ min: -100, max: 400, noNaN: true }), (kfs, at) => {
        const lo = Math.min(...kfs.map((k) => k.v));
        const hi = Math.max(...kfs.map((k) => k.v));
        const got = sampleAnim(kfs, at);
        expect(got).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(got).toBeLessThanOrEqual(hi + 1e-9);
      }),
      { numRuns: 400 },
    );
  });

  it("lands exactly on each keyframe value at its own time (every ease is 0→0, 1→1)", () => {
    fc.assert(
      fc.property(keyframesArb, (kfs) => {
        for (const k of kfs) expect(sampleAnim(kfs, k.t)).toBeCloseTo(k.v, 9);
      }),
      { numRuns: 300 },
    );
  });

  it("holds flat outside the keyframe range", () => {
    fc.assert(
      fc.property(keyframesArb, fc.double({ min: 1, max: 1e6, noNaN: true }), (kfs, d) => {
        const first = kfs[0];
        const last = kfs[kfs.length - 1];
        expect(sampleAnim(kfs, first.t - d)).toBeCloseTo(first.v, 9);
        expect(sampleAnim(kfs, last.t + d)).toBeCloseTo(last.v, 9);
      }),
      { numRuns: 300 },
    );
  });

  it("is monotone between two keyframes for every easing mode", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.integer({ min: 1, max: 120 }),
        fc.constantFrom(...EASES),
        (v0, v1, span, ease) => {
          const kfs = [
            { t: 0, v: v0, ...(ease ? { ease } : {}) },
            { t: span, v: v1 },
          ] as Keyframe[];
          const up = v1 >= v0;
          let prev = sampleAnim(kfs, 0);
          for (let t = 1; t <= span; t += 1) {
            const cur = sampleAnim(kfs, t);
            if (up) expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
            else expect(cur).toBeLessThanOrEqual(prev + 1e-9);
            prev = cur;
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a bare number is constant, and an empty/undefined curve falls back", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        (v, at) => {
          expect(sampleAnim(v, at)).toBe(v);
          expect(sampleAnim(undefined, at, v)).toBe(v);
          expect(sampleAnim([], at, v)).toBe(v);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never returns a non-finite value", () => {
    fc.assert(
      fc.property(keyframesArb, fc.double({ min: -1e5, max: 1e5, noNaN: true }), (kfs, at) => {
        expect(Number.isFinite(sampleAnim(kfs, at))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });
});

// THE parity law: what the user previews is what the export renders.
describe("compileAnim ↔ sampleAnim parity", () => {
  it("the compiled ffmpeg expression tracks the sampler across the whole curve", () => {
    fc.assert(
      fc.property(keyframesArb, (kfs) => {
        const expr = compileAnim(kfs, "T");
        const last = kfs[kfs.length - 1].t;
        for (let t = -5; t <= last + 5; t += 1) {
          expect(evalExpr(expr, t)).toBeCloseTo(sampleAnim(kfs, t), 3);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("parity holds with a clip offset applied", () => {
    fc.assert(
      fc.property(keyframesArb, fc.double({ min: 0, max: 30, noNaN: true }), (kfs, offset) => {
        const expr = compileAnim(kfs, "T", offset);
        const last = kfs[kfs.length - 1].t;
        // compileAnim BAKES the offset in at 6 decimal places, so the expression's idea of
        // "clip-relative now" is `T - round6(offset)` — up to a microsecond away from `rel`. Give
        // the sampler that same instant, otherwise this compares the two at slightly different
        // times and calls the difference a parity failure. It bit twice: a segment steep enough
        // (500 over one frame) turns a microsecond into more than the tolerance, and a `hold`
        // turns it into the step's full height.
        const quantised = Number(offset.toFixed(6));
        for (let rel = -1; rel <= last + 1; rel += 1) {
          const seen = rel + offset - quantised;
          expect(evalExpr(expr, rel + offset)).toBeCloseTo(sampleAnim(kfs, seen), 3);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a constant compiles to a plain number, and one keyframe to its value", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e4, max: 1e4, noNaN: true }), (v) => {
        expect(evalExpr(compileAnim(v, "T"), 0)).toBeCloseTo(v, 5);
        expect(evalExpr(compileAnim([{ t: 12, v }], "T"), 99)).toBeCloseTo(v, 5);
      }),
      { numRuns: 200 },
    );
  });

  it("never emits NaN or Infinity into the ffmpeg command", () => {
    fc.assert(
      fc.property(keyframesArb, fc.double({ min: -50, max: 50, noNaN: true }), (kfs, offset) => {
        expect(compileAnim(kfs, "T", offset)).not.toMatch(/NaN|Infinity/);
      }),
      { numRuns: 300 },
    );
  });
});

describe("fadeMul", () => {
  const t = fc.double({ min: -50, max: 400, noNaN: true });
  const dur = fc.double({ min: 1, max: 300, noNaN: true });
  const fade = fc.double({ min: 0, max: 200, noNaN: true });

  it("is always a legal alpha in [0,1]", () => {
    fc.assert(
      fc.property(t, dur, fade, fade, (rel, d, fin, fout) => {
        const m = fadeMul(rel, d, fin, fout);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(1);
        expect(Number.isFinite(m)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("with no fades the clip is fully opaque everywhere", () => {
    fc.assert(
      fc.property(t, dur, (rel, d) => {
        expect(fadeMul(rel, d, 0, 0)).toBe(1);
      }),
      { numRuns: 200 },
    );
  });

  it("starts fully transparent on a fade-in and ends transparent on a fade-out", () => {
    fc.assert(
      fc.property(dur, fc.double({ min: 0.5, max: 100, noNaN: true }), (d, f) => {
        expect(fadeMul(0, d, f, 0)).toBe(0);
        expect(fadeMul(d, d, 0, f)).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("rises over the fade-in and falls over the fade-out (never flickers)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 300 }), fc.integer({ min: 1, max: 8 }), (d, fin) => {
        fc.pre(fin * 2 < d);
        let prev = fadeMul(0, d, fin, 0);
        for (let rel = 1; rel <= fin; rel += 1) {
          const cur = fadeMul(rel, d, fin, 0);
          expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = cur;
        }
        expect(fadeMul(fin, d, fin, 0)).toBeCloseTo(1, 9);
      }),
      { numRuns: 200 },
    );
  });

  it("overlapping fades take the MINIMUM, never a value above either envelope", () => {
    fc.assert(
      fc.property(t, dur, fade, fade, (rel, d, fin, fout) => {
        const both = fadeMul(rel, d, fin, fout);
        expect(both).toBeLessThanOrEqual(fadeMul(rel, d, fin, 0) + 1e-12);
        expect(both).toBeLessThanOrEqual(fadeMul(rel, d, 0, fout) + 1e-12);
      }),
      { numRuns: 400 },
    );
  });
});
