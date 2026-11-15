// The lean zoom mask's pure pieces (Phase 3a, fix 1). These tests state RULES that must survive a rewrite, not the arithmetic of the implementation:
//   - the evaluator gives the value a reference evaluator gives for every expression the exporter itself writes (anim.ts compileAnim and the cover aperture);
//   - the rectangle of a frame is EXACTLY the set of pixels the per-pixel geq of 0.27.0 keeps, checked pixel by pixel on small canvases;
//   - the mask's strips and the rectangle tile the picture with no overlap and no zero-size strip (a drawbox of size 0 means the whole frame).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileAnim } from "./anim";
import { cRound, compileLeanExpr } from "./leanExpr";
import { apertureRects, maskStream, stripsOutside, type Rect } from "./leanMasks";
import type { Animatable } from "./model";

/** The next float `ulps` steps above (positive) or below (negative) a number (test-only; the product has its own in leanExpr.ts). */
function bumped(x: number, ulps: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigInt64(
    0,
    view.getBigInt64(0) + (x > 0 === ulps > 0 ? 1n : -1n) * BigInt(Math.abs(ulps)),
  );
  return view.getFloat64(0);
}

/** The reference evaluator: the SAME text run as JavaScript (a test may; the product may not), with ffmpeg's functions defined independently.
 *  `powUlps` moves pow(x, 2), x other than 0 and 1, by that many floats: ffmpeg's own pow is the C library's and is one float off from x * x on 0.33 percent of inputs. */
function oracle(text: string, powUlps = 0): (T: number, W: number, H: number) => number {
  const fns = {
    _if: (c: number, a: number, b: number) => (c !== 0 ? a : b),
    lt: (a: number, b: number) => (a < b ? 1 : 0),
    gt: (a: number, b: number) => (a > b ? 1 : 0),
    gte: (a: number, b: number) => (a >= b ? 1 : 0),
    lte: (a: number, b: number) => (a <= b ? 1 : 0),
    max: (a: number, b: number) => Math.max(a, b),
    min: (a: number, b: number) => Math.min(a, b),
    round: (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x)),
    floor: Math.floor,
    ceil: Math.ceil,
    abs: Math.abs,
    pow: (x: number, y: number) =>
      powUlps !== 0 && y === 2 && x !== 0 && x !== 1 ? bumped(x * x, powUlps) : x ** y,
    clip: (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi),
  };
  const body = text.replace(/\bif\(/g, "_if(");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function("T", "W", "H", ...Object.keys(fns), `return (${body});`);
  return (T, W, H) => Number(f(T, W, H, ...Object.values(fns)));
}

const keyframes = fc
  .array(
    fc.record({
      t: fc.integer({ min: 0, max: 600 }).map((n) => n / 30),
      v: fc.integer({ min: 100, max: 4000 }),
      ease: fc.constantFrom("linear", "hold", "ease-in", "ease-out", "ease-in-out", undefined),
    }),
    { minLength: 2, maxLength: 5 },
  )
  .map((ks) => [...ks].sort((a, b) => a.t - b.t) as Animatable);

/** The cover aperture's two expressions, built the way render.ts builds them. */
function apertureExprs(sizeW: Animatable, sizeH: Animatable, tin: number) {
  const boxWidth = compileAnim(sizeW, "T", tin);
  const boxHeight = compileAnim(sizeH, "T", tin);
  const targetWidth = `max(2,round((${boxWidth})/2)*2)`;
  const targetHeight = `max(2,round((${boxHeight})/2)*2)`;
  const coverScale = `max((${targetWidth})/W,(${targetHeight})/H)`;
  return {
    widthExpr: `((${targetWidth})/(${coverScale}))`,
    heightExpr: `((${targetHeight})/(${coverScale}))`,
  };
}

