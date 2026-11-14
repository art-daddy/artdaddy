// The mask replaces the alpha plane, so the clip must keep its geq (kept: not_proven) when a chroma key or a custom effect ran before it.
// Helper H3's adversarial review of fix 1 (14 Nov, `helpers\H3-review\REVIEW.md`) wrote these tests as evidence tests: each states a RULE of the invariant
// "the picture before the encoder is 0.27.0's" (or "the export does not fail where 0.27.0 did not") and checks it against the builder's own output, with an
// independent oracle that evaluates the TEXT of 0.27.0's graph per pixel and per frame. The findings it made (chroma key, custom effects, a constant
// opacity, the per-command mask budget, a caller's `plain`, the probe deadline) are fixed and their tests now assert the fixed behaviour.
// Nothing here runs ffmpeg.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import type { CommandRunner } from "../tools/command";
import { compileAnim } from "./anim";
import { apertureRects, maskStream } from "./leanMasks";
import type { LeanOptions, LeanProbed } from "./leanOptions";
import { PROBE_DEADLINE_MS } from "./leanProbe";
import { LEAN_FIXES, LEAN_KEPT_REASONS } from "./leanRecord";
import { LEAN_MAX_MASK_CHARS } from "./leanZoom";
import type { Timeline } from "./model";
import { pixFmtHasAlpha } from "./pixelFormats";
import { buildLeanRenderCommand, buildRenderCommand } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const OUT = "/out.mp4";
const timeline = (tracks: Any[], canvas = { width: 1080, height: 1920, fps: 30 }): Timeline =>
  ({ canvas, tracks }) as Timeline;

/** A Ken-Burns cover zoom on a camera clip (a video, so no still reader is involved). */
function zoomClip(seconds: number, extra: Record<string, unknown> = {}) {
  return {
    media_ref: "/a.mp4",
    source_in: 0,
    source_out: seconds,
    timeline_in: 0,
    timeline_out: seconds,
    fit: "cover",
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: [
        { t: 0, v: 1 },
        { t: seconds, v: 1.2 },
      ],
    },
    ...extra,
  };
}
const oneClip = (extra: Record<string, unknown> = {}, seconds = 2) =>
  timeline([{ id: "v", kind: "video", z: 0, clips: [zoomClip(seconds, extra)] }]);

/** What the probe would answer for every size request the asking build made: the picture arrives as plain yuv420p, `scaled` is a size of our choosing. */
function answered(
  t: Timeline,
  scaled: readonly [number, number] = [2304, 1296],
  fmt = "yuv420p",
  options: Record<string, unknown> = {},
): { asked: LeanOptions; lean: LeanOptions } {
  const asked: LeanOptions = { zoom: true, requests: [] };
  buildRenderCommand(t, OUT, { ...options, lean: asked } as Any);
  const probed = new Map<string, LeanProbed>();
  for (const r of asked.requests ?? []) probed.set(r.key, { fmt, source: [1920, 1080], scaled });
  return { asked, lean: { zoom: true, probed } };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The oracle for questions 1 to 3 (stamping, which rectangle on which frame, order of the alpha stage). It reads the TEXT of both graphs: 0.27.0's per-pixel
// aperture `geq` (evaluated per pixel by JavaScript's own parser, not by the product's evaluator) and the lean build's mask stream (its `drawbox` groups, its
// duration and its `setpts`), and pairs them the way ffmpeg's framesync pairs alphamerge's inputs: a picture frame meets the mask frame with its own timestamp,
// the mask's last frame repeats after it ends, and a picture frame before the mask's first frame meets no mask and passes whole. For every frame the overlay
// draws, the pixels the mask keeps must be the pixels the geq keeps at that frame's time T = timestamp x (1 / fps) (the geq reads T as pts x av_q2d(time base)).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const cRoundRef = (x: number): number => {
  const whole = Math.trunc(x);
  return Math.abs(x - whole) >= 0.5 ? whole + Math.sign(x) : whole;
};
const REF_FNS: Record<string, (...a: number[]) => number> = {
  _if: (c, a, b) => (c !== 0 ? a : b),
  lt: (a, b) => (a < b ? 1 : 0),
  lte: (a, b) => (a <= b ? 1 : 0),
  gt: (a, b) => (a > b ? 1 : 0),
  gte: (a, b) => (a >= b ? 1 : 0),
  max: (a, b) => (a > b ? a : b),
  min: (a, b) => (a > b ? b : a),
  round: cRoundRef,
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs,
  pow: (x, y) => Math.pow(x, y),
  clip: (x, lo, hi) =>
    Number.isNaN(x) || Number.isNaN(lo) || Number.isNaN(hi) || lo > hi
      ? NaN
      : Math.min(Math.max(x, lo), hi),
};
const REF_NAMES = Object.keys(REF_FNS);
function compileRef(
  expr: string,
): (T: number, W: number, H: number, X: number, Y: number) => number {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function(
    "T",
    "W",
    "H",
    "X",
    "Y",
    ...REF_NAMES,
    `return (${expr.replace(/\bif\(/g, "_if(")});`,
  );
  const fns = REF_NAMES.map((n) => REF_FNS[n]);
  return (T, W, H, X, Y) => Number(f(T, W, H, X, Y, ...fns));
}
function splitTop(expr: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 0.27.0's aperture of each clip chain (by the clip's index in the graph): the four factors of its geq's alpha expression, each a function of one coordinate. */
function baselineApertures(graph: string) {
  const out = new Map<number, ReturnType<typeof compileRef>[]>();
  for (const chain of graph.split(";")) {
    const a = /:a='(alpha\(X,Y\)\*gte\(X,[^']*)'/.exec(chain)?.[1];
    const index = /\[v(\d+)\]$/.exec(chain)?.[1];
    if (a === undefined || index === undefined) continue;
    const factors = splitTop(a, "*");
    expect(factors, "the aperture is alpha times four conditions").toHaveLength(5);
    expect(factors[1] + factors[2]).not.toMatch(/\bY\b/);
    expect(factors[3] + factors[4]).not.toMatch(/\bX\b/);
    out.set(Number(index), factors.slice(1).map(compileRef));
  }
  return out;
}

/** How many frames ffmpeg's `color` source makes for `d=<text>` at `fps`: frame n exists while its time (rounded to microseconds) is under the duration. */
function sourceFrames(durationText: string, fps: number): number {
  const durationUs = Math.round(Number(durationText) * 1e6);
  let n = 0;
  while (Math.round((n * 1e6) / fps) < durationUs) n += 1;
  return n;
}

interface MaskModel {
  width: number;
  height: number;
  frames: number;
  from: number;
  boxes: Array<{ x: number; y: number; w: number; h: number; a: number; b: number }>;
}
const DRAWBOX =
  /drawbox=x=(\d+):y=(\d+):w=(\d+):h=(\d+):color=black:t=fill:enable='between\(n,(\d+),(\d+)\)'/g;
