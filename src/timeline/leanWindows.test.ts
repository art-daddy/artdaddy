// Fix 2 (Phase 3a): the windows that let a clip's alpha `geq` skip the frames where it multiplies by exactly 1, and the frames of the dip's colour layer.
//
// Every property is judged against the expression text the REAL builder (`buildRenderCommand`) writes, evaluated frame by frame and column by column by an
// evaluator written in this file, independent of leanExpr.ts. The rules are about the picture, so they survive a rewrite of leanWindows.ts:
//   SUPERSET  wherever the factor is not exactly 1, at ANY column, the window is open. A frame's time is only known to a microsecond (a time printed to six
//             places is off by up to 5e-7, and ffmpeg's pts times its time base is a float step away from k / fps), so "wherever" includes the frame's time moved by that.
//   TIGHT     an open frame whose factor is 1 lies within two frames of one that needs the filter (a window of `1` would pass SUPERSET and gain nothing).
//   WIPE-R    its factor is 1 on no late frame (that is 0.27.0's defect), so its rule is its own: open before E + half a frame, closed from there on.
//   CONTROLS  every rule is also run against a deliberately broken window, and the oracle must report it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import schema from "../contract/timeline.schema.json";
import {
  dipLayerFrames,
  fadeWindow,
  opacityWindow,
  transitionWindow,
  transitionWindowRule,
} from "./leanWindows";
import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";
import { framesOf } from "./renderPlan";
import { TRANSITION_KINDS, type TransitionKind } from "./transition";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The closed list of easings, read from the contract itself. */
const EASINGS = (schema as { $defs: { keyframe: { properties: { ease: { enum: string[] } } } } })
  .$defs.keyframe.properties.ease.enum;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The reference evaluator: the SAME text run as JavaScript, with ffmpeg's functions written out independently (a test may use new Function; the product may not).
// ---------------------------------------------------------------------------------------------------------------------------------------------------

interface Env {
  T: number;
  X?: number;
  W?: number;
}

const FFMPEG = {
  _if: (c: number, a: number, b: number) => (c !== 0 ? a : b),
  lt: (a: number, b: number) => (a < b ? 1 : 0),
  lte: (a: number, b: number) => (a <= b ? 1 : 0),
  gt: (a: number, b: number) => (a > b ? 1 : 0),
  gte: (a: number, b: number) => (a >= b ? 1 : 0),
  between: (x: number, lo: number, hi: number) => (x >= lo && x <= hi ? 1 : 0),
  eq: (a: number, b: number) => (a === b ? 1 : 0),
  not: (x: number) => (x === 0 ? 1 : 0),
  max: (a: number, b: number) => (a > b ? a : b),
  min: (a: number, b: number) => (a < b ? a : b),
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs,
  pow: (x: number, y: number) => x ** y,
  clip: (x: number, lo: number, hi: number) =>
    Number.isNaN(x) ? NaN : x < lo ? lo : x > hi ? hi : x,
  alpha: () => 1,
};