describe("leanExpr: the safe evaluator", () => {
  it("agrees with a reference evaluator on every expression the exporter writes", () => {
    fc.assert(
      fc.property(
        keyframes,
        keyframes,
        fc.integer({ min: 0, max: 300 }).map((n) => n / 30),
        fc.integer({ min: 2, max: 4096 }),
        fc.integer({ min: 2, max: 4096 }),
        fc.integer({ min: 0, max: 900 }),
        (sizeW, sizeH, tin, W, H, frame) => {
          const { widthExpr, heightExpr } = apertureExprs(sizeW, sizeH, tin);
          const T = frame * (1 / 30);
          for (const text of [widthExpr, heightExpr]) {
            const mine = compileLeanExpr(text);
            expect(mine, text).not.toBeNull();
            const a = mine!({ T, W, H });
            const b = oracle(text)(T, W, H);
            // identical doubles, not "close": the mask must land on the same pixel as the geq
            expect(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rounds halves away from zero, as C does (and not Math.round)", () => {
    expect(cRound(0.5)).toBe(1);
    expect(cRound(-0.5)).toBe(-1);
    expect(cRound(1.5)).toBe(2);
    expect(cRound(2.5)).toBe(3);
    expect(cRound(0.49999999999999994)).toBe(0);
    expect(cRound(-2.4999999999999996)).toBe(-2);
  });

  it("refuses anything outside its subset without throwing", () => {
    for (const text of [
      "",
      "T+",
      "foo(1)",
      "if(1,2)",
      "sin(T)",
      "T^2",
      "(T",
      "T)",
      "n*2",
      "1 2",
      "lt(1,2,3)",
      "T;1",
    ])
      expect(compileLeanExpr(text), text).toBeNull();
  });

  it("evaluates precedence, unary minus and clip like ffmpeg", () => {
    const v = (text: string, T = 0) => compileLeanExpr(text)!({ T, W: 1000, H: 500 });
    expect(v("1+2*3")).toBe(7);
    expect(v("-(2)+5")).toBe(3);
    expect(v("(1-0.5)*-4")).toBe(-2);
    expect(v("clip(5,0,1)")).toBe(1);
    expect(v("clip(1,2,0)")).toBeNaN();
    expect(v("if(lt(T,1),10,20)", 0.5)).toBe(10);
    expect(v("W/H")).toBe(2);
  });
});

/** The pixels the per-pixel geq of 0.27.0 keeps, by brute force: gte(X,(W-a)/2)*lt(X,(W+a)/2)*gte(Y,(H-b)/2)*lt(Y,(H+b)/2). */
function keptByGeq(W: number, H: number, a: number, b: number): boolean[][] {
  const kept: boolean[][] = [];
  for (let y = 0; y < H; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < W; x += 1)
      row.push(x >= (W - a) / 2 && x < (W + a) / 2 && y >= (H - b) / 2 && y < (H + b) / 2);
    kept.push(row);
  }
  return kept;
}

function paint(rect: Rect, W: number, H: number): boolean[][] {
  const [x0, x1, y0, y1] = rect;
  return Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) => x >= x0 && x < x1 && y >= y0 && y < y1),
  );
}

describe("apertureRects: the rectangle is exactly what the geq keeps", () => {
  it("equals the geq's own pixel set on small canvases, for any aperture size (fractional, tiny, or a hair over the picture)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }),
        fc.integer({ min: 2, max: 40 }),
        fc.double({ min: 0, max: 1.0000001, noNaN: true }),
        fc.double({ min: 0, max: 1.0000001, noNaN: true }),
        (W, H, fa, fb) => {
          const a = fa * W;
          const b = fb * H;
          const rects = apertureRects({
            widthExpr: String(a.toFixed(12)),
            heightExpr: String(b.toFixed(12)),
            width: W,
            height: H,
            fps: 30,
            from: 0,
            to: 1,
          });
          expect(rects).not.toBeNull();
          // compare against the geq run on the SAME rounded numbers the expression text carries
          const aText = Number(a.toFixed(12));
          const bText = Number(b.toFixed(12));
          expect(paint(rects![0], W, H)).toEqual(keptByGeq(W, H, aText, bText));
        },
      ),
      { numRuns: 400 },
    );
  });

  it("covers the clip's frames plus the extra frames, each with the rectangle of its own time, always inside the picture", () => {
    const sizeW: Animatable = [
      { t: 0, v: 1000 },
      { t: 2, v: 1200 },
    ];
    const sizeH: Animatable = [
      { t: 0, v: 300 },
      { t: 2, v: 420 },
    ];
    const { widthExpr, heightExpr } = apertureExprs(sizeW, sizeH, 0);
    const rects = apertureRects({
      widthExpr,
      heightExpr,
      width: 1200,
      height: 600,
      fps: 30,
      from: 10,
      to: 40,
    })!;
    expect(rects).toHaveLength(30 + 2);
    for (const [x0, x1, y0, y1] of rects) {
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1200);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(y1).toBeLessThanOrEqual(600);
      expect(x1).toBeGreaterThan(x0);
      expect(y1).toBeGreaterThan(y0);
    }
    // the box's shape changes during this zoom, so the visible part of the picture changes with it
    expect(new Set(rects.map((r) => r.join(","))).size).toBeGreaterThan(1);
  });

  it("gives null, never a guess, for an expression it cannot evaluate or a value that is not a number", () => {
    const base = { width: 100, height: 100, fps: 30, from: 0, to: 3 };
    expect(apertureRects({ ...base, widthExpr: "sin(T)", heightExpr: "50" })).toBeNull();
    expect(apertureRects({ ...base, widthExpr: "1/0", heightExpr: "50" })).toBeNull();
    expect(apertureRects({ ...base, widthExpr: "50", heightExpr: "50", width: 0 })).toBeNull();
    expect(apertureRects({ ...base, widthExpr: "50", heightExpr: "50", to: 0 })).toBeNull();
  });

  // 16 Nov re-audit (closure G29): ffmpeg's pow(x, 2) is the C library's, one float off from x * x on 0.33 percent of inputs (measured against ffmpeg itself), and the rectangle edge ceil((W - a) / 2) moves a whole column
  // with a float when (W - a) / 2 lands on an integer. Four apertures found by a search of random ones (box sizes in whole pixels, every ease); each has a frame whose rectangle differs when pow is a float lower.
  const POW_WITNESSES: Array<{
    sizeW: Animatable;
    sizeH: Animatable;
    W: number;
    H: number;
    frame: number;
  }> = [
    {
      sizeW: [
        { t: 0, v: 709, ease: "ease-in-out" },
        { t: 3.7, v: 1985, ease: "ease-in" },
        { t: 5.9, v: 1335, ease: "ease-in-out" },
        { t: 7.3, v: 2009, ease: "ease-in" },
      ],
      sizeH: [
        { t: 0, v: 3746, ease: "hold" },
        { t: 3.3, v: 3233, ease: "ease-in-out" },
        { t: 5.1, v: 2530, ease: "ease-in-out" },
      ],
      W: 1920,
      H: 2160,
      frame: 111,
    },
    {
      sizeW: [
        { t: 0, v: 1459, ease: "ease-out" },
        { t: 0.4, v: 219, ease: "ease-in" },
        { t: 1.2, v: 2775, ease: "hold" },
      ],
      sizeH: [
        { t: 0, v: 2594, ease: "ease-out" },
        { t: 0.4, v: 389, ease: "ease-in" },
        { t: 1.2, v: 4933, ease: "hold" },
      ],
      W: 3840,
      H: 1920,
      frame: 24,
    },
    {
      sizeW: [
        { t: 0, v: 282, ease: "ease-in-out" },
        { t: 3.6, v: 3760, ease: "linear" },
      ],
      sizeH: [
        { t: 0, v: 3699, ease: "ease-out" },
        { t: 0.9333333333333333, v: 1912, ease: "ease-in-out" },
      ],
      W: 1440,
      H: 1296,
      frame: 54,
    },
    {
      sizeW: [
        { t: 0, v: 2224, ease: "ease-in-out" },
        { t: 2.4, v: 944, ease: "ease-in" },
        { t: 4.766666666666667, v: 2096, ease: "linear" },
        { t: 8.066666666666666, v: 2193, ease: "ease-out" },
      ],
      sizeH: [
        { t: 0, v: 2965, ease: "ease-out" },
        { t: 1.8333333333333333, v: 149, ease: "linear" },
      ],
      W: 3840,
      H: 1920,
      frame: 63,
    },
  ];

  it("gives null for an aperture whose rectangle on some frame depends on the last bit of pow", () => {
    for (const w of POW_WITNESSES) {
      const { widthExpr, heightExpr } = apertureExprs(w.sizeW, w.sizeH, 0);
      const input = {
        widthExpr,
        heightExpr,
        width: w.W,
        height: w.H,
        fps: 30,
        from: 0,
        to: w.frame + 1,
      };
      // the witness is real: with pow a float lower (an independent evaluator) the rectangle of that frame is another one
      const T = w.frame * (1 / 30);
      const rect = (u: number) => {
        const a = oracle(widthExpr, u)(T, w.W, w.H);
        const b = oracle(heightExpr, u)(T, w.W, w.H);
        return [
          Math.ceil((w.W - a) / 2),
          Math.ceil((w.W + a) / 2),
          Math.ceil((w.H - b) / 2),
          Math.ceil((w.H + b) / 2),
        ].join(",");
      };
      expect(rect(-1), JSON.stringify(w)).not.toBe(rect(0));
      expect(apertureRects(input), JSON.stringify(w)).toBeNull();
    }
  });

  it("never returns a rectangle that moves when pow's last bit moves (an independent evaluator with pow a float either way), and does not refuse an aperture without pow", () => {
    const check = (sizeW: Animatable, sizeH: Animatable, W: number, H: number): void => {
      const { widthExpr, heightExpr } = apertureExprs(sizeW, sizeH, 0);
      const last = Math.ceil(Math.max(...(sizeW as Array<{ t: number }>).map((k) => k.t)) * 30) + 2;
      const rects = apertureRects({
        widthExpr,
        heightExpr,
        width: W,
        height: H,
        fps: 30,
        from: 0,
        to: last,
      });
      if (rects === null) return;
      for (const u of [-1, 0, 1]) {
        const fw = oracle(widthExpr, u);
        const fh = oracle(heightExpr, u);
        rects.forEach((rect, f) => {
          const T = f * (1 / 30);
          const a = fw(T, W, H);
          const b = fh(T, W, H);
          const expected = [
            Math.min(W, Math.max(0, Math.ceil((W - a) / 2))),
            Math.min(W, Math.max(0, Math.ceil((W + a) / 2))),
            Math.min(H, Math.max(0, Math.ceil((H - b) / 2))),
            Math.min(H, Math.max(0, Math.ceil((H + b) / 2))),
          ];
          expect(
            rect,
            `frame ${f}, pow ${u} floats: ${JSON.stringify({ sizeW, sizeH, W, H })}`,
          ).toEqual(expected);
        });
      }
    };
    fc.assert(
      fc.property(
        keyframes,
        keyframes,
        fc.integer({ min: 200, max: 4000 }),
        fc.integer({ min: 200, max: 4000 }),
        check,
      ),
      {
        numRuns: 200,
        examples: POW_WITNESSES.map(
          (w) => [w.sizeW, w.sizeH, w.W, w.H] as [Animatable, Animatable, number, number],
        ),
      },
    );
    // a linear or held aperture has no pow, so there is nothing to refuse
    const linear: Animatable = [
      { t: 0, v: 1000, ease: "linear" },
      { t: 2, v: 1500, ease: "linear" },
    ];
    expect(apertureExprs(linear, linear, 0).widthExpr).not.toContain("pow(");
    const { widthExpr, heightExpr } = apertureExprs(linear, linear, 0);
    expect(
      apertureRects({ widthExpr, heightExpr, width: 1920, height: 1080, fps: 30, from: 0, to: 60 }),
    ).not.toBeNull();
  });
});