function leanMaskModels(graph: string): Map<number, MaskModel> {
  const out = new Map<number, MaskModel>();
  for (const chain of graph.split(";")) {
    const m =
      /^color=c=white:s=(\d+)x(\d+):r=(\d+):d=([\d.]+),format=gray(.*),setpts=PTS\+(-?\d+)\[leanmask(\d+)\]$/.exec(
        chain,
      );
    if (!m) continue;
    expect(
      m[5].replace(DRAWBOX, "").replace(/,/g, ""),
      "the mask chain holds nothing but drawboxes",
    ).toBe("");
    out.set(Number(m[7]), {
      width: Number(m[1]),
      height: Number(m[2]),
      frames: sourceFrames(m[4], Number(m[3])),
      from: Number(m[6]),
      boxes: [...m[5].matchAll(DRAWBOX)].map((b) => ({
        x: +b[1],
        y: +b[2],
        w: +b[3],
        h: +b[4],
        a: +b[5],
        b: +b[6],
      })),
    });
  }
  return out;
}

/** The mask frame framesync hands a picture frame with this timestamp: null = no mask frame yet, the picture passes whole. */
function maskFrameAt(model: MaskModel, stamp: number): Uint8Array | null {
  const n0 = stamp - model.from;
  if (n0 < 0) return null;
  const n = Math.min(n0, model.frames - 1);
  const white = new Uint8Array(model.width * model.height).fill(1);
  for (const b of model.boxes)
    if (n >= b.a && n <= b.b)
      for (let y = b.y; y < b.y + b.h; y += 1)
        white.fill(0, y * model.width + b.x, y * model.width + b.x + b.w);
  return white;
}

interface Verdict {
  leanClips: number;
  checkedFrames: number;
  mismatches: Array<{ clip: number; frame: number; pixels: number }>;
}
/** Compare, for every frame the overlay draws a lean clip on, the pixels the mask keeps with the pixels 0.27.0's geq keeps. */
function compareMasks(baseGraph: string, leanGraph: string): Verdict {
  const canvas = /^color=c=black:s=\d+x\d+:r=(\d+):d=([\d.]+)(?:,setpts=PTS\+(\d+))?\[base\]/.exec(
    leanGraph,
  );
  if (!canvas) throw new Error("no base canvas in the graph");
  const fps = Number(canvas[1]);
  const start = Number(canvas[3] ?? 0);
  const count = sourceFrames(canvas[2], fps);
  const tick = 1 / fps;
  const apertures = baselineApertures(baseGraph);
  const masks = leanMaskModels(leanGraph);
  const verdict: Verdict = { leanClips: masks.size, checkedFrames: 0, mismatches: [] };
  for (const [clip, model] of masks) {
    const factors = apertures.get(clip);
    if (!factors)
      throw new Error(`clip ${clip} has a mask but no aperture geq in the baseline graph`);
    const gate = new RegExp(
      `\\[v${clip}\\]overlay=[^;]*enable='between\\(t,(-?[\\d.]+),(-?[\\d.]+)\\)'`,
    ).exec(leanGraph);
    if (!gate) throw new Error(`no overlay gate for clip ${clip}`);
    const [lo, hi] = [Number(gate[1]), Number(gate[2])];
    const { width: W, height: H } = model;
    for (let f = start; f < start + count; f += 1) {
      const T = f * tick;
      if (!(T >= lo && T <= hi)) continue;
      verdict.checkedFrames += 1;
      const kx = Array.from(
        { length: W },
        (_, x) => factors[0](T, W, H, x, 0) * factors[1](T, W, H, x, 0) !== 0,
      );
      const ky = Array.from(
        { length: H },
        (_, y) => factors[2](T, W, H, 0, y) * factors[3](T, W, H, 0, y) !== 0,
      );
      const mask = maskFrameAt(model, f);
      let wrong = 0;
      for (let y = 0; y < H; y += 1)
        for (let x = 0; x < W; x += 1)
          if ((mask === null ? true : mask[y * W + x] === 1) !== (kx[x] && ky[y])) wrong += 1;
      if (wrong) verdict.mismatches.push({ clip, frame: f, pixels: wrong });
    }
  }
  return verdict;
}

interface Scenario {
  fps: number;
  canvas: { width: number; height: number };
  /** Each clip's length in frames; `gap` frames of nothing before it; `transition` on the cut into it (frames long); fades in frames. */
  clips: Array<{
    frames: number;
    gap?: number;
    transition?: { kind: string; frames: number };
    fade?: { in: number; out: number };
    ease?: string;
    scale: [number, number];
    drift?: boolean;
    /** A photograph (a .jpg) rather than a camera clip. */
    still?: boolean;
  }>;
  range?: { from: number; to: number };
  scaled: [number, number];
}
function scenarioTimeline(s: Scenario): Timeline {
  let at = 0;
  const clips = s.clips.map((c, i) => {
    at += c.gap ?? 0;
    const tin = at / s.fps;
    const tout = (at + c.frames) / s.fps;
    at += c.frames;
    return {
      media_ref: c.still ? `/c${i}.jpg` : `/c${i}.mp4`,
      source_in: 0,
      source_out: c.frames / s.fps,
      timeline_in: tin,
      timeline_out: tout,
      fit: "cover",
      ...(c.transition
        ? { transition_in: { kind: c.transition.kind, duration: c.transition.frames / s.fps } }
        : {}),
      ...(c.fade ? { fade: c.fade } : {}),
      transform: {
        position: {
          x: c.drift
            ? [
                { t: 0, v: 0.5 },
                { t: c.frames / s.fps, v: 0.56 },
              ]
            : 0.5,
          y: 0.5,
        },
        scale: [
          { t: 0, v: c.scale[0], ...(c.ease ? { ease: c.ease } : {}) },
          { t: c.frames / s.fps, v: c.scale[1] },
        ],
      },
    };
  });
  return timeline([{ id: "v", kind: "video", z: 0, clips }], { ...s.canvas, fps: s.fps });
}
/** Build the baseline and the lean graph of the same project (and range), the lean one with every size request answered as `s.scaled`. */
function bothGraphs(s: Scenario, options: Record<string, unknown> = {}) {
  const t = scenarioTimeline(s);
  const opts = { ...(s.range ? { range: s.range } : {}), ...options };
  const base = buildRenderCommand(t, OUT, opts as Any);
  const { lean } = answered(t, s.scaled, "yuv420p", opts);
  const plan = buildRenderCommand(t, OUT, { ...opts, lean } as Any);
  return { base, plan };
}

const TRANSITIONS = ["crossfade", "wipe-l", "wipe-r", "whip", "dip-to-black", "dip-to-white"];
const CANVAS = { width: 60, height: 108 };