function reference(text: string): (env: Env) => number {
  // JavaScript reads `T--0.25` as a decrement, ffmpeg as T - (-0.25)
  const body = text.replace(/\bif\(/g, "_if(").replace(/--/g, "- -");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function("T", "t", "X", "Y", "W", "H", ...Object.keys(FFMPEG), `return (${body});`);
  const functions = Object.values(FFMPEG);
  return (env) => Number(f(env.T, env.T, env.X ?? 0, 0, env.W ?? 0, 0, ...functions));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The real builder
// ---------------------------------------------------------------------------------------------------------------------------------------------------

function timelineOf(grid: number, clips: Any[]): Timeline {
  return {
    // a whole-number rate is authored the way a project is, in frames; any other rate in seconds (the text does not depend on the rate)
    ...(Number.isInteger(grid) ? { units: "frames" } : {}),
    canvas: { width: 64, height: 36, fps: Math.trunc(grid) },
    tracks: [{ id: "v0", kind: "video", z: 0, clips }],
  } as Timeline;
}

const authored = (grid: number) => (frames: number) =>
  Number.isInteger(grid) ? frames : frames / grid;

/** The graph of a project and the alpha factors in it, `alpha(X,Y)*` removed (the dip's colour layer has none). */
function graphOf(timeline: Timeline): { graph: string; factors: string[] } {
  const graph = buildRenderCommand(timeline, "/o.mp4").filterComplex;
  return { graph, factors: [...graph.matchAll(/:a='alpha\(X,Y\)\*([^']*)'/g)].map((m) => m[1]) };
}

const video = (extra: Any): Any => ({ media_ref: "/b.mp4", source_in: 0, ...extra });

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The audit: which frames need the filter, which are open, and the two rules
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** A time printed to six places is off by up to 5e-7; the three numbers of an edge by 1.5e-6. */
const SLACK = 2e-6;
/** The module counts a frame within this of E + half a frame as past it (ties go closed). */
const TIE_BAND = 5e-6;

const COLUMN_WIDTHS = [2, 3, 10, 1080];
const PROBES = COLUMN_WIDTHS.flatMap((W) =>
  [...new Set([0, 1, 2, Math.floor(W / 2), W - 2, W - 1])]
    .filter((X) => X >= 0 && X < W)
    .map((X) => ({ W, X })),
);

function stepUlp(x: number, direction: 1 | -1): number {
  if (x === 0) return direction * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigInt64(0, view.getBigInt64(0) + (x > 0 === direction > 0 ? 1n : -1n));
  return view.getFloat64(0);
}

/** The times a frame's time may be read as: itself, a microsecond either way (printing). */
const printingTimes = (grid: number) => (k: number) => [
  k / grid,
  k / grid - SLACK,
  k / grid + SLACK,
];
/** ... or the float steps around k / fps and k * (1 / fps), the two ways of computing it (pts times the time base). */
const floatTimes = (grid: number) => (k: number) => {
  const a = k / grid;
  const b = k * (1 / grid);
  return [a, b, stepUlp(a, 1), stepUlp(a, -1), stepUlp(b, 1), stepUlp(b, -1)];
};

interface Audit {
  /** frames where the filter is needed (at any time the frame might be read as) but the window is closed at some such time */
  missed: number[];
  /** open frames whose factor is exactly 1 */
  idle: number;
  /** open frames with factor 1 more than two frames away from every frame that needs the filter */
  far: number[];
}

function audit(
  ks: number[],
  needs: (T: number) => boolean,
  window: string | null,
  times: (k: number) => number[],
  /** the frames whose slack counts: the frames the clip is drawn on (the audited range reaches past them, where only SUPERSET matters) */
  counted: (k: number) => boolean = () => true,
  /** a frame that needs the filter only at a float step of its time still needs it: a curve may touch 1 on one isolated frame, and the window then rightly holds that frame alone */
  anyReading = false,
): Audit {
  const evaluate = window === null ? null : reference(window);
  const isOpen = (T: number) => evaluate === null || Math.abs(evaluate({ T })) >= 0.5;
  const rows = ks.map((k) => {
    const [exact, ...others] = times(k);
    const neededExact = needs(exact);
    return {
      k,
      neededExact,
      needed: neededExact || others.some(needs),
      openExact: isOpen(exact),
      open: isOpen(exact) && others.every(isOpen),
    };
  });
  const anchors = (r: (typeof rows)[number]): boolean => (anyReading ? r.needed : r.neededExact);
  const idleRows = rows.filter((r) => r.openExact && !anchors(r) && counted(r.k));
  return {
    missed: rows.filter((r) => r.needed && !r.open).map((r) => r.k),
    idle: idleRows.length,
    far: idleRows
      .filter((r) => !rows.some((o) => anchors(o) && Math.abs(o.k - r.k) <= 2))
      .map((r) => r.k),
  };
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

const sound = (a: Audit, edges: number): boolean =>
  a.missed.length === 0 && a.far.length === 0 && a.idle <= 2 * edges;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------------------------------------------------------------

interface TransitionCase {
  grid: number;
  tin: number;
  n: number;
  extra: number;
}

interface TransitionRun extends TransitionCase {
  kind: TransitionKind;
  /** the factor the builder wrote, alpha(X,Y)* removed */
  factor: string;
  /** what the builder holds before it prints (render.ts: start = tin - leadIn, leadIn = durSec / 2) */
  startSec: number;
  durSec: number;
  /** the numbers the text prints, as text and as numbers */
  startText: string;
  durText: string;
  start6: number;
  dur6: number;
  real: string | null;
}

function transitionRun(kind: TransitionKind, c: TransitionCase): TransitionRun {
  const at = authored(c.grid);
  const lenB = c.n + c.extra;
  const clips: Any[] = [];
  if (c.tin > 0)
    clips.push(
      video({
        media_ref: "/a.mp4",
        source_out: at(c.tin),
        timeline_in: 0,
        timeline_out: at(c.tin),
      }),
    );
  clips.push(
    video({
      source_out: at(lenB),
      timeline_in: at(c.tin),
      timeline_out: at(c.tin + lenB),
      transition_in: { kind, duration: at(c.n) },
    }),
  );
  const { factors } = graphOf(timelineOf(c.grid, clips));
  expect(factors, `${kind}: one alpha filter on the incoming clip`).toHaveLength(1);
  const durSec = c.n / c.grid;
  const startSec = c.tin / c.grid - durSec / 2;
  const printedPair = /clip\(\(T-(-?\d+\.\d{6})\)\/(\d+\.\d{6}),0,1\)/.exec(factors[0]);
  expect(printedPair, factors[0]).not.toBeNull();
  const [, startText, durText] = printedPair!;
  // the numbers handed to the window function are the ones the builder printed
  expect(Number(startText)).toBe(Number(startSec.toFixed(6)));
  expect(Number(durText)).toBe(Number(durSec.toFixed(6)));
  return {
    ...c,
    kind,
    factor: factors[0],
    startSec,
    durSec,
    startText,
    durText,
    start6: Number(startText),
    dur6: Number(durText),
    real: transitionWindow(kind, startSec, durSec, c.grid),
  };
}

/** Frames from three before the transition begins to two seconds after it ends. */
function transitionFrames(run: TransitionRun): number[] {
  return range(
    Math.floor(run.start6 * run.grid) - 3,
    Math.ceil((run.start6 + run.dur6) * run.grid) + Math.ceil(2 * run.grid),
  );
}

const needsAtAnyColumn = (factor: (env: Env) => number) => (T: number) =>
  PROBES.some(({ W, X }) => factor({ T, W, X }) !== 1);

function auditTransition(run: TransitionRun, window: string | null): Audit {
  return audit(
    transitionFrames(run),
    needsAtAnyColumn(reference(run.factor)),
    window,
    printingTimes(run.grid),
  );
}

const GRIDS = [24, 25, 30, 50, 60, 23.976, 29.97, 59.94];
const transitionCase: fc.Arbitrary<TransitionCase> = fc.record({
  grid: fc.constantFrom(...GRIDS),
  tin: fc.integer({ min: 0, max: 3000 }),
  n: fc.integer({ min: 1, max: 120 }),
  extra: fc.integer({ min: 0, max: 90 }),
});

const WINDOWED_KINDS = TRANSITION_KINDS.filter((kind) => kind !== "wipe-r");

describe("transitionWindow: every kind but wipe-right", () => {
  it.each(WINDOWED_KINDS)(
    "%s: the window is open wherever the factor is not 1, at any column, and closes soon after",
    (kind) => {
      fc.assert(
        fc.property(transitionCase, (c) => {
          const run = transitionRun(kind, c);
          expect(run.real, "a window exists").not.toBeNull();
          const a = auditTransition(run, run.real);
          expect(a, JSON.stringify({ c, window: run.real })).toMatchObject({ missed: [], far: [] });
          expect(a.idle, `${JSON.stringify(c)} ${run.real}`).toBeLessThanOrEqual(2);
        }),
        { numRuns: 60 },
      );
    },
  );

  it("a transition on the project's first frame starts before time 0 and is still covered", () => {
    for (const kind of WINDOWED_KINDS) {
      const run = transitionRun(kind, { grid: 30, tin: 0, n: 15, extra: 60 });
      expect(run.start6).toBeLessThan(0);
      expect(sound(auditTransition(run, run.real), 1), kind).toBe(true);
    }
  });

  it("whip: the factor is exactly 1 for every column of every canvas width once p is 1", () => {
    const run = transitionRun("whip", { grid: 30, tin: 60, n: 15, extra: 30 });
    const factor = reference(run.factor);
    const late = run.start6 + run.dur6 + 1;
    for (let W = 2; W <= 1100; W += 1) {
      const columns = new Set([0, 1, 2, Math.floor(W / 2), W - 2, W - 1]);
      for (let X = 0; X < W; X += W < 40 ? 1 : 97) columns.add(X);
      for (const X of columns)
        if (X >= 0) expect(factor({ T: late, W, X }), `W=${W} X=${X}`).toBe(1);
    }
    // far wider than any canvas: the numerator never falls below 0.12 + 1/W, which stays above 0.12 in doubles until W is about 1e15
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 2 ** 40 }), (W) => {
        for (const X of [0, 1, Math.floor(W / 2), W - 2, W - 1])
          expect(factor({ T: late, W, X })).toBe(1);
      }),
      { numRuns: 200 },
    );
  });

  it("agrees with the table: a kind the table calls windowed has a window for every kind of the model's own list", () => {
    const DECISIONS: Record<TransitionKind, boolean> = {
      crossfade: true,
      "dip-to-black": true,
      "dip-to-white": true,
      whip: true,
      "wipe-l": true,
      "wipe-r": true,
      custom: true,
    };
    expect(Object.keys(DECISIONS).sort()).toEqual([...TRANSITION_KINDS].sort());
    const inSchema = (
      schema as { $defs: { transition: { properties: { kind: { enum: string[] } } } } }
    ).$defs.transition.properties.kind.enum;
    expect([...inSchema].sort()).toEqual([...TRANSITION_KINDS].sort());
    for (const kind of TRANSITION_KINDS) {
      const rule = transitionWindowRule(kind);
      expect(rule.closes, kind).toBe(DECISIONS[kind]);
      expect(rule.why.length, `${kind} says why`).toBeGreaterThan(20);
      expect(transitionWindow(kind, 1.75, 0.5, 30) !== null, kind).toBe(DECISIONS[kind]);
    }
  });

  it("walks every kind through a fixed grid of rates, lengths and positions, odd and even frame counts included", () => {
    for (const kind of WINDOWED_KINDS)
      for (const grid of [24, 30, 60])
        for (const n of [1, 2, 3, 15, 16, 31])
          for (const tin of [0, 37, 100]) {
            const run = transitionRun(kind, { grid, tin, n, extra: 40 });
            expect(
              sound(auditTransition(run, run.real), 1),
              `${kind} ${grid} fps, ${n} frames at ${tin}: ${run.real}`,
            ).toBe(true);
          }
  });
});