describe("maskStream: strips and rectangle tile the picture", () => {
  it("every strip has a positive size, lies inside the picture and never overlaps the rectangle or another strip", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 30 }),
        fc.integer({ min: 2, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (W, H, p, q, r, s) => {
          const x0 = Math.min(p, q, W);
          const x1 = Math.min(Math.max(p, q), W);
          const y0 = Math.min(r, s, H);
          const y1 = Math.min(Math.max(r, s), H);
          const rect: Rect = [x0, x1, y0, y1];
          const covered = Array.from({ length: H }, () => Array.from({ length: W }, () => 0));
          for (const [x, y, w, h] of stripsOutside(rect, W, H)) {
            expect(w).toBeGreaterThan(0);
            expect(h).toBeGreaterThan(0);
            expect(x).toBeGreaterThanOrEqual(0);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(x + w).toBeLessThanOrEqual(W);
            expect(y + h).toBeLessThanOrEqual(H);
            for (let j = y; j < y + h; j += 1)
              for (let i = x; i < x + w; i += 1) covered[j][i] += 1;
          }
          // strips may overlap each other at the corners (that only paints black twice), but must never touch the kept rectangle,
          // and every pixel outside the rectangle must be inside some strip
          const inside = paint(rect, W, H);
          for (let j = 0; j < H; j += 1)
            for (let i = 0; i < W; i += 1) {
              if (inside[j][i]) expect(covered[j][i]).toBe(0);
              else expect(covered[j][i]).toBeGreaterThan(0);
            }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("groups equal rectangles, gates them by the mask's own frame number and stamps the stream in project time", () => {
    const input = {
      widthExpr:
        "((max(2,round(1000/2)*2))/(max((max(2,round(1000/2)*2))/W,(max(2,round(300/2)*2))/H)))",
      heightExpr:
        "((max(2,round(300/2)*2))/(max((max(2,round(1000/2)*2))/W,(max(2,round(300/2)*2))/H)))",
      width: 1200,
      height: 600,
      fps: 30,
      from: 12,
      to: 20,
    };
    const rects = apertureRects(input)!;
    const mask = maskStream(input, rects)!;
    expect(mask.groups).toBe(1);
    expect(mask.text.startsWith("color=c=white:s=1200x600:r=30:d=")).toBe(true);
    expect(mask.text).toContain(",format=gray,");
    expect(mask.text).toContain(`enable='between(n,0,${rects.length - 1})'`);
    expect(mask.text.endsWith(",setpts=PTS+12")).toBe(true);
    // the duration is half a frame short of a whole number of frames, so that printing it cannot add one
    expect(mask.text).toMatch(new RegExp(`:d=${((rects.length - 0.5) / 30).toFixed(6)},`));
  });

  it("refuses a zoom that needs more groups than the budget instead of writing an enormous graph", () => {
    // a rectangle that changes on every frame for a long clip
    const rects: Rect[] = Array.from(
      { length: 2500 },
      (_, n) => [n % 50, 100 - (n % 50), 0, 100] as Rect,
    );
    const input = {
      widthExpr: "1",
      heightExpr: "1",
      width: 100,
      height: 100,
      fps: 30,
      from: 0,
      to: 2500,
    };
    expect(maskStream(input, rects)).toBeNull();
  });
});