describe("EVIDENCE (questions 1 to 3): every frame the overlay draws meets the mask frame of its own time, with the rectangle the geq keeps", () => {
  const scenarios: Array<[string, Scenario]> = [
    [
      "one clip from frame 0, 30 fps",
      { fps: 30, canvas: CANVAS, scaled: [96, 130], clips: [{ frames: 60, scale: [1, 1.2] }] },
    ],
    [
      "a crossfade of an odd number of frames (a half-frame lead-in) at 25 fps, with fades",
      {
        fps: 25,
        canvas: CANVAS,
        scaled: [96, 130],
        clips: [
          { frames: 50, scale: [1, 1.2] },
          {
            frames: 50,
            scale: [1, 1.2],
            transition: { kind: "crossfade", frames: 13 },
            fade: { in: 3, out: 4 },
          },
        ],
      },
    ],
    [
      "every transition kind, eased zooms, 24 fps",
      {
        fps: 24,
        canvas: CANVAS,
        scaled: [110, 120],
        clips: [
          { frames: 40, scale: [1, 1.3], ease: "ease-in-out" },
          {
            frames: 40,
            scale: [1.3, 1],
            ease: "ease-in",
            transition: { kind: "wipe-r", frames: 7 },
          },
          {
            frames: 40,
            scale: [1, 1.25],
            ease: "ease-out",
            transition: { kind: "dip-to-black", frames: 10 },
          },
          { frames: 40, scale: [1, 1.1], drift: true, transition: { kind: "whip", frames: 9 } },
        ],
      },
    ],
    [
      "photographs with a crossfade, a late start and a hold (the stills' own loop and tpad)",
      {
        fps: 30,
        canvas: CANVAS,
        scaled: [80, 108],
        clips: [
          { frames: 45, scale: [1, 1.25], still: true },
          {
            frames: 45,
            scale: [1.25, 1],
            still: true,
            transition: { kind: "crossfade", frames: 15 },
            drift: true,
          },
          { frames: 30, gap: 9, scale: [1, 1.1], still: true },
        ],
      },
    ],
    [
      "a clip that starts late with a gap before it, 60 fps",
      {
        fps: 60,
        canvas: CANVAS,
        scaled: [180, 110],
        clips: [
          { frames: 30, scale: [1, 1.2] },
          { frames: 50, gap: 17, scale: [1, 1.2], drift: true },
        ],
      },
    ],
  ];
  for (const [name, s] of scenarios) {
    it(`${name}: whole export and as partitions`, () => {
      const total = s.clips.reduce((n, c) => n + (c.gap ?? 0) + c.frames, 0);
      const ranges: Array<{ from: number; to: number } | undefined> = [undefined];
      for (const cut of [1, 7, Math.floor(total / 3), Math.floor(total / 2), total - 2]) {
        ranges.push({ from: 0, to: cut + 1 }, { from: cut, to: total });
        ranges.push({ from: Math.max(0, cut - 5), to: Math.min(total, cut + 9) });
      }
      let leaned = 0;
      for (const range of ranges) {
        const { base, plan } = bothGraphs({ ...s, ...(range ? { range } : {}) });
        const verdict = compareMasks(base.filterComplex, plan.filterComplex);
        const label = `${name} ${JSON.stringify(range)}`;
        // the record and the text agree: "ran zoom" exactly when a mask is in the graph
        expect(plan.lean?.ran.includes("zoom") ?? false, label).toBe(verdict.leanClips > 0);
        expect(verdict.mismatches, label).toEqual([]);
        if (verdict.leanClips > 0) expect(verdict.checkedFrames, label).toBeGreaterThan(0);
        if (!range)
          expect(verdict.leanClips, `${label}: every clip took the mask`).toBe(s.clips.length);
        leaned += verdict.leanClips;
      }
      expect(leaned).toBeGreaterThanOrEqual(ranges.length);
    }, 120_000);
  }

  it("a transition longer than the clip before it: the incoming clip's first drawn frame is before project frame 0", () => {
    const s: Scenario = {
      fps: 30,
      canvas: CANVAS,
      scaled: [96, 130],
      clips: [
        { frames: 3, scale: [1, 1.2] },
        { frames: 40, scale: [1, 1.2], transition: { kind: "crossfade", frames: 20 } },
      ],
    };
    for (const range of [undefined, { from: 0, to: 12 }, { from: 2, to: 30 }]) {
      const { base, plan } = bothGraphs({ ...s, ...(range ? { range } : {}) });
      expect(plan.lean?.ran).toEqual(["zoom"]);
      const verdict = compareMasks(base.filterComplex, plan.filterComplex);
      expect(verdict.mismatches, JSON.stringify(range)).toEqual([]);
      expect(verdict.checkedFrames).toBeGreaterThan(0);
    }
    const whole = bothGraphs(s).plan.filterComplex;
    expect(whole).toMatch(/setpts=PTS\+-\d+\[leanmask1\]/);
  });

  it("random projects: zoom, ease, drift, every transition kind, fades, gaps, fps 24 to 60, whole export and a random partition", () => {
    const scale = fc.integer({ min: 80, max: 150 }).map((n) => n / 100);
    const clip = fc.record({
      frames: fc.integer({ min: 6, max: 45 }),
      gap: fc.constantFrom(0, 0, 0, 3, 11),
      transition: fc.option(
        fc.record({
          kind: fc.constantFrom(...TRANSITIONS),
          frames: fc.integer({ min: 3, max: 24 }),
        }),
        { nil: undefined },
      ),
      fade: fc.option(
        fc.record({ in: fc.integer({ min: 0, max: 5 }), out: fc.integer({ min: 0, max: 5 }) }),
        { nil: undefined },
      ),
      ease: fc.constantFrom(undefined, "ease-in", "ease-out", "ease-in-out", "hold"),
      scale: fc.tuple(scale, scale),
      drift: fc.boolean(),
    });
    const scenario = fc
      .record({
        fps: fc.constantFrom(24, 25, 30, 50, 60),
        width: fc.constantFrom(48, 60, 72),
        height: fc.constantFrom(84, 108),
        rw: fc.integer({ min: 10, max: 30 }),
        rh: fc.integer({ min: 10, max: 15 }),
        clips: fc.array(clip, { minLength: 1, maxLength: 3 }),
        cut: fc.double({ min: 0, max: 1, noNaN: true }),
        span: fc.double({ min: 0, max: 1, noNaN: true }),
        ranged: fc.boolean(),
      })
      .map((r): Scenario => {
        const clips = r.clips.map((c, i) => ({
          ...c,
          transition: i === 0 ? undefined : c.transition,
          gap: c.transition && i > 0 ? 0 : c.gap,
        }));
        const total = clips.reduce((n, c) => n + (c.gap ?? 0) + c.frames, 0);
        const from = Math.floor(r.cut * (total - 1));
        const to = from + 1 + Math.floor(r.span * (total - from - 1));
        return {
          fps: r.fps,
          canvas: { width: r.width, height: r.height },
          scaled: [2 * Math.round((r.width * r.rw) / 20), 2 * Math.round((r.height * r.rh) / 20)],
          clips,
          ...(r.ranged ? { range: { from, to } } : {}),
        };
      });
    const mutate = (graph: string): string =>
      graph.replace(
        /setpts=PTS\+(-?\d+)\[leanmask(\d)\]/g,
        (_m, n, i) => `setpts=PTS+${Number(n) + 1}[leanmask${i}]`,
      );
    let sensitive = 0;
    let withMask = 0;
    fc.assert(
      fc.property(scenario, (s) => {
        const { base, plan } = bothGraphs(s);
        const verdict = compareMasks(base.filterComplex, plan.filterComplex);
        expect(verdict.mismatches, JSON.stringify(s)).toEqual([]);
        expect(plan.lean?.ran.includes("zoom") ?? false).toBe(verdict.leanClips > 0);
        // a clip that did not take the mask keeps 0.27.0's own geq text, byte for byte
        for (const [i, factors] of baselineApertures(base.filterComplex)) {
          void factors;
          if (!leanMaskModels(plan.filterComplex).has(i)) {
            const chain = (g: string): string => g.split(";").find((c) => c.endsWith(`[v${i}]`))!;
            expect(chain(plan.filterComplex)).toBe(chain(base.filterComplex));
          }
        }
        if (verdict.leanClips > 0) {
          withMask += 1;
          if (compareMasks(base.filterComplex, mutate(plan.filterComplex)).mismatches.length > 0)
            sensitive += 1;
        }
      }),
      { numRuns: 30 },
    );
    // negative control: a mask one frame late is caught on most projects with a real zoom (a hold-eased or flat zoom cannot show it)
    expect(withMask).toBeGreaterThan(10);
    expect(sensitive).toBeGreaterThan(withMask / 3);
  }, 170_000);

  it("the oracle can fail: a mask one frame late, a mask two frames short and a shifted group each turn it red", () => {
    const s = scenarios[1][1];
    const { base, plan } = bothGraphs(s);
    expect(compareMasks(base.filterComplex, plan.filterComplex).mismatches).toEqual([]);
    const late = plan.filterComplex.replace(
      /setpts=PTS\+(-?\d+)\[leanmask(\d)\]/g,
      (_m, n, i) => `setpts=PTS+${Number(n) + 1}[leanmask${i}]`,
    );
    expect(compareMasks(base.filterComplex, late).mismatches.length).toBeGreaterThan(0);
    const early = plan.filterComplex.replace(
      /setpts=PTS\+(-?\d+)\[leanmask(\d)\]/g,
      (_m, n, i) => `setpts=PTS+${Number(n) - 1}[leanmask${i}]`,
    );
    expect(compareMasks(base.filterComplex, early).mismatches.length).toBeGreaterThan(0);
    const shifted = plan.filterComplex.replace(
      /between\(n,(\d+),(\d+)\)/g,
      (_m, a, b) => `between(n,${Number(a) + 1},${Number(b) + 1})`,
    );
    expect(compareMasks(base.filterComplex, shifted).mismatches.length).toBeGreaterThan(0);
    const short = plan.filterComplex.replace(
      /(color=c=white:s=\d+x\d+:r=\d+:d=)([\d.]+)/g,
      (_m, head, d) => `${head}${(Number(d) - 3 / 25).toFixed(6)}`,
    );
    expect(compareMasks(base.filterComplex, short).mismatches.length).toBeGreaterThan(0);
  });
});