/** The ways a window can be wrong, as edits of the real window's text. */
function threshold(real: string): number {
  const m = /^lt\(t,(-?\d+\.\d{6})\)$/.exec(real);
  expect(m, real).not.toBeNull();
  return Number(m![1]);
}
const six = (x: number) => x.toFixed(6);

const TRANSITION_MUTANTS: Record<string, (run: TransitionRun) => string | null> = {
  "the margin removed: lt(t, E)": (run) => `lt(t,${six(run.start6 + run.dur6)})`,
  "one frame short": (run) => `lt(t,${six(threshold(run.real!) - 1 / run.grid)})`,
  "two frames short": (run) => `lt(t,${six(threshold(run.real!) - 2 / run.grid)})`,
  "starting at the transition, not at the clip's first frame": (run) =>
    `between(t,${six(run.start6)},${six(threshold(run.real!))})`,
  "no window at all (the unwindowed filter): wide open": () => null,
};

describe("transitionWindow: negative controls (the oracle can fail)", () => {
  for (const kind of WINDOWED_KINDS)
    for (const [name, mutant] of Object.entries(TRANSITION_MUTANTS)) {
      // wipe-l and whip are exactly 1 for every column once 1 - p is below 1 / W, so a window that ends at E instead of half a frame later
      // changes no picture at a microsecond's difference (W of 1080 or less): that control is not the oracle's to see for these two
      if (name.startsWith("the margin removed") && (kind === "wipe-l" || kind === "whip")) continue;
      it(`${kind}: ${name} is reported`, () => {
        const outcome = fc.check(
          fc.property(transitionCase, (c) => {
            const run = transitionRun(kind, c);
            return sound(auditTransition(run, mutant(run)), 1);
          }),
          { numRuns: 80, seed: 11, endOnFailure: true },
        );
        expect(outcome.failed, `${kind}: ${name} went unnoticed`).toBe(true);
      });
    }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Wipe-right: the one kind whose factor is NOT 1 at the end
// ---------------------------------------------------------------------------------------------------------------------------------------------------

interface WipeFaults {
  faults: string[];
  /** frames in [E, E + half a frame) that are open */
  openInBand: number;
}

function auditWipeRight(run: TransitionRun, window: string | null): WipeFaults {
  const evaluate = window === null ? null : reference(window);
  const isOpen = (T: number) => evaluate === null || Math.abs(evaluate({ T })) >= 0.5;
  const factor = reference(run.factor);
  const progress = reference(`clip((T-${run.startText})/${run.durText},0,1)`);
  const end = run.start6 + run.dur6;
  const edge = end + 0.5 / run.grid - TIE_BAND;
  const faults: string[] = [];
  let openInBand = 0;
  for (const k of transitionFrames(run)) {
    const T = k / run.grid;
    const times = [T, T - SLACK, T + SLACK];
    if (times.some((s) => progress({ T: s }) < 1) && !times.every(isOpen))
      faults.push(`frame ${k}: p < 1 but the window is closed`);
    if (T >= edge) {
      if (isOpen(T)) faults.push(`frame ${k}: from E + half a frame on, but the window is open`);
      for (const { W, X } of PROBES)
        if (factor({ T, W, X }) !== (X > 0 ? 1 : 0))
          faults.push(`frame ${k}: the late factor at column ${X} of ${W} is not gt(X,0)`);
    } else {
      if (!isOpen(T)) faults.push(`frame ${k}: before E + half a frame, but the window is closed`);
      if (T >= end && isOpen(T)) openInBand += 1;
    }
  }
  return { faults, openInBand };
}

describe("transitionWindow: wipe-right closes where it is allowed to and nowhere else", () => {
  it("is open on every frame before E + half a frame, closed on every frame from there on, with at most one frame in between", () => {
    fc.assert(
      fc.property(transitionCase, (c) => {
        const run = transitionRun("wipe-r", c);
        expect(run.real).not.toBeNull();
        const a = auditWipeRight(run, run.real);
        expect(a.faults, JSON.stringify({ c, window: run.real })).toEqual([]);
        expect(a.openInBand).toBeLessThanOrEqual(1);
      }),
      { numRuns: 150 },
    );
  });

  it("today's factor on a late frame is gt(X,0): column 0 is 0 and every other column is 1, so only the alpha of column 0 differs", () => {
    const run = transitionRun("wipe-r", { grid: 30, tin: 60, n: 15, extra: 60 });
    expect(run.factor).toContain("gt(X,W*(1-clip(");
    const factor = reference(run.factor);
    const late = range(70, 150).map((k) => k / 30);
    for (const T of late)
      for (const { W, X } of PROBES)
        expect(factor({ T, W, X }), `T=${T} X=${X}/${W}`).toBe(X > 0 ? 1 : 0);
  });

  it("an odd number of frames puts E + half a frame ON a frame time: the module closes that frame, the literal bound leaves it to the sixth decimal", () => {
    // 15 frames at 30 fps from frame 60: E = 2.25 (a half frame), E + half a frame = 68/30
    const literal = `lt(t,${six(1.75 + 0.5 + 0.5 / 30)})`;
    expect(literal).toBe("lt(t,2.266667)");
    expect(reference(literal)({ T: 68 / 30 })).toBe(1);
    const mine = transitionWindow("wipe-r", 1.75, 0.5, 30)!;
    expect(reference(mine)({ T: 67 / 30 })).toBe(1);
    expect(reference(mine)({ T: 68 / 30 })).toBe(0);
    // an even number of frames: E is a frame time and that one frame stays open, as 0.27.0 has it
    const even = transitionWindow("wipe-r", 2 - 8 / 30, 16 / 30, 30)!;
    expect(reference(even)({ T: 68 / 30 })).toBe(1);
    expect(reference(even)({ T: 69 / 30 })).toBe(0);
  });

  it("closes the frame that sits ON E + half a frame, for every odd frame count, rate and position (and keeps the frame at E open for an even one)", () => {
    for (const grid of [24, 25, 30, 50, 60])
      for (const n of [1, 3, 5, 7, 9, 11, 13, 15, 17, 25, 31, 59, 61])
        for (const tin of [0, 1, 37, 59, 100, 1001]) {
          const window = transitionWindow("wipe-r", tin / grid - n / grid / 2, n / grid, grid)!;
          const open = reference(window);
          // E = tin + n / 2 frames is a half frame: the last frame with p < 1 is the one before it, the first frame with p = 1 is E + half a frame
          const lastWipeFrame = tin + (n - 1) / 2;
          const label = `${n} frames at ${tin}, ${grid} fps: ${window}`;
          expect(open({ T: lastWipeFrame / grid }), label).toBe(1);
          expect(open({ T: (lastWipeFrame + 1) / grid }), label).toBe(0);
          // an even count: E is a frame time, that frame stays open (it is 0.27.0's) and the next is closed
          const evenWindow = transitionWindow(
            "wipe-r",
            tin / grid - (n + 1) / grid / 2,
            (n + 1) / grid,
            grid,
          )!;
          const evenOpen = reference(evenWindow);
          expect(evenOpen({ T: (tin + (n + 1) / 2) / grid }), `E, ${label}`).toBe(1);
          expect(evenOpen({ T: (tin + (n + 1) / 2 + 1) / grid }), `E + 1, ${label}`).toBe(0);
        }
  });

  const WIPE_MUTANTS: Record<string, (run: TransitionRun) => string | null> = {
    "one frame short (the last wipe frame loses its mask)": (run) =>
      `lt(t,${six(threshold(run.real!) - 1 / run.grid)})`,
    "one frame long (the first late frame keeps today's line)": (run) =>
      `lt(t,${six(threshold(run.real!) + 1 / run.grid)})`,
    "never closes (the unwindowed filter)": () => null,
    "the literal lt(t, E + half a frame), which is a frame time for an odd frame count": (run) =>
      `lt(t,${six(run.start6 + run.dur6 + 0.5 / run.grid)})`,
  };

  for (const [name, mutant] of Object.entries(WIPE_MUTANTS))
    it(`negative control: ${name} is reported`, () => {
      const outcome = fc.check(
        fc.property(transitionCase, (c) => {
          const run = transitionRun("wipe-r", c);
          const a = auditWipeRight(run, mutant(run));
          return a.faults.length === 0 && a.openInBand <= 1;
        }),
        { numRuns: 150, seed: 5, endOnFailure: true },
      );
      expect(outcome.failed, `${name} went unnoticed`).toBe(true);
    });

  it("negative control: a factor that is not today's (gte instead of gt) is reported by the late-frame check", () => {
    const run = transitionRun("wipe-r", { grid: 30, tin: 60, n: 15, extra: 60 });
    const broken = { ...run, factor: run.factor.replace("gt(X,", "gte(X,") };
    expect(auditWipeRight(broken, run.real).faults.some((f) => f.includes("is not gt(X,0)"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Fades
// ---------------------------------------------------------------------------------------------------------------------------------------------------

interface FadeCase {
  fps: number;
  tin: number;
  len: number;
  fin: number;
  fout: number;
}

interface FadeRun extends FadeCase {
  factor: string | null;
  tinSec: number;
  toutSec: number;
  inSec: number;
  outSec: number;
  real: string | null;
}

function fadeRun(c: FadeCase): FadeRun {
  const clip = video({
    source_out: c.len,
    timeline_in: c.tin,
    timeline_out: c.tin + c.len,
    fade: { in: c.fin, out: c.fout },
  });
  const { factors } = graphOf(timelineOf(c.fps, [clip]));
  const tinSec = c.tin / c.fps;
  const toutSec = (c.tin + c.len) / c.fps;
  const inSec = c.fin / c.fps;
  const outSec = c.fout / c.fps;
  expect(factors.length, "at most one fade filter").toBeLessThanOrEqual(1);
  expect(factors.length === 1, "a fade filter exists exactly when a fade is above 0").toBe(
    c.fin > 0 || c.fout > 0,
  );
  if (factors.length === 1) {
    // the numbers handed to the window function are the ones the builder printed
    if (c.fin > 0) expect(factors[0]).toContain(`(T-${tinSec.toFixed(6)})/${inSec.toFixed(6)}`);
    if (c.fout > 0) expect(factors[0]).toContain(`(${toutSec.toFixed(6)}-T)/${outSec.toFixed(6)}`);
  }
  return {
    ...c,
    factor: factors[0] ?? null,
    tinSec,
    toutSec,
    inSec,
    outSec,
    real: fadeWindow(tinSec, toutSec, inSec, outSec, c.fps),
  };
}

function auditFade(run: FadeRun, window: string | null): Audit {
  const factor = reference(run.factor!);
  const { first, end } = framesOf({ from: run.tinSec, to: run.toutSec }, run.fps);
  const frames = range(first - 3, Math.ceil(run.toutSec * run.fps) + Math.ceil(2 * run.fps));
  // the hold clones after the clip's end must be covered; the slack is judged on the clip's own frames
  return audit(
    frames,
    (T) => factor({ T }) !== 1,
    window,
    printingTimes(run.fps),
    (k) => k >= first && k < end,
  );
}

const fadeCase: fc.Arbitrary<FadeCase> = fc.record({
  fps: fc.constantFrom(24, 25, 30, 50, 60),
  tin: fc.integer({ min: 0, max: 2000 }),
  len: fc.integer({ min: 1, max: 600 }),
  fin: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 300 })),
  fout: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 900 })),
});

const edgesOf = (c: FadeCase) => Number(c.fin > 0) + Number(c.fout > 0);

/** The whole frames of the clip on which a window is closed at the frame's own time (read the way ffmpeg reads `enable`); a null window closes none. */
function closedFrames(run: FadeRun, window: string | null): number {
  if (window === null) return 0;
  const open = reference(window);
  let n = 0;
  for (let k = run.tin; k < run.tin + run.len; k++)
    if (Math.abs(open({ T: k / run.fps })) < 0.5) n++;
  return n;
}

/** A fade whose frame counts leave exactly `closed` whole frames between the two ramps (the first frame at or past a ramp's end is a frame it still touches), of each shape. */
function closedWalk(fps: number, tin: number, closed: number): Record<string, FadeCase> {
  return {
    "out only": { fps, tin, len: closed + 3, fin: 0, fout: 3 },
    "in only": { fps, tin, len: closed + 3 + 1, fin: 3, fout: 0 },
    both: { fps, tin, len: closed + 3 + 3 + 1, fin: 3, fout: 3 },
  };
}

describe("fadeWindow", () => {
  it("is open wherever the fade factor is not 1 (in only, out only, both, ramps that overlap, a fade longer than the clip) and closed in between", () => {
    fc.assert(
      fc.property(fadeCase, (c) => {
        const run = fadeRun(c);
        if (run.factor === null) {
          expect(run.real, "no fade, no window").toBeNull();
          return;
        }
        const a = auditFade(run, run.real);
        expect(a, JSON.stringify({ c, window: run.real })).toMatchObject({ missed: [], far: [] });
        expect(a.idle, `${JSON.stringify(c)} ${run.real}`).toBeLessThanOrEqual(2 * edgesOf(c));
        // a window is worth writing only when it closes two whole frames or more (a declined window is today's filter, and the tightness above bounds what it leaves idle)
        if (run.real !== null)
          expect(
            closedFrames(run, run.real),
            `${JSON.stringify(c)} ${run.real}`,
          ).toBeGreaterThanOrEqual(2);
      }),
      {
        numRuns: 150,
        examples: [
          // found by the real pre-push hook (16 Nov): no fade-in and a fade-out that leaves two frames at full opacity, so three frames have factor 1; the window was declined and all three stayed open
          [{ fps: 30, tin: 0, len: 419, fin: 0, fout: 417 }],
          [{ fps: 24, tin: 0, len: 4, fin: 0, fout: 2 }],
          // its mirror, found by the walk below: a fade-in with one whole frame left closed was given a window when its clip's end printed a hair above its frame
          [{ fps: 12, tin: 0, len: 5, fin: 3, fout: 0 }],
          [{ fps: 12, tin: 0, len: 4, fin: 0, fout: 3 }],
          [{ fps: 30, tin: 0, len: 1800, fin: 30, fout: 30 }],
          [{ fps: 30, tin: 30, len: 600, fin: 15, fout: 0 }],
          [{ fps: 30, tin: 30, len: 600, fin: 0, fout: 15 }],
          [{ fps: 30, tin: 10, len: 40, fin: 30, fout: 30 }],
          [{ fps: 30, tin: 10, len: 60, fin: 0, fout: 200 }],
          [{ fps: 30, tin: 10, len: 60, fin: 60, fout: 0 }],
          [{ fps: 30, tin: 10, len: 60, fin: 0, fout: 60 }],
          [{ fps: 30, tin: 10, len: 60, fin: 30, fout: 30 }],
          [{ fps: 25, tin: 59, len: 400, fin: 37, fout: 41 }],
          [{ fps: 30, tin: 0, len: 90, fin: 0, fout: 0 }],
        ],
      },
    );
  });

  it("writes the two half-lines the design shows", () => {
    expect(fadeWindow(0, 60, 1, 1, 30)).toBe("lte(t,1.016667)+gte(t,58.983333)");
    expect(fadeWindow(0, 60, 1, 0, 30)).toBe("lte(t,1.016667)");
    expect(fadeWindow(0, 60, 0, 1, 30)).toBe("gte(t,58.983333)");
  });

  it("writes a window exactly when two whole frames stay closed, decided from the frame counts alone, wherever the clip's start prints (every start frame of one period of each rate)", () => {
    for (const fps of [12, 24, 25, 30, 48, 50, 60, 120])
      for (let tin = 0; tin < fps; tin++)
        for (const closed of [0, 1, 2, 3, 4])
          for (const [shape, c] of Object.entries(closedWalk(fps, tin, closed))) {
            const run = fadeRun(c);
            const where = `${shape} ${JSON.stringify(c)} ${run.real}`;
            const a = auditFade(run, run.real);
            expect(a, where).toMatchObject({ missed: [], far: [] });
            expect(a.idle, where).toBeLessThanOrEqual(2 * edgesOf(c));
            expect(
              run.real !== null,
              `${where}: ${closed} whole frames stay closed, so a window is written exactly when that is 2 or more`,
            ).toBe(closed >= 2);
          }
  });

  const FADE_MUTANTS: Record<string, (run: FadeRun) => string | null> = {
    "the margin removed": (run) => {
      const parts: string[] = [];
      if (run.inSec > 0)
        parts.push(`lte(t,${six(Number(run.tinSec.toFixed(6)) + Number(run.inSec.toFixed(6)))})`);
      if (run.outSec > 0)
        parts.push(`gte(t,${six(Number(run.toutSec.toFixed(6)) - Number(run.outSec.toFixed(6)))})`);
      return parts.join("+");
    },
    "each half-line one frame short": (run) => {
      const parts: string[] = [];
      for (const m of run.real!.matchAll(/(lte|gte)\(t,(-?\d+\.\d{6})\)/g))
        parts.push(`${m[1]}(t,${six(Number(m[2]) + (m[1] === "lte" ? -1 : 1) / run.fps)})`);
      return parts.join("+");
    },
    "the fade-in half-line only (the out ramp forgotten)": (run) =>
      `lte(t,${six(Number(run.tinSec.toFixed(6)) + Number(run.inSec.toFixed(6)) + 0.5 / run.fps)})`,
    "the fade-out half-line only (the in ramp forgotten)": (run) =>
      `gte(t,${six(Number(run.toutSec.toFixed(6)) - Number(run.outSec.toFixed(6)) - 0.5 / run.fps)})`,
    "no window at all: wide open": () => null,
  };

  for (const [name, mutant] of Object.entries(FADE_MUTANTS))
    it(`negative control: ${name} is reported`, () => {
      const outcome = fc.check(
        fc.property(fadeCase, (c) => {
          const run = fadeRun(c);
          if (run.factor === null || run.real === null) return true;
          // a mutant that is not a window of this case (a fade that does not exist) is not the one under test
          if (name.includes("in half-line only") && !(c.fin > 0 && c.fout > 0)) return true;
          if (name.includes("out half-line only") && !(c.fin > 0 && c.fout > 0)) return true;
          return sound(auditFade(run, mutant(run)), edgesOf(c));
        }),
        { numRuns: 150, seed: 3, endOnFailure: true },
      );
      expect(outcome.failed, `${name} went unnoticed`).toBe(true);
    });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Animated opacity
// ---------------------------------------------------------------------------------------------------------------------------------------------------

interface Key {
  t: number;
  v: number;
  ease?: string;
}

interface OpacityCase {
  fps: number;
  tin: number;
  len: number;
  keys: Key[];
}

interface OpacityRun extends OpacityCase {
  curve: string;
  full: string;
  first: number;
  end: number;
  real: string | null;
}

function opacityRun(c: OpacityCase): OpacityRun {
  const clip = video({
    source_out: c.len,
    timeline_in: c.tin,
    timeline_out: c.tin + c.len,
    opacity: c.keys,
  });
  const { graph, factors } = graphOf(timelineOf(c.fps, [clip]));
  expect(factors, "one opacity filter").toHaveLength(1);
  const parts = /^clip\(\((.*)\),0,1\)$/.exec(factors[0]);
  expect(parts, factors[0]).not.toBeNull();
  const { first, end } = framesOf({ from: c.tin / c.fps, to: (c.tin + c.len) / c.fps }, c.fps);
  // the frames handed to the window function are the ones the builder gates the clip on
  expect(graph).toContain(
    `between(t,${((first - 0.5) / c.fps).toFixed(6)},${((end - 0.5) / c.fps).toFixed(6)})`,
  );
  return {
    ...c,
    curve: parts![1],
    full: factors[0],
    first,
    end,
    real: opacityWindow(parts![1], first, end, c.fps),
  };
}

function opacityFrames(run: OpacityRun): number[] {
  return range(run.first - 2, run.end + 1);
}

function auditOpacity(run: OpacityRun, window: string | null): Audit {
  const factor = reference(run.full);
  return audit(
    opacityFrames(run),
    (T) => factor({ T }) !== 1,
    window,
    floatTimes(run.fps),
    (k) => k >= run.first && k < run.end,
    true,
  );
}

/** Frames beyond the evaluated range: when the first (last) evaluated frame needs the filter the window must stay open past it. */
function openBeyond(run: OpacityRun, window: string | null): string[] {
  const factor = reference(run.full);
  const evaluate = window === null ? null : reference(window);
  const isOpen = (k: number) => evaluate === null || Math.abs(evaluate({ T: k / run.fps })) >= 0.5;
  const faults: string[] = [];
  const firstEvaluated = run.first - 2;
  const lastEvaluated = run.end + 1;
  if (factor({ T: firstEvaluated / run.fps }) !== 1)
    for (const k of range(firstEvaluated - 10, firstEvaluated - 1))
      if (!isOpen(k)) faults.push(`frame ${k} before the range`);
  if (factor({ T: lastEvaluated / run.fps }) !== 1)
    for (const k of range(lastEvaluated + 1, lastEvaluated + 10))
      if (!isOpen(k)) faults.push(`frame ${k} after the range`);
  return faults;
}

const valueArb = fc.oneof(
  fc.constantFrom(-0.5, 0, 0.25, 0.5, 0.75, 0.999999, 1, 1.0000004, 1.5, 3),
  fc.double({ min: -0.2, max: 1.4, noNaN: true }),
);
const easeArb = fc.constantFrom<string | undefined>(...EASINGS, undefined);

const keysArb: fc.Arbitrary<Key[]> = fc
  .array(fc.record({ gap: fc.integer({ min: 1, max: 150 }), v: valueArb, ease: easeArb }), {
    minLength: 1,
    maxLength: 6,
  })
  .map((rows) => {
    let t = -1;
    return rows.map((row) => {
      t += row.gap;
      return row.ease === undefined ? { t, v: row.v } : { t, v: row.v, ease: row.ease };
    });
  });

const opacityCase: fc.Arbitrary<OpacityCase> = fc.record({
  fps: fc.constantFrom(24, 25, 30, 50, 60),
  tin: fc.integer({ min: 0, max: 300 }),
  len: fc.integer({ min: 20, max: 500 }),
  keys: keysArb,
});

/** How many separate stretches need the filter (frames at most three apart belong to one), and the share of the drawn frames lying more than two frames from any that does. */
function slackOf(run: OpacityRun): { stretches: number; share: number } {
  const factor = reference(run.full);
  const times = floatTimes(run.fps);
  const needed = opacityFrames(run).filter((k) => times(k).some((T) => factor({ T }) !== 1));
  let stretches = 0;
  let previous = -Infinity;
  for (const k of needed) {
    if (k - previous > 3) stretches += 1;
    previous = k;
  }
  const drawn = range(run.first, run.end - 1);
  const closable = drawn.filter((k) => needed.every((n) => Math.abs(n - k) > 2)).length;
  return { stretches, share: closable / drawn.length };
}

/** What is wrong with a window for this clip, in words (nothing: it is sound). A window is superset and tight; no window is only right when it would have gained little. */
function opacityFaults(run: OpacityRun, window: string | null): string[] {
  const a = auditOpacity(run, window);
  const faults: string[] = [];
  if (a.missed.length > 0)
    faults.push(`closed on frames that need the filter: ${a.missed.join(",")}`);
  faults.push(...openBeyond(run, window));
  if (window === null) {
    const { stretches, share } = slackOf(run);
    // a curve that is 1 on every frame (a no-op filter) has no stretch that needs it: nothing to window
    if (stretches >= 1 && stretches <= 6 && share >= 0.3)
      faults.push(
        `no window although ${stretches} stretches need the filter and ${share.toFixed(2)} of the frames never do`,
      );
  } else if (a.far.length > 0)
    faults.push(`open far from any frame that needs the filter: ${a.far.join(",")}`);
  return faults;
}

describe("opacityWindow", () => {
  it("is open wherever the curve's factor is not 1, with the frame's time read either way, and tight (1 to 6 keyframes, every easing, values below, at and above 1)", () => {
    fc.assert(
      fc.property(opacityCase, (c) => {
        const run = opacityRun(c);
        const faults = opacityFaults(run, run.real);
        expect(faults, JSON.stringify({ c, window: run.real, faults })).toEqual([]);
      }),
      {
        numRuns: 250,
        examples: [
          // found by the class check (16 Nov), clean repeat on the tip: two keys, an eased fall to a value that prints as 1
          [
            {
              fps: 24,
              tin: 0,
              len: 20,
              keys: [
                { t: 5, v: 1.1501079, ease: "ease-in-out" },
                { t: 6, v: 1.0000004, ease: "linear" },
              ],
            },
          ],
          // found by the class check (16 Nov), fourth repeat: a hold key between a ramp and a drop to 0, then below 0
          [
            {
              fps: 24,
              tin: 211,
              len: 52,
              keys: [
                { t: 0, v: 0, ease: "linear" },
                { t: 1, v: 3, ease: "hold" },
                { t: 53, v: 0, ease: "linear" },
                { t: 54, v: -0.5, ease: "linear" },
              ],
            },
          ],
          // found by the class check (16 Nov): the curve leaves 1 exactly on the frame after the last frame the window function looks at, so only a float step of that frame's time is not 1 and no drawn frame needs the filter
          [
            {
              fps: 25,
              tin: 0,
              len: 114,
              keys: [
                { t: 115, v: 1, ease: "linear" },
                { t: 116, v: 0, ease: "linear" },
              ],
            },
          ],
          // found by the class check (16 Nov), second repeat: five keys around 1 on a 20-frame clip
          [
            {
              fps: 25,
              tin: 0,
              len: 20,
              keys: [
                { t: 0, v: 1.1501079, ease: "ease-in-out" },
                { t: 1, v: 1.0000004, ease: "linear" },
                { t: 2, v: 3, ease: "linear" },
                { t: 3, v: -0.5, ease: "linear" },
                { t: 4, v: 0.9999995, ease: "linear" },
              ],
            },
          ],
        ],
      },
    );
  });

  it("walks every easing the contract allows, rising to 1 and falling from 1, and the window closes once the curve is at 1", () => {
    for (const ease of [...EASINGS, undefined, "not-an-easing"])
      for (const shape of ["rising", "falling", "pulse"] as const) {
        const keys: Key[] =
          shape === "rising"
            ? [
                { t: 20, v: 0.2, ease },
                { t: 50, v: 1 },
                { t: 300, v: 1.4 },
              ]
            : shape === "falling"
              ? [
                  { t: 0, v: 1.2 },
                  { t: 250, v: 1, ease },
                  { t: 280, v: 0.3 },
                ]
              : [
                  { t: 0, v: 1 },
                  { t: 100, v: 0.4, ease },
                  { t: 140, v: 1 },
                  { t: 400, v: 1 },
                ];
        const run = opacityRun({
          fps: 30,
          tin: 0,
          len: 400,
          keys: keys.map((k) => (k.ease === undefined ? { t: k.t, v: k.v } : k)),
        });
        expect(run.real, `${shape} with ${ease}`).not.toBeNull();
        expect(opacityFaults(run, run.real), `${shape} with ${ease}: ${run.real}`).toEqual([]);
      }
  });

  it("writes the shapes a user makes: a fade at the start, a dip in the middle, a fade at the end", () => {
    const starts = opacityRun({
      fps: 30,
      tin: 0,
      len: 600,
      keys: [
        { t: 0, v: 0 },
        { t: 30, v: 1 },
      ],
    });
    expect(starts.real).toMatch(/^lte\(t,\d+\.\d{6}\)$/);
    const dip = opacityRun({
      fps: 30,
      tin: 0,
      len: 600,
      keys: [
        { t: 0, v: 1 },
        { t: 200, v: 1 },
        { t: 230, v: 0.3 },
        { t: 260, v: 1 },
      ],
    });
    expect(dip.real).toMatch(/^between\(t,\d+\.\d{6},\d+\.\d{6}\)$/);
    const ends = opacityRun({
      fps: 30,
      tin: 0,
      len: 600,
      keys: [
        { t: 0, v: 1 },
        { t: 570, v: 1 },
        { t: 599, v: 0 },
      ],
    });
    expect(ends.real).toMatch(/^gte\(t,\d+\.\d{6}\)$/);
  });

  it("gives null where there is nothing to gain or nothing to decide", () => {
    const keys = (...rows: Array<[number, number, string?]>): Key[] =>
      rows.map(([t, v, ease]) => (ease ? { t, v, ease } : { t, v }));
    const nulls: Array<[string, Key[]]> = [
      ["a constant 1: the filter does nothing", keys([0, 1])],
      ["a constant above 1", keys([0, 1.5])],
      ["a constant below 1: every frame needs it", keys([0, 0.5])],
      ["a curve at or above 1 throughout", keys([0, 1], [100, 1.5], [200, 1])],
      ["a curve below 1 on nearly every frame", keys([0, 0.2], [500, 0.8], [520, 1])],
    ];
    for (const [name, k] of nulls)
      expect(opacityRun({ fps: 30, tin: 0, len: 500, keys: k }).real, name).toBeNull();
    // thirteen separate dips: more intervals than the limit
    const pulses = keys(
      ...Array.from({ length: 27 }, (_, i): [number, number, string] => [
        i * 40,
        i % 2 === 0 ? 1.2 : 0.5,
        "hold",
      ]),
    );
    expect(
      opacityRun({ fps: 30, tin: 0, len: 27 * 40, keys: pulses }).real,
      "more than 12 intervals",
    ).toBeNull();
  });

  it("gives null rather than a window of 400 characters or more", () => {
    // twelve dips (the most the limit on intervals allows) far along a very long timeline: each term carries four-digit seconds, and twelve of them are over 400 characters
    const dips = Array.from({ length: 12 }, (_, i): Key[] => [
      { t: 100 + i * 4000, v: 1 },
      { t: 101 + i * 4000, v: 0.2, ease: "hold" },
      { t: 150 + i * 4000, v: 1 },
    ]).flat();
    const run = opacityRun({ fps: 30, tin: 150_000, len: 50_000, keys: dips });
    expect(run.real).toBeNull();
    // the same twelve dips early in a timeline fit
    const early = opacityRun({ fps: 30, tin: 0, len: 50_000, keys: dips });
    expect(early.real).not.toBeNull();
    expectHygienic(early.real!);
  });

  const OPACITY_MUTANTS: Record<string, (run: OpacityRun) => string | null> = {
    "no widening: each interval cut back by the frame it was widened by": (run) => narrow(run, 1),
    "each interval cut back by two frames": (run) => narrow(run, 2),
    "an open end closed again": (run) =>
      run
        .real!.replace(
          /lte\(t,(-?\d+\.\d{6})\)/,
          (_, b) => `between(t,${six((run.first - 2.5) / run.fps)},${b})`,
        )
        .replace(
          /gte\(t,(-?\d+\.\d{6})\)/,
          (_, a) => `between(t,${a},${six((run.end + 1.5) / run.fps)})`,
        ),
    "no window at all: wide open": () => null,
  };

  for (const [name, mutant] of Object.entries(OPACITY_MUTANTS))
    it(`negative control: ${name} is reported`, () => {
      const outcome = fc.check(
        fc.property(opacityCase, (c) => {
          const run = opacityRun(c);
          // a case where the real module gives no window has no window to break
          if (run.real === null) return true;
          return opacityFaults(run, mutant(run)).length === 0;
        }),
        { numRuns: 300, seed: 9, endOnFailure: true },
      );
      expect(outcome.failed, `${name} went unnoticed`).toBe(true);
    });
});

/** Every interval of a window cut back by `frames` frames at each closed end. */
function narrow(run: OpacityRun, frames: number): string {
  const step = frames / run.fps;
  return run
    .real!.replace(
      /between\(t,(-?\d+\.\d{6}),(-?\d+\.\d{6})\)/g,
      (_, a, b) => `between(t,${six(Number(a) + step)},${six(Number(b) - step)})`,
    )
    .replace(/lte\(t,(-?\d+\.\d{6})\)/g, (_, b) => `lte(t,${six(Number(b) - step)})`)
    .replace(/gte\(t,(-?\d+\.\d{6})\)/g, (_, a) => `gte(t,${six(Number(a) + step)})`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The dip's colour layer
// ---------------------------------------------------------------------------------------------------------------------------------------------------

interface DipCase {
  gateFirst: number;
  gateLength: number;
  range: { from: number; to: number } | null;
  total: number;
}

type DipFn = typeof dipLayerFrames;

/** The rule: the layer covers every frame the overlay's gate opens in this command, has a spare frame each side where the command has room, and never leaves the command. */
function dipFault(fn: DipFn, c: DipCase): string | null {
  const gateEnd = c.gateFirst + c.gateLength;
  const lo = Math.max(0, c.range ? c.range.from : 0);
  const hi = Math.min(c.total, c.range ? c.range.to : c.total);
  const opens = range(Math.max(c.gateFirst, lo), Math.min(gateEnd, hi) - 1);
  const got = fn(c.gateFirst, gateEnd, c.range, c.total);
  if (opens.length === 0)
    return got === null
      ? null
      : `the gate opens on no frame of this command, but a layer of ${JSON.stringify(got)} was asked for`;
  if (got === null) return "the gate opens, but there is no layer";
  const first = opens[0];
  const last = opens[opens.length - 1];
  if (got.from > first || got.to <= last)
    return `the layer ${JSON.stringify(got)} misses a frame the gate opens (${first} to ${last})`;
  if (got.from < first - 1 || got.to > last + 2)
    return `the layer ${JSON.stringify(got)} is more than one frame wider than the gate (${first} to ${last})`;
  if (first - 1 >= lo && got.from > first - 1)
    return "no spare frame before the gate although the command has room";
  if (last + 1 < hi && got.to < last + 2)
    return "no spare frame after the gate although the command has room";
  if (got.from < lo || got.to > hi)
    return `the layer ${JSON.stringify(got)} leaves the command's frames [${lo}, ${hi})`;
  return null;
}

const dipCase: fc.Arbitrary<DipCase> = fc.record({
  gateFirst: fc.integer({ min: -5, max: 400 }),
  gateLength: fc.integer({ min: 0, max: 60 }),
  range: fc.option(
    fc
      .record({ from: fc.integer({ min: -5, max: 400 }), length: fc.integer({ min: 0, max: 120 }) })
      .map(({ from, length }) => ({ from, to: from + length })),
    { nil: null },
  ),
  total: fc.integer({ min: 1, max: 500 }),
});

describe("dipLayerFrames", () => {
  it("covers every frame the overlay's gate opens in the command, one spare frame each side, and never leaves the command (full export and partitions)", () => {
    fc.assert(
      fc.property(dipCase, (c) => {
        expect(dipFault(dipLayerFrames, c), JSON.stringify(c)).toBeNull();
      }),
      { numRuns: 1500 },
    );
  });

  it("gives the examples of the design: the whole timeline, a partition across the dip, a partition that has none of it", () => {
    expect(dipLayerFrames(55, 66, null, 600)).toEqual({ from: 54, to: 67 });
    expect(dipLayerFrames(55, 66, { from: 60, to: 120 }, 600)).toEqual({ from: 60, to: 67 });
    expect(dipLayerFrames(55, 66, { from: 66, to: 120 }, 600)).toBeNull();
    expect(dipLayerFrames(55, 66, { from: 0, to: 55 }, 600)).toBeNull();
    expect(dipLayerFrames(0, 12, null, 600)).toEqual({ from: 0, to: 13 });
    expect(dipLayerFrames(590, 600, null, 600)).toEqual({ from: 589, to: 600 });
  });

  const DIP_MUTANTS: Record<string, DipFn> = {
    "no spare frame": (a, b, r, total) =>
      dipLayerFrames(a, b, r, total) && {
        from: Math.max(a, r?.from ?? 0, 0),
        to: Math.min(b, r?.to ?? total, total),
      },
    "the range ignored": (a, b, _r, total) => dipLayerFrames(a, b, null, total),
    "the end of the timeline ignored": (a, b, r) => dipLayerFrames(a, b, r, 1_000_000),
    "the end of the gate counted as inclusive minus one": (a, b, r, total) =>
      dipLayerFrames(a, b - 1, r, total),
    "a layer asked for although the gate never opens here": (a, b, r, total) =>
      dipLayerFrames(a, b, r, total) ?? { from: Math.max(0, a - 1), to: Math.max(1, b + 1) },
  };

  for (const [name, mutant] of Object.entries(DIP_MUTANTS))
    it(`negative control: ${name} is reported`, () => {
      const outcome = fc.check(
        fc.property(dipCase, (c) => dipFault(mutant, c) === null),
        { numRuns: 1500, seed: 13, endOnFailure: true },
      );
      expect(outcome.failed, `${name} went unnoticed`).toBe(true);
    });

  it("refuses what it cannot decide", () => {
    for (const bad of [NaN, Infinity, 1.5, -Infinity]) {
      expect(dipLayerFrames(bad, 10, null, 100), `gateFirst ${bad}`).toBeNull();
      expect(dipLayerFrames(0, bad, null, 100), `gateEnd ${bad}`).toBeNull();
      expect(dipLayerFrames(0, 10, { from: bad, to: 50 }, 100), `from ${bad}`).toBeNull();
      expect(dipLayerFrames(0, 10, { from: 0, to: bad }, 100), `to ${bad}`).toBeNull();
      expect(dipLayerFrames(0, 10, null, bad), `total ${bad}`).toBeNull();
    }
    expect(dipLayerFrames(0, 10, null, 0)).toBeNull();
    expect(dipLayerFrames(0, 10, { from: 50, to: 50 }, 100)).toBeNull();
    expect(dipLayerFrames(0, 10, { from: 50, to: 40 }, 100)).toBeNull();
    expect(dipLayerFrames(10, 10, null, 100)).toBeNull();
    expect(dipLayerFrames(10, 5, null, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Edges and hygiene
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const ALLOWED_NAMES = new Set(["lt", "lte", "gt", "gte", "between", "min", "max", "if", "t"]);

function expectHygienic(window: string): void {
  expect(window.length, window).toBeLessThan(400);
  expect(window, "nothing but names, numbers and punctuation").toMatch(/^[a-z0-9.,()+\-*/]+$/);
  for (const name of window.match(/[a-z]+/g) ?? [])
    expect(ALLOWED_NAMES.has(name), `${name} in ${window}`).toBe(true);
  const numbers = window.replace(/[a-z]+/g, " ").match(/-?\d+(?:\.\d+)?/g) ?? [];
  expect(numbers.length).toBeGreaterThan(0);
  for (const number of numbers) expect(number, `${number} in ${window}`).toMatch(/^-?\d+\.\d{6}$/);
  expect(window).not.toMatch(/NaN|Infinity|e\+|e-/i);
}

describe("every window the module writes", () => {
  it("uses only the allowed functions, six-decimal numbers and fewer than 400 characters", () => {
    const seen: string[] = [];
    fc.assert(
      fc.property(transitionCase, fadeCase, opacityCase, (tc, fc2, oc) => {
        for (const kind of TRANSITION_KINDS) {
          const run = transitionRun(kind, tc);
          if (run.real) seen.push(run.real);
        }
        const fade = fadeRun(fc2).real;
        if (fade) seen.push(fade);
        const opacity = opacityRun(oc).real;
        if (opacity) seen.push(opacity);
      }),
      { numRuns: 40 },
    );
    expect(seen.length).toBeGreaterThan(100);
    for (const window of seen) expectHygienic(window);
  });

  const wild = fc.oneof(
    fc.double(),
    fc.constantFrom(NaN, Infinity, -Infinity, 0, -0, 1e300, -1e300, 5e-324, 1e21, -1e21),
    fc.integer({ min: -5, max: 3000 }),
  );

  it("never throws and never prints NaN or Infinity, whatever numbers it is given", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRANSITION_KINDS),
        wild,
        wild,
        wild,
        wild,
        wild,
        (kind, a, b, c, d, e) => {
          const results = [
            transitionWindow(kind, a, b, c),
            fadeWindow(a, b, c, d, e),
            opacityWindow("if(lt(T,1),0.5,1)", a, b, c),
            opacityWindow(`if(lt(T,${a}),${b},${c})`, 0, 100, 30),
          ];
          for (const window of results) if (window !== null) expectHygienic(window);
          const dip = dipLayerFrames(a, b, { from: c, to: d }, e);
          if (dip !== null) {
            expect(
              Number.isSafeInteger(dip.from) && Number.isSafeInteger(dip.to) && dip.to > dip.from,
            ).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("gives null for every numeric edge of the brief: NaN, Infinity, negative or zero lengths, a rate of 0 or less, a zero-length fade, a fade as long as the clip", () => {
    const nan = NaN;
    const inf = Infinity;
    expect(transitionWindow("crossfade", nan, 0.5, 30)).toBeNull();
    expect(transitionWindow("crossfade", 1, nan, 30)).toBeNull();
    expect(transitionWindow("crossfade", 1, inf, 30)).toBeNull();
    expect(transitionWindow("crossfade", 1, -0.5, 30)).toBeNull();
    expect(transitionWindow("crossfade", 1, 0, 30)).toBeNull();
    expect(transitionWindow("crossfade", 1, 0.0000004, 30)).toBeNull();
    expect(transitionWindow("crossfade", 1, 0.5, 0)).toBeNull();
    expect(transitionWindow("crossfade", 1, 0.5, -30)).toBeNull();
    expect(transitionWindow("crossfade", 1, 0.5, nan)).toBeNull();
    expect(transitionWindow("not-a-kind" as TransitionKind, 1, 0.5, 30)).toBeNull();
    expect(fadeWindow(nan, 10, 1, 1, 30)).toBeNull();
    expect(fadeWindow(0, inf, 1, 1, 30)).toBeNull();
    expect(fadeWindow(0, 10, nan, 1, 30)).toBeNull();
    expect(fadeWindow(0, 10, 1, 1, 0)).toBeNull();
    expect(fadeWindow(0, 10, 1, 1, -1)).toBeNull();
    expect(fadeWindow(0, 10, 0, 0, 30)).toBeNull();
    expect(fadeWindow(0, 10, -1, -1, 30)).toBeNull();
    expect(fadeWindow(0, 10, 0.0000004, 0, 30)).toBeNull();
    expect(fadeWindow(5, 5, 1, 1, 30)).toBeNull();
    expect(fadeWindow(5, 4, 1, 1, 30)).toBeNull();
    expect(fadeWindow(0, 10, 10, 0, 30)).toBeNull();
    expect(fadeWindow(0, 10, 0, 10, 30)).toBeNull();
    expect(fadeWindow(0, 10, 11, 0, 30)).toBeNull();
    expect(fadeWindow(0, 10, 5, 5, 30)).toBeNull();
    expect(opacityWindow("", 0, 100, 30)).toBeNull();
    expect(opacityWindow("if(lt(T,1),0.5,1)", 100, 100, 30)).toBeNull();
    expect(opacityWindow("if(lt(T,1),0.5,1)", 100, 50, 30)).toBeNull();
    expect(opacityWindow("if(lt(T,1),0.5,1)", 0, 100, 0)).toBeNull();
    expect(opacityWindow("if(lt(T,1),0.5,1)", 0.5, 100, 30)).toBeNull();
    expect(opacityWindow("sin(T)", 0, 100, 30)).toBeNull();
    expect(opacityWindow("X*0.5", 0, 100, 30)).toBeNull();
    expect(opacityWindow("W/H", 0, 100, 30)).toBeNull();
    expect(opacityWindow("if(lt(T,1),0.5,1", 0, 100, 30)).toBeNull();
    expect(opacityWindow("1),0,1)+clip((0.5", 0, 100, 30)).toBeNull();
    expect(opacityWindow("0/0", 0, 100, 30)).toBeNull();
    expect(opacityWindow("if(lt(T,1),0.5,1)", 0, 10_000_000, 30)).toBeNull();
  });

  it("opacity: a curve that is not a number on some frames keeps the filter open there", () => {
    // NaN is not 1: those frames need the filter
    const window = opacityWindow("if(lt(T,2),0/0,1)", 0, 300, 30);
    expect(window).toMatch(/^lte\(t,\d+\.\d{6}\)$/);
    expect(reference(window!)({ T: 1 })).not.toBe(0);
    expect(reference(window!)({ T: 5 })).toBe(0);
  });

  it("opacity: the same call twice gives the same answer (the answer is kept per curve)", () => {
    const curve = "if(lt(T,2),0.5,if(lt(T,3),(0.5+(0.5)*clip((T-2)/1,0,1)),1))";
    const first = opacityWindow(curve, 0, 600, 30);
    expect(first).not.toBeNull();
    for (let i = 0; i < 3; i += 1) expect(opacityWindow(curve, 0, 600, 30)).toBe(first);
    expect(opacityWindow(curve, 0, 600, 60)).not.toBe(first);
  });
});