describe("EVIDENCE (question 6): the streamed engine builds every part with the same arithmetic", () => {
  it("each part's mask meets the geq of the same part, frame by frame, and the plan's record is the union of the parts", () => {
    const s: Scenario = {
      fps: 25,
      canvas: CANVAS,
      scaled: [96, 130],
      clips: [
        { frames: 1200, scale: [1, 1.2] },
        {
          frames: 900,
          scale: [1.2, 1],
          transition: { kind: "wipe-l", frames: 11 },
          fade: { in: 5, out: 5 },
        },
        {
          frames: 1000,
          scale: [1, 1.15],
          transition: { kind: "crossfade", frames: 13 },
          drift: true,
        },
      ],
    };
    const t = scenarioTimeline(s);
    const opts = { engine: "partition-pipes-v1" } as Any;
    const { lean } = answered(t, s.scaled, "yuv420p", opts);
    const lp = buildRenderCommand(t, OUT, { ...opts, lean });
    const bp = buildRenderCommand(t, OUT, opts);
    const graphs = (p: typeof lp): string[] =>
      p.assFiles
        .filter((f) => f.name.endsWith(".ffgraph") && f.name.startsWith("part"))
        .map((f) => f.content);
    const [lg, bg] = [graphs(lp), graphs(bp)];
    expect(lg.length).toBeGreaterThanOrEqual(3);
    expect(lg).toHaveLength(bg.length);
    let masked = 0;
    for (let i = 0; i < lg.length; i += 1) {
      const verdict = compareMasks(bg[i], lg[i]);
      expect(verdict.mismatches, `part ${i}`).toEqual([]);
      masked += verdict.leanClips;
    }
    expect(masked).toBeGreaterThanOrEqual(3);
    expect(lp.lean).toEqual({ ran: ["zoom"], kept: [] });
  }, 120_000);
});

/** Every `[label]` a chain defines is defined once and used once (ffmpeg refuses a graph with a dangling or reused pad). */
function labelProblems(graph: string): string[] {
  const defined = new Map<string, number>();
  const used = new Map<string, number>();
  const chains = graph.split(";");
  let terminal: string[] = [];
  for (const chain of chains) {
    const lead = /^((?:\[[^\]]+\])*)/.exec(chain)![1];
    const tail = /((?:\[[^\]]+\])*)$/.exec(chain)![1];
    for (const m of lead.matchAll(/\[([^\]]+)\]/g))
      if (!/^\d+:[va]/.test(m[1])) used.set(m[1], (used.get(m[1]) ?? 0) + 1);
    for (const m of tail.matchAll(/\[([^\]]+)\]/g)) defined.set(m[1], (defined.get(m[1]) ?? 0) + 1);
    terminal = [...tail.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  }
  const problems: string[] = [];
  // the graph's own output (mapped by -map, outside the graph text) is the one label allowed to stay unused
  for (const [l, n] of defined)
    if (n !== 1 || (used.get(l) ?? 0) !== (terminal.includes(l) ? 0 : 1))
      problems.push(`${l}: defined ${n}, used ${used.get(l) ?? 0}`);
  for (const l of used.keys()) if (!defined.has(l)) problems.push(`${l}: used, never defined`);
  return problems;
}

describe("EVIDENCE (question 5): the lean graph is a well-formed graph for every shape, and shapes the fix refuses are untouched", () => {
  it("no dangling or reused label, a mask exactly where the record says so, and a refused clip keeps its whole chain", () => {
    const extras = [
      {},
      { opacity: 0.6 },
      {
        opacity: [
          { t: 0, v: 1 },
          { t: 1, v: 0.4 },
        ],
      },
      { blend: "multiply" },
      { glow: { amount: 40 } },
      { rotate: 12 },
      { speed: 1.5 },
      { crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 } },
      { flip: { v: true } },
      { effects: [{ type: "vignette", params: { vignette: 0.4 } }] },
      { effects: [{ type: "blur", params: { radius: 3 } }] },
      { color: { saturation: 1.3, vibrance: 0.2 } },
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...extras), { minLength: 1, maxLength: 3 }),
        fc.constantFrom("yuv420p", "rgba"),
        fc.constantFrom(undefined, "partition-pipes-v1"),
        (shapes, fmt, engine) => {
          const t = timeline([
            {
              id: "v",
              kind: "video",
              z: 0,
              clips: shapes.map((x, i) =>
                zoomClip(2, {
                  ...x,
                  media_ref: `/c${i}.mp4`,
                  timeline_in: 2 * i,
                  timeline_out: 2 * i + 2,
                }),
              ),
            },
          ]);
          const opts = engine ? { engine } : {};
          const base = buildRenderCommand(t, OUT, opts as Any);
          const { lean } = answered(t, [2304, 1296], fmt, opts);
          const plan = buildRenderCommand(t, OUT, { ...opts, lean } as Any);
          const graphsOf = (p: typeof plan): string =>
            [
              p.filterComplex,
              ...p.assFiles.filter((f) => f.name.endsWith(".ffgraph")).map((f) => f.content),
            ].join(";");
          expect(labelProblems(plan.filterComplex), JSON.stringify(shapes)).toEqual([]);
          const masks = (graphsOf(plan).match(/\[leanmask\d+\]/g) ?? []).length;
          expect(plan.lean?.ran.includes("zoom") ?? false).toBe(masks > 0);
          if (masks === 0) expect(graphsOf(plan)).toBe(graphsOf(base));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("with the switch off, undefined, or a plain build, the plan is 0.27.0's byte for byte (command, graph, steps, staged files) for any mix of shapes and either engine", () => {
    const extras = [
      {},
      { opacity: 0.6 },
      { blend: "screen" },
      { glow: { amount: 40 } },
      { rotate: 12 },
      { speed: 0.5 },
      { effects: [{ type: "chroma", params: { color: "#00FF00" } }] },
      { transition_in: { kind: "wipe-r", duration: 0.4 } },
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...extras), { minLength: 1, maxLength: 3 }),
        fc.constantFrom<LeanOptions>(
          { zoom: false },
          {},
          { zoom: true, plain: true },
          { zoom: true, plain: true, probed: new Map() },
        ),
        fc.constantFrom(undefined, "partition-pipes-v1"),
        (shapes, lean, engine) => {
          const t = timeline([
            {
              id: "v",
              kind: "video",
              z: 0,
              clips: shapes.map((x, i) =>
                zoomClip(2, {
                  ...x,
                  media_ref: `/c${i}.mp4`,
                  timeline_in: 2 * i,
                  timeline_out: 2 * i + 2,
                }),
              ),
            },
          ]);
          const opts = engine ? { engine } : {};
          const base = buildRenderCommand(t, OUT, opts as Any);
          const plan = buildRenderCommand(t, OUT, { ...opts, lean } as Any);
          expect(plan.args).toEqual(base.args);
          expect(plan.filterComplex).toBe(base.filterComplex);
          expect(plan.steps).toEqual(base.steps);
          expect(plan.assFiles).toEqual(base.assFiles);
          expect(plan.sources).toEqual(base.sources);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("RISK (fixed): the mask budget is spent per export (one budget across the parts), as DESIGN-3a 2.1(6) says", () => {
  it("the mask text of a whole streamed export stays inside the 2 MiB the design allows for the export", () => {
    // 20 minutes of ten-second Ken-Burns clips on a 2160x3840 canvas (the streamed engine), one probe answer for every clip
    const clips = Array.from({ length: 120 }, () => ({
      frames: 300,
      scale: [1, 1.4] as [number, number],
    }));
    const s: Scenario = {
      fps: 30,
      canvas: { width: 2160, height: 3840 },
      scaled: [3024, 5376],
      clips,
    };
    const t = scenarioTimeline(s);
    const opts = { engine: "partition-pipes-v1" } as Any;
    const { lean } = answered(t, s.scaled, "yuv420p", opts);
    const plan = buildRenderCommand(t, OUT, { ...opts, lean });
    const parts = plan.assFiles.filter((f) => f.name.endsWith(".ffgraph"));
    const maskChars = parts.reduce(
      (n, g) =>
        n +
        g.content
          .split(";")
          .filter((c) => c.startsWith("color=c=white"))
          .reduce((m, c) => m + c.length, 0),
      0,
    );
    expect(parts.length).toBeGreaterThan(20);
    expect(maskChars).toBeLessThanOrEqual(LEAN_MAX_MASK_CHARS);
  });
});

describe("EVIDENCE (questions 5, 6, 8): the async boundary", () => {
  const showinfo = (instance: number, n: number, fmt: string, size: string): string =>
    `[Parsed_showinfo_${instance} @ 000001ff1b7ae080] n:   ${n} pts:      0 pts_time:0       duration:    256 duration_time:0.0166667 fmt:${fmt} cl:left sar:1/1 s:${size} i:P iskey:1 type:I checksum:3D5BDD03 plane_checksum:[674E12E6 148E3791 D420928C] mean:[126 127 126] stdev:[55.9 79.5 83.8]`;
  const log = (fmt: string, scaled: string): string =>
    [
      showinfo(1, 0, fmt, "1920x1080"),
      showinfo(3, 0, fmt, scaled),
      showinfo(1, 1, fmt, "1920x1080"),
      showinfo(3, 1, fmt, scaled),
    ].join("\n");
  function fakeRunner(
    answer: (path: string) => { code: number | null; stderr: string } | "throws",
  ) {
    const asked: string[][] = [];
    const runner: CommandRunner = {
      async run(_program, args) {
        asked.push(args);
        const r = answer(args[args.indexOf("-i") + 1]);
        if (r === "throws") throw new Error("spawn failed");
        return { code: r.code, stdout: "", stderr: r.stderr };
      },
    };
    return { runner, asked };
  }
  const two = (): Timeline =>
    scenarioTimeline({
      fps: 30,
      canvas: CANVAS,
      scaled: [96, 130],
      clips: [
        { frames: 30, scale: [1, 1.2] },
        { frames: 30, scale: [1, 1.2] },
      ],
    });
  const countOf = (text: string, needle: string): number => text.split(needle).length - 1;
  afterEach(() => __resetExportFlags());

  it("with the lean names unknown to the client (as built today) nothing is asked and the graph is 0.27.0's", async () => {
    const { runner, asked } = fakeRunner(() => ({ code: 0, stderr: log("yuv420p", "96x130") }));
    const plan = await buildLeanRenderCommand({ runner, signal: undefined }, two(), OUT, {});
    expect(asked).toHaveLength(0);
    expect(plan.filterComplex).toBe(buildRenderCommand(two(), OUT).filterComplex);
    expect(plan.lean).toEqual({ ran: [], kept: ["flag_off"] });
  });

  it("with the switch on it probes each distinct picture once, builds again with the answers, and the mask has the size ffmpeg reported", async () => {
    __setExportFlag("lean_zoom" as Any, true);
    const { runner, asked } = fakeRunner(() => ({ code: 0, stderr: log("yuv420p", "98x132") }));
    const plan = await buildLeanRenderCommand({ runner, signal: undefined }, two(), OUT, {});
    expect(asked).toHaveLength(2);
    expect(plan.lean).toEqual({ ran: ["zoom"], kept: [] });
    expect(countOf(plan.filterComplex, "alphamerge")).toBe(2);
    expect(countOf(plan.filterComplex, "color=c=white:s=98x132:")).toBe(2);
    expect(plan.filterComplex).not.toContain("gte(X,(W-");
  });

  it("a probe that fails, throws or answers nonsense leaves that clip on 0.27.0's graph, counted as unknown, and the other clip on the mask", async () => {
    __setExportFlag("lean_zoom" as Any, true);
    const { runner } = fakeRunner((path) =>
      path === "/c0.mp4" ? "throws" : { code: 0, stderr: log("yuv420p", "98x132") },
    );
    const plan = await buildLeanRenderCommand({ runner, signal: undefined }, two(), OUT, {});
    expect(plan.lean).toEqual({ ran: ["zoom"], kept: ["unknown_source"] });
    expect(countOf(plan.filterComplex, "alphamerge")).toBe(1);
    expect(countOf(plan.filterComplex, "gte(X,(W-")).toBe(1);
    const none = fakeRunner(() => ({
      code: 1,
      stderr: "Invalid data found when processing input",
    }));
    const all = await buildLeanRenderCommand(
      { runner: none.runner, signal: undefined },
      two(),
      OUT,
      {},
    );
    expect(all.filterComplex).toBe(buildRenderCommand(two(), OUT).filterComplex);
    expect(all.lean).toEqual({ ran: [], kept: ["unknown_source"] });
  });

  it("NIT (fixed): a `lean` option the caller passes is honoured: a caller's `plain` (the retry) builds today's graph and counts nothing", async () => {
    __setExportFlag("lean_zoom" as Any, true);
    const { runner } = fakeRunner(() => ({ code: 0, stderr: log("yuv420p", "98x132") }));
    const plan = await buildLeanRenderCommand({ runner, signal: undefined }, two(), OUT, {
      lean: { plain: true },
    });
    expect(plan.lean).toEqual({ kept: [], ran: [] });
    expect(plan.filterComplex).toBe(buildRenderCommand(two(), OUT).filterComplex);
  });

  it("RISK (fixed): the whole probing phase has a deadline: probes that hang no longer cost ceil(n / 3) x 20 s before the export is planned", async () => {
    vi.useFakeTimers();
    try {
      __setExportFlag("lean_zoom" as Any, true);
      const t = scenarioTimeline({
        fps: 30,
        canvas: CANVAS,
        scaled: [96, 130],
        clips: Array.from({ length: 9 }, () => ({
          frames: 30,
          scale: [1, 1.2] as [number, number],
        })),
      });
      // a process that never answers until the abort signal kills it (what a hung read of a slow or cloud-backed file looks like)
      const runner: CommandRunner = {
        run: (_program, _args, signal) =>
          new Promise((resolve) =>
            signal?.addEventListener("abort", () =>
              resolve({ code: -1, stdout: "", stderr: "cancelled" }),
            ),
          ),
      };
      let done = false;
      const planned = buildLeanRenderCommand({ runner, signal: undefined }, t, OUT, {}).then(
        (p) => {
          done = true;
          return p;
        },
      );
      await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS - 1_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(done).toBe(true);
      expect((await planned).lean).toEqual({ ran: [], kept: ["unknown_source"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Stop (abort signal) during probing ends the wait and keeps 0.27.0's graph", async () => {
    __setExportFlag("lean_zoom" as Any, true);
    const stop = new AbortController();
    const runner: CommandRunner = {
      run: (_program, _args, signal) =>
        new Promise((resolve) =>
          signal?.addEventListener("abort", () =>
            resolve({ code: -1, stdout: "", stderr: "cancelled" }),
          ),
        ),
    };
    const planned = buildLeanRenderCommand({ runner, signal: stop.signal }, two(), OUT, {});
    stop.abort();
    const plan = await planned;
    expect(plan.filterComplex).toBe(buildRenderCommand(two(), OUT).filterComplex);
  });

  it("building again with the same options object adds no request twice and counts nothing twice (question 8)", () => {
    const t = two();
    const asked: LeanOptions = { zoom: true, requests: [] };
    const first = buildRenderCommand(t, OUT, { lean: asked });
    const again = buildRenderCommand(t, OUT, { lean: asked });
    expect(asked.requests).toHaveLength(2);
    expect(again.filterComplex).toBe(first.filterComplex);
    expect(again.lean).toEqual(first.lean);
    const { lean } = answered(t, [96, 130]);
    const a = buildRenderCommand(t, OUT, { lean });
    const b = buildRenderCommand(t, OUT, { lean });
    const c = buildRenderCommand(t, OUT, { lean }, undefined);
    expect(b.filterComplex).toBe(a.filterComplex);
    expect(c.filterComplex).toBe(a.filterComplex);
    expect(a.lean).toEqual({ ran: ["zoom"], kept: [] });
    expect(c.lean).toEqual(a.lean);
  });
});

describe("EVIDENCE (question 7): the record is two lists of distinct closed words and nothing else", () => {
  it("for any mix of switches, probe answers, shapes and engines", () => {
    const shape = fc.constantFrom(
      {},
      { rotate: 10 },
      { speed: 2 },
      { flip: { h: true } },
      { glow: { amount: 0.5 } },
      { opacity: 0.5 },
    );
    fc.assert(
      fc.property(
        fc.array(shape, { minLength: 1, maxLength: 3 }),
        fc.constantFrom(undefined, true, false),
        fc.constantFrom("yuv420p", "rgba", "pal8", "weird", undefined),
        fc.boolean(),
        fc.boolean(),
        (shapes, zoom, fmt, plain, streamed) => {
          const t = timeline([
            {
              id: "v",
              kind: "video",
              z: 0,
              clips: shapes.map((x, i) =>
                zoomClip(2, {
                  ...x,
                  media_ref: `/c${i}.mp4`,
                  timeline_in: 2 * i,
                  timeline_out: 2 * i + 2,
                }),
              ),
            },
          ]);
          const base: LeanOptions = { zoom, plain, requests: [] };
          const asked = buildRenderCommand(t, OUT, {
            lean: base,
            ...(streamed ? { engine: "partition-pipes-v1" } : {}),
          } as Any);
          const probed = new Map<string, LeanProbed>();
          if (fmt)
            for (const r of base.requests ?? [])
              probed.set(r.key, { fmt, source: [640, 360], scaled: [2304, 1296] });
          const plan = buildRenderCommand(t, OUT, {
            lean: { zoom, plain, probed },
            ...(streamed ? { engine: "partition-pipes-v1" } : {}),
          } as Any);
          for (const p of [asked, plan]) {
            const record = p.lean!;
            expect(Object.keys(record)).toEqual(["ran", "kept"]);
            expect(new Set(record.ran).size).toBe(record.ran.length);
            expect(new Set(record.kept).size).toBe(record.kept.length);
            expect(record.ran).toEqual(LEAN_FIXES.filter((w) => record.ran.includes(w)));
            expect(record.kept).toEqual(LEAN_KEPT_REASONS.filter((w) => record.kept.includes(w)));
            // no path, size or count can be in it
            expect(JSON.stringify(record)).toMatch(/^[a-z_{}[\]":,]*$/);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("EVIDENCE (question 10): what the existing mask tests cannot see", () => {
  const sizeW = [
    { t: 0, v: 1000 },
    { t: 2, v: 1200 },
  ] as Any;
  const sizeH = [
    { t: 0, v: 300 },
    { t: 2, v: 420 },
  ] as Any;
  const exprs = (() => {
    const w = compileAnim(sizeW, "T", 0);
    const h = compileAnim(sizeH, "T", 0);
    const tw = `max(2,round((${w})/2)*2)`;
    const th = `max(2,round((${h})/2)*2)`;
    const scale = `max((${tw})/W,(${th})/H)`;
    return { widthExpr: `((${tw})/(${scale}))`, heightExpr: `((${th})/(${scale}))` };
  })();
  it("the assertions of 'covers the clip's frames plus the extra frames' also hold for a rectangle list that is one frame LATE", () => {
    const input = { ...exprs, width: 1200, height: 600, fps: 30, from: 10, to: 40 };
    const right = apertureRects(input)!;
    const late = apertureRects({ ...input, from: input.from - 1, to: input.to - 1 })!; // frame f gets the rectangle of frame f - 1
    for (const rects of [right, late]) {
      expect(rects).toHaveLength(32);
      for (const [x0, x1, y0, y1] of rects) {
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(1200);
        expect(x1).toBeGreaterThan(x0);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(y1).toBeLessThanOrEqual(600);
        expect(y1).toBeGreaterThan(y0);
      }
      expect(new Set(rects.map((r) => r.join(","))).size).toBeGreaterThan(1);
    }
    // ...while the content is not the same: frame 40 of the late list is frame 39's rectangle
    expect(late.map((r) => r.join(","))).not.toEqual(right.map((r) => r.join(",")));
  });

  it("the multi-group case of maskStream (where a frame-boundary mistake would show) is only checked structurally by the existing tests", () => {
    const input = { ...exprs, width: 1200, height: 600, fps: 30, from: 10, to: 40 };
    const rects = apertureRects(input)!;
    const mask = maskStream(input, rects)!;
    expect(mask.groups).toBeGreaterThan(1);
    // every group boundary must sit exactly where the rectangle changes: group k covers frames a..b and no other frame has that rectangle next to it
    const bounds = [...mask.text.matchAll(/between\(n,(\d+),(\d+)\)/g)].map((m) => [+m[1], +m[2]]);
    for (const [a, b] of bounds) {
      for (let n = a; n <= b; n += 1) expect(rects[n].join(",")).toBe(rects[a].join(","));
      if (a > 0) expect(rects[a - 1].join(",")).not.toBe(rects[a].join(","));
      if (b < rects.length - 1) expect(rects[b + 1].join(",")).not.toBe(rects[b].join(","));
    }
  });
});

describe("EVIDENCE (question 2): the frame time is pts x (1 / fps) and a last-bit difference in it can move a rounded edge", () => {
  it("frames exist where f * (1 / fps) and f / fps differ and decide a round() tie differently; the product takes the form the geq computes (pts times av_q2d of the time base)", () => {
    // width = 1000 + T * fps pixels, rounded to an even number of pixels: at an odd frame f it is an exact tie (round half away from zero) UNLESS T is a hair off
    let found: { fps: number; f: number; mul: number; div: number } | null = null;
    for (const fps of [25, 30, 24, 50, 60])
      for (let f = 1; f < 4000 && !found; f += 2) {
        const evalWidth = (T: number): number => cRoundRef((1000 + T * fps) / 2) * 2;
        const [mul, div] = [evalWidth(f * (1 / fps)), evalWidth(f / fps)];
        if (mul !== div) found = { fps, f, mul, div };
      }
    expect(found, "a frame where the two forms of T give different widths").not.toBeNull();
    const { fps, f, mul, div } = found!;
    const input = {
      widthExpr: `max(2,round((1000+T*${fps})/2)*2)`,
      heightExpr: "100",
      width: 20000,
      height: 100,
      fps,
      from: f,
      to: f + 1,
    };
    const [x0, x1] = apertureRects(input)![0];
    // the product's rectangle is the one of T = f * (1 / fps) ...
    expect([x0, x1]).toEqual([Math.ceil((20000 - mul) / 2), Math.ceil((20000 + mul) / 2)]);
    // ... and not the one of T = f / fps, which is a different rectangle
    expect([x0, x1]).not.toEqual([Math.ceil((20000 - div) / 2), Math.ceil((20000 + div) / 2)]);
  });
});

describe("EVIDENCE (question 4): the alpha table", () => {
  it("never calls a format that carries alpha 'no alpha', and never calls one without alpha 'alpha'", () => {
    const withAlpha = [
      "ya8",
      "ya16le",
      "ya16be",
      "rgba",
      "argb",
      "bgra",
      "abgr",
      "rgba64le",
      "rgba64be",
      "bgra64le",
      "bgra64be",
      "yuva420p",
      "yuva422p",
      "yuva444p",
      "yuva420p9le",
      "yuva420p10le",
      "yuva420p10be",
      "yuva420p16le",
      "yuva422p9le",
      "yuva422p10le",
      "yuva422p12le",
      "yuva422p16le",
      "yuva444p9le",
      "yuva444p10le",
      "yuva444p12le",
      "yuva444p16le",
      "gbrap",
      "gbrap10le",
      "gbrap12le",
      "gbrap16le",
      "gbrap16be",
      "gbrapf32le",
      "gbrapf32be",
      "ayuv",
      "ayuv64le",
      "vuya",
      "rgbaf16le",
      "rgbaf32le",
      "rgbaf16be",
      "pal8",
    ];
    const withoutAlpha = [
      "yuv420p",
      "yuvj420p",
      "yuv422p",
      "yuv444p",
      "yuv420p10le",
      "yuv422p12le",
      "yuv444p16le",
      "nv12",
      "nv21",
      "p010le",
      "gray",
      "gray10le",
      "gray16le",
      "rgb24",
      "bgr24",
      "rgb48le",
      "bgr48le",
      "gbrp",
      "gbrp10le",
      "gbrp16le",
      "rgb0",
      "bgr0",
      "0rgb",
      "0bgr",
      "uyvy422",
      "yuyv422",
    ];
    for (const f of withAlpha) expect(pixFmtHasAlpha(f), f).not.toBe(false);
    for (const f of withoutAlpha) expect(pixFmtHasAlpha(f), f).not.toBe(true);
  });
});

describe("EVIDENCE (question 4): the probe's own command", () => {
  it("is exactly the picture chain's first two filters, so an eligible clip's size is the size the real chain has at that point", () => {
    // what the eligible clip's own chain runs between its input and the merge, outside the probe's two filters
    const t = oneClip({}, 2);
    const asked: LeanOptions = { zoom: true, requests: [] };
    const base = buildRenderCommand(t, OUT, { lean: asked });
    const r = asked.requests![0];
    const chain = base.filterComplex.split(";").find((c) => c.startsWith("[0:v]"))!;
    expect(
      chain.startsWith(`[0:v]${r.filters.replace(",showinfo", "").replace(",showinfo", "")}`),
    ).toBe(true);
  });
});

describe("EVIDENCE (question 3): a clip that keeps its aperture geq keeps the whole graph", () => {
  it("a see-through source (alpha) changes nothing in the graph", () => {
    const t = scenarioTimeline({
      fps: 30,
      canvas: CANVAS,
      scaled: [96, 130],
      clips: [
        { frames: 30, scale: [1, 1.2] },
        { frames: 30, scale: [1, 1.2], transition: { kind: "wipe-r", frames: 8 } },
      ],
    });
    const { lean } = answered(t, [96, 130], "rgba");
    const plan = buildRenderCommand(t, OUT, { lean });
    expect(plan.filterComplex).toBe(buildRenderCommand(t, OUT).filterComplex);
    expect(plan.lean).toEqual({ ran: [], kept: ["see_through"] });
  });
});

describe("EVIDENCE (question 3): the alpha stage keeps 0.27.0's order, with the mask first, for every clip shape the fix accepts", () => {
  it("after the merge come exactly the alpha filters 0.27.0 ran before its aperture geq, in their order, then the zoom scale", () => {
    const t = scenarioTimeline({
      fps: 30,
      canvas: CANVAS,
      scaled: [96, 130],
      clips: [
        { frames: 40, scale: [1, 1.2] },
        {
          frames: 40,
          scale: [1, 1.2],
          transition: { kind: "crossfade", frames: 10 },
          fade: { in: 4, out: 4 },
        },
      ],
    });
    const withOpacity = JSON.parse(JSON.stringify(t)) as Any;
    withOpacity.tracks[0].clips[1].opacity = [
      { t: 1.33, v: 1 },
      { t: 2.66, v: 0.5 },
    ];
    const { lean } = answered(withOpacity, [96, 130]);
    const plan = buildRenderCommand(withOpacity, OUT, { lean });
    const base = buildRenderCommand(withOpacity, OUT);
    const alphaStage = (graph: string, which: "lean" | "base"): string[] => {
      const chain = graph.split(";").find((c) => c.endsWith("[v1]") && c.includes("geq="))!;
      const stage =
        which === "lean" ? chain.split("alphamerge,")[1] : chain.split("format=yuva420p,")[1];
      return splitTop(stage.replace(/\[v1\]$/, ""), ",").map((f) => f.slice(0, f.indexOf("=")));
    };
    const aperture = (f: string): boolean => f === "geq";
    const baseStage = alphaStage(base.filterComplex, "base");
    const leanStage = alphaStage(plan.filterComplex, "lean");
    // 0.27.0: opacity geq, crossfade geq, fade geq, APERTURE geq, zoom scale. lean: the same without the aperture geq (the mask came first).
    expect(baseStage).toEqual(["geq", "geq", "geq", "geq", "scale"]);
    expect(leanStage).toEqual(["geq", "geq", "geq", "scale"]);
    expect(baseStage.filter(aperture)).toHaveLength(leanStage.filter(aperture).length + 1);
  });
});
describe("BUG (fixed): the mask replaces an alpha plane that an earlier effect wrote (chroma key)", () => {
  it("a keyed clip keeps its key: no filter that WRITES alpha may sit before the merge that replaces the alpha plane", () => {
    const keyed = [
      { type: "chroma", params: { color: "#00FF00", similarity: 0.3, blend: 0.1 } },
      { type: "custom", params: { expr: "colorkey=0x00FF00:0.3:0.1" } },
      { type: "custom", params: { expr: "chromakey=0x00FF00:0.3:0.1" } },
    ];
    for (const effect of keyed) {
      const t = oneClip({ effects: [effect] });
      const base = buildRenderCommand(t, OUT).filterComplex;
      // 0.27.0: the key is written into the alpha plane before format=yuva420p, and the aperture geq multiplies THAT alpha (alpha(X,Y)*...), so the key survives
      expect(base, JSON.stringify(effect)).toMatch(
        /(chromakey|colorkey)=[^,]*(,threads=1)?,format=yuva420p,.*geq=lum='lum\(X,Y\)':cb='cb\(X,Y\)':cr='cr\(X,Y\)':a='alpha\(X,Y\)\*gte\(X,/,
      );
      const { lean } = answered(t);
      const plan = buildRenderCommand(t, OUT, { lean });
      // 0.27.0 multiplies the key's alpha in the aperture geq; alphamerge would REPLACE that plane, so the clip keeps its geq
      expect(plan.lean, JSON.stringify(effect)).toEqual({ ran: [], kept: ["not_proven"] });
      expect(plan.filterComplex, JSON.stringify(effect)).toBe(base);
    }
  });
});

describe("RISK (fixed): a custom effect can change the picture's size or pixel format between the probe and the merge", () => {
  it("the clip keeps today's geq for each of them (nothing that can resize the picture sits between the probed pre-scale and the merge)", () => {
    for (const expr of [
      "crop=iw/2:ih/2",
      "pad=iw+100:ih",
      "scale=640:360",
      "transpose=1",
      "hflip,rotate=0.3",
    ]) {
      const t = oneClip({ effects: [{ type: "custom", params: { expr } }] });
      const { lean } = answered(t);
      const plan = buildRenderCommand(t, OUT, { lean });
      expect(plan.lean, expr).toEqual({ ran: [], kept: ["not_proven"] });
      expect(plan.filterComplex, expr).toBe(buildRenderCommand(t, OUT).filterComplex);
    }
  });
});

describe("RISK (fixed): a constant opacity puts an RGB-only filter between the mask and the zoom scale", () => {
  it("the clip keeps today's geq: the pixel-format path in front of the zoom scale would differ", () => {
    const t = oneClip({ opacity: 0.5 });
    const base = buildRenderCommand(t, OUT).filterComplex;
    expect(base).toMatch(
      /colorchannelmixer=aa=0\.5000,geq=lum='lum\(X,Y\)'[^;]*gte\(X,[^;]*,scale=w='max\(2,round\(/,
    );
    const { lean } = answered(t);
    const plan = buildRenderCommand(t, OUT, { lean });
    expect(plan.lean).toEqual({ ran: [], kept: ["not_proven"] });
    expect(plan.filterComplex).toBe(base);
  });
});
