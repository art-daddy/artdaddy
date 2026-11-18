// Tests of the live time-left authority (exportTimeLeft.ts). They were written from the written
// specification before the module was read, so that they can disagree with it. Every expected
// answer is worked out by hand or by a small reference kept in this file (the rounding grid, the
// pace over the last 20 s, and the written rule as a model); the module is never its own oracle.
// The numbers of the rule are written as literals on purpose: a test that read them back from the
// module would follow a wrong edit of the module instead of failing on it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  cellOf,
  FINISHING_FROM,
  GATE_FRACTION,
  GATE_RENDERED_ALONE_SECONDS,
  GATE_RENDERED_SECONDS,
  HOLD_MARGIN,
  IMPLAUSIBLE_SECONDS,
  LONGER_FACTOR,
  NO_TIME_LEFT,
  notePace,
  PACE_MIN_SPAN_SECONDS,
  PACE_WINDOW_SECONDS,
  roundTimeLeft,
  startPace,
  type PaceReport,
  type PaceState,
  type TimeLeft,
} from "./exportTimeLeft";

// ── the rounding grid, written out again from the specification ────────────────────────────────

function gridRef(raw: number): number {
  const r = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (r < 45) return 30;
  if (r <= 600) return 60 * Math.max(1, Math.round(r / 60));
  if (r <= 3600) return 300 * Math.round(r / 300);
  return 900 * Math.round(r / 900);
}

/** The raw seconds that round to `figure`, as the specification lists them. */
function cellRef(figure: number): { lo: number; hi: number } {
  if (figure === 30) return { lo: 0, hi: 45 };
  if (figure === 60) return { lo: 45, hi: 90 };
  if (figure <= 540) return { lo: figure - 30, hi: figure + 30 };
  if (figure === 600) return { lo: 570, hi: 750 };
  if (figure <= 3300) return { lo: figure - 150, hi: figure + 150 };
  if (figure === 3600) return { lo: 3450, hi: 4050 };
  return { lo: figure - 450, hi: figure + 450 };
}

const GRID: number[] = [30];
for (let s = 60; s <= 600; s += 60) GRID.push(s);
for (let s = 900; s <= 3600; s += 300) GRID.push(s);
for (let s = 4500; s <= 180_000; s += 900) GRID.push(s);

/** The grid by its own definition (30; whole minutes to 10 min; 5 min to 1 h; 15 min beyond), at any size. */
function onGrid(x: number): boolean {
  if (!Number.isInteger(x)) return false;
  if (x === 30) return true;
  if (x >= 60 && x <= 600) return x % 60 === 0;
  if (x > 600 && x <= 3600) return x % 300 === 0;
  return x > 3600 && x % 900 === 0;
}

const FORTY_EIGHT_HOURS = 172_800;

// ── feeds: a report is written as seconds from the start of the feed and a share made ─────────

const BASE = 1_700_000_000_000;

interface Rep {
  readonly t: number;
  readonly f: number;
  readonly step?: number | null;
  readonly steps?: number | null;
}

const msOf = (t: number): number => Math.round(t * 1000);
const round12 = (x: number): number => Math.round(x * 1e12) / 1e12;

function reportOf(r: Rep, base: number): PaceReport {
  return {
    at: base + msOf(r.t),
    fraction: r.f,
    ...(r.step !== undefined ? { step: r.step } : {}),
    ...(r.steps !== undefined ? { steps: r.steps } : {}),
  };
}

function states(reps: readonly Rep[], base: number = BASE): PaceState[] {
  const out: PaceState[] = [];
  let s = startPace();
  for (const r of reps) {
    s = notePace(s, reportOf(r, base));
    out.push(s);
  }
  return out;
}

const valuesOf = (reps: readonly Rep[], base: number = BASE): TimeLeft[] =>
  states(reps, base).map((s) => s.value);
const show = (v: TimeLeft): string => (v.kind === "left" ? `left ${v.seconds}` : v.kind);
const shows = (reps: readonly Rep[], base: number = BASE): string[] =>
  valuesOf(reps, base).map(show);
const isFigure = (v: TimeLeft): boolean => v.kind === "left" || v.kind === "longer";

/** Reports every `dt` s from `from` to `to`: share `f0` at `from`, then `pace` of the render per second. */
function line(from: number, to: number, dt: number, f0: number, pace: number): Rep[] {
  const out: Rep[] = [];
  const n = Math.round((to - from) / dt);
  for (let i = 0; i <= n; i += 1) {
    const t = from + i * dt;
    out.push({ t, f: round12(f0 + pace * (t - from)) });
  }
  return out;
}

/** The render started at 0 and nothing is on screen yet: reports with no picture. */
const quiet = (from: number, to: number, dt = 1): Rep[] => line(from, to, dt, 0, 0);

/** A steady feed: no picture at 0, then `pace` of the render per second, a report every `dt` s. */
const steady = (pace: number, dt: number, to: number): Rep[] => [
  { t: 0, f: 0 },
  ...line(dt, to, dt, round12(pace * dt), pace),
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The reports, 20 s apart, that leave exactly `raws[k]` s to go at report k + 1 by the 20-s pace. */
function controlled(raws: readonly number[], f0 = 0.001): Rep[] {
  const reps: Rep[] = [{ t: 0, f: f0 }];
  let f = f0;
  raws.forEach((raw, k) => {
    const pace = (1 - f) / (raw + 20);
    f += 20 * pace;
    reps.push({ t: 20 * (k + 1), f });
  });
  return reps;
}

/** Largest ratio of the average-pace total (clock over share made since the first report) to its value at report `from`. */
function totalRatio(reps: readonly Rep[], from: number): number {
  const total = (r: Rep): number => (r.t - reps[0].t) / (r.f - reps[0].f);
  let worst = 0;
  for (let i = from + 1; i < reps.length; i += 1) {
    worst = Math.max(worst, total(reps[i]) / total(reps[from]));
  }
  return worst;
}

const inPart = (reps: readonly Rep[], step: number, steps: number): Rep[] =>
  reps.map((r) => ({ ...r, step, steps }));

/** Parts 0 to 2 of 40 s each at 0.005 a second (20 % each), then the final encode from 120 s at 0.004 a second. */
const threeParts = (): Rep[] => [
  ...inPart(line(0, 39, 1, 0, 0.005), 0, 4),
  ...inPart(line(40, 79, 1, 0.2, 0.005), 1, 4),
  ...inPart(line(80, 119, 1, 0.4, 0.005), 2, 4),
  ...inPart(line(120, 150, 1, 0.6, 0.004), 3, 4),
];

/** 0.01 a second for 20 s (the first figure), a stall that turns it into "taking longer", a sprint, then Finishing. */
const stallSprintFinish = (): Rep[] => [
  ...steady(0.01, 1, 20),
  ...line(21, 40, 1, 0.2, 0),
  { t: 41, f: 0.8 },
  { t: 42, f: 0.85 },
  { t: 43, f: 0.9 },
  { t: 44, f: 0.5 },
  { t: 45, f: 0.95 },
];

// ── the written rule as a model, for feeds a real export could produce ──────────────────────────

interface Said {
  readonly kind: TimeLeft["kind"];
  readonly seconds: number | null;
}
const showSaid = (s: Said): string => (s.kind === "left" ? `left ${s.seconds}` : s.kind);

interface ModelRun {
  readonly said: Said[];
  /** The raw time left at each report, or null where no pace can be read. */
  readonly raws: Array<number | null>;
  /** True when a decision sat within 1e-9 of an edge, where rounding noise could tip it. */
  readonly fragile: boolean;
}

/** True when moving `raw` by a billionth could change what is decided about it. */
function nearEdge(raw: number, shown: number | null): boolean {
  const down = raw * (1 - 1e-9);
  const up = raw * (1 + 1e-9);
  if (gridRef(down) !== gridRef(up)) return true;
  if (shown === null) return false;
  const cell = cellRef(shown);
  const margin = 0.25 * (cell.hi - cell.lo);
  const leaves = (x: number): boolean => x < cell.lo - margin || x >= cell.hi + margin;
  return leaves(down) !== leaves(up);
}

/** SPEC section 3, steps 1 to 8, for one render in one process (no parts). */
function modelRun(reps: readonly Rep[]): ModelRun {
  const said: Said[] = [];
  const raws: Array<number | null> = [];
  const samples: Array<{ ms: number; f: number }> = [];
  let lo = 0;
  let started = false;
  let origin = 0;
  let floor = 0;
  let newest = -Infinity;
  let best = 0;
  let finishing = false;
  let open = false;
  let longer = false;
  let shown = 0;
  let base = 0;
  let fragile = false;
  let current: Said = { kind: "none", seconds: null };

  for (const r of reps) {
    const rawMs = msOf(r.t);
    if (!Number.isFinite(rawMs) || !Number.isFinite(r.f)) {
      said.push(current);
      raws.push(null);
      continue;
    }
    const ms = Math.max(rawMs, newest);
    const f = Math.max(Math.min(Math.max(r.f, 0), 1), best);
    newest = ms;
    best = f;
    if (!started) {
      started = true;
      origin = ms;
      floor = f;
    }
    if (f > 0) {
      const last = samples[samples.length - 1];
      if (last !== undefined && last.ms === ms) samples[samples.length - 1] = { ms, f };
      else samples.push({ ms, f });
    }
    if (f >= 0.9) finishing = true;
    if (finishing) {
      current = { kind: "finishing", seconds: null };
      said.push(current);
      raws.push(null);
      continue;
    }

    let raw: number | null = null;
    if (samples.length > 0) {
      const last = samples[samples.length - 1];
      const windowStart = last.ms - 20_000;
      while (lo + 1 < samples.length && samples[lo + 1].ms <= windowStart) lo += 1;
      let startMs = samples[0].ms;
      let startF = samples[0].f;
      const before = samples[lo];
      if (before.ms <= windowStart) {
        const after = samples[lo + 1];
        startMs = windowStart;
        startF =
          before.ms === windowStart
            ? before.f
            : before.f +
              ((after.f - before.f) * (windowStart - before.ms)) / (after.ms - before.ms);
      }
      const span = (last.ms - startMs) / 1000;
      const made = last.f - startF;
      if (span >= 5 && made > 0) {
        const candidate = (1 - f) / (made / span);
        if (Math.abs(candidate - FORTY_EIGHT_HOURS) <= FORTY_EIGHT_HOURS * 1e-9) fragile = true;
        if (candidate <= FORTY_EIGHT_HOURS) raw = candidate;
      }
    }
    raws.push(raw);
    if (raw !== null && nearEdge(raw, open ? shown : null)) fragile = true;

    const rendered = (ms - origin) / 1000;
    if (!open) {
      if (rendered >= 20 && (f >= 0.15 || rendered >= 60) && raw !== null) {
        open = true;
        shown = gridRef(raw);
        base = rendered / (f - floor);
      }
    } else if (raw !== null) {
      const cell = cellRef(shown);
      const margin = 0.25 * (cell.hi - cell.lo);
      if (raw < cell.lo - margin || raw >= cell.hi + margin) shown = gridRef(raw);
    }
    if (open && f > floor) {
      const ratio = rendered / (f - floor) / base;
      if (Math.abs(ratio - 1.5) <= 1e-9) fragile = true;
      if (ratio > 1.5) longer = true;
    }
    current = longer
      ? { kind: "longer", seconds: null }
      : open
        ? { kind: "left", seconds: shown }
        : { kind: "none", seconds: null };
    said.push(current);
  }
  return { said, raws, fragile };
}

// ── generators ─────────────────────────────────────────────────────────────────────────────────

interface FeedSpec {
  readonly cadenceMs: number;
  readonly quietTicks: number;
  readonly phases: ReadonlyArray<{ readonly ticks: number; readonly pace: number }>;
  readonly noise: number;
  readonly seed: number;
  readonly repeats: boolean;
}

/** A render in one process: some reports with no picture, then phases of different pace, with noise. */
const feedSpecArb: fc.Arbitrary<FeedSpec> = fc.record({
  cadenceMs: fc.constantFrom(250, 500, 1000, 2000, 5000),
  quietTicks: fc.integer({ min: 0, max: 30 }),
  phases: fc.array(
    fc.record({
      ticks: fc.integer({ min: 1, max: 60 }),
      pace: fc.oneof(
        { weight: 1, arbitrary: fc.constant(0) },
        { weight: 5, arbitrary: fc.double({ min: 0.0002, max: 0.02, noNaN: true }) },
        { weight: 1, arbitrary: fc.double({ min: 0, max: 0.2, noNaN: true }) },
      ),
    }),
    { minLength: 1, maxLength: 6 },
  ),
  noise: fc.constantFrom(0, 0.2, 0.8),
  seed: fc.integer(),
  repeats: fc.boolean(),
});

function buildFeed(spec: FeedSpec): Rep[] {
  const rnd = mulberry32(spec.seed);
  const reps: Rep[] = [{ t: 0, f: 0 }];
  let ms = 0;
  let f = 0;
  const push = (): void => {
    reps.push({ t: ms / 1000, f });
  };
  for (let i = 0; i < spec.quietTicks; i += 1) {
    ms += spec.cadenceMs;
    push();
  }
  for (const phase of spec.phases) {
    for (let i = 0; i < phase.ticks; i += 1) {
      ms += spec.cadenceMs;
      const factor = Math.max(0, 1 + spec.noise * (2 * rnd() - 1));
      f = round12(Math.min(1, f + phase.pace * (spec.cadenceMs / 1000) * factor));
      push();
      if (spec.repeats && rnd() < 0.15) push();
    }
  }
  return reps;
}

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

/** Adds, after some reports, a report that goes back in time, goes back in share, repeats, is garbage or is out of range. */
function perturb(reps: readonly Rep[], seed: number, level: number): Rep[] {
  const rnd = mulberry32(seed);
  const out: Rep[] = [];
  for (const r of reps) {
    out.push(r);
    const roll = rnd();
    if (roll < level * 0.2) out.push({ t: r.t - rnd() * 30, f: r.f });
    else if (roll < level * 0.4) out.push({ t: r.t + rnd(), f: r.f * rnd() });
    else if (roll < level * 0.55) out.push({ t: r.t, f: r.f });
    else if (roll < level * 0.7) out.push({ t: r.t, f: NON_FINITE[Math.floor(rnd() * 3)] });
    else if (roll < level * 0.85) out.push({ t: NON_FINITE[Math.floor(rnd() * 3)], f: r.f });
    else if (roll < level) out.push({ t: r.t + rnd() * 2, f: r.f + (rnd() - 0.5) * 3 });
  }
  return out;
}

const perturbedArb = fc.tuple(feedSpecArb, fc.integer(), fc.constantFrom(0.2, 0.5, 0.9));

/** Every report read at the newest instant seen so far, which is what the rule says a clock that goes back means. */
function holdClock(reps: readonly Rep[]): Rep[] {
  let newest = -Infinity;
  return reps.map((r) => {
    if (!Number.isFinite(r.t) || !Number.isFinite(r.f)) return r;
    newest = Math.max(newest, r.t);
    return { ...r, t: newest };
  });
}

/** Every share clamped to 0..1 and held at the highest seen so far. */
function holdShare(reps: readonly Rep[]): Rep[] {
  let best = 0;
  return reps.map((r) => {
    if (!Number.isFinite(r.t) || !Number.isFinite(r.f)) return r;
    best = Math.max(best, Math.min(Math.max(r.f, 0), 1));
    return { ...r, f: best };
  });
}

// ── checks shared by the tests ─────────────────────────────────────────────────────────────────

/** Null when `v` is a well-formed answer: one of the four kinds, nothing extra, a figure on the grid and below 48 h + one step. */
function problemWith(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return "the value is not an object";
  const keys = Object.keys(v).sort().join(",");
  const kind = (v as { kind?: unknown }).kind;
  if (kind === "none" || kind === "finishing" || kind === "longer") {
    return keys === "kind" ? null : `a ${kind} value carries ${keys}`;
  }
  if (kind === "left") {
    const seconds = (v as { seconds?: unknown }).seconds;
    if (keys !== "kind,seconds") return `a left value carries ${keys}`;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
      return `left ${String(seconds)} is not a finite number`;
    }
    if (!onGrid(seconds)) return `left ${seconds} is off the grid`;
    if (seconds > FORTY_EIGHT_HOURS + 900) return `left ${seconds} is beyond 48 hours`;
    return null;
  }
  return `unknown kind ${String(kind)}`;
}

function deepFreeze<T>(root: T): T {
  const seen = new Set<object>();
  const walk = (x: unknown): void => {
    if (typeof x !== "object" || x === null || seen.has(x) || ArrayBuffer.isView(x)) return;
    seen.add(x);
    if (x instanceof Map) {
      for (const [k, v] of x) {
        walk(k);
        walk(v);
      }
    } else if (x instanceof Set) {
      for (const v of x) walk(v);
    } else {
      for (const v of Object.values(x)) walk(v);
    }
    Object.freeze(x);
  };
  walk(root);
  return root;
}

/** A structural copy that tells two states apart even where they hold Maps, Sets or arrays. */
function snapshot(root: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const copy = (x: unknown): unknown => {
    if (typeof x === "function") return "[function]";
    if (typeof x !== "object" || x === null) return x;
    if (seen.has(x)) return seen.get(x);
    if (ArrayBuffer.isView(x)) return { view: Array.from(x as unknown as ArrayLike<number>) };
    if (x instanceof Map) {
      const out: unknown[] = [];
      seen.set(x, out);
      for (const [k, v] of x) out.push([copy(k), copy(v)]);
      return { map: out };
    }
    if (x instanceof Set) {
      const out: unknown[] = [];
      seen.set(x, out);
      for (const v of x) out.push(copy(v));
      return { set: out };
    }
    const out: Record<string, unknown> | unknown[] = Array.isArray(x) ? [] : {};
    seen.set(x, out);
    for (const [k, v] of Object.entries(x)) (out as Record<string, unknown>)[k] = copy(v);
    return out;
  };
  return copy(root);
}

// ── the numbers ────────────────────────────────────────────────────────────────────────────────

describe("the numbers the rule is built on", () => {
  it("are the numbers the specification fixes", () => {
    expect({
      GATE_RENDERED_SECONDS,
      GATE_FRACTION,
      GATE_RENDERED_ALONE_SECONDS,
      PACE_WINDOW_SECONDS,
      PACE_MIN_SPAN_SECONDS,
      FINISHING_FROM,
      LONGER_FACTOR,
      IMPLAUSIBLE_SECONDS,
      HOLD_MARGIN,
    }).toEqual({
      GATE_RENDERED_SECONDS: 20,
      GATE_FRACTION: 0.15,
      GATE_RENDERED_ALONE_SECONDS: 60,
      PACE_WINDOW_SECONDS: 20,
      PACE_MIN_SPAN_SECONDS: 5,
      FINISHING_FROM: 0.9,
      LONGER_FACTOR: 1.5,
      IMPLAUSIBLE_SECONDS: 172_800,
      HOLD_MARGIN: 0.25,
    });
  });

  it("start every run on the shared, frozen 'nothing'", () => {
    expect(startPace().value).toBe(NO_TIME_LEFT);
    expect(NO_TIME_LEFT).toEqual({ kind: "none" });
    expect(Object.isFrozen(NO_TIME_LEFT)).toBe(true);
  });
});

// ── R1 ─────────────────────────────────────────────────────────────────────────────────────────

describe("R1 the rounding grid: words, never seconds", () => {
  it("puts every time left on the grid, on the figure the written rule gives", () => {
    const raws: number[] = [];
    for (let raw = 0; raw <= 8000; raw += 0.25) raws.push(raw);
    for (let raw = 8000; raw <= 400_000; raw += 7.5) raws.push(raw);
    expect(raws.filter((raw) => roundTimeLeft(raw) !== gridRef(raw)).slice(0, 5)).toEqual([]);
    expect(raws.filter((raw) => !onGrid(roundTimeLeft(raw))).slice(0, 5)).toEqual([]);
  });

  it("never gives a smaller figure for a larger time left", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 300_000, noNaN: true }),
        fc.double({ min: 0, max: 300_000, noNaN: true }),
        (a, b) => {
          const [small, large] = a <= b ? [a, b] : [b, a];
          expect(roundTimeLeft(small)).toBeLessThanOrEqual(roundTimeLeft(large));
        },
      ),
      { numRuns: 1500 },
    );
    let previous = 0;
    for (let raw = 0; raw <= 12_000; raw += 0.5) {
      const now = roundTimeLeft(raw);
      if (now < previous) throw new Error(`${raw} s gave ${now}, below ${previous} for less time`);
      previous = now;
    }
  });

  it.each([
    [0, 30],
    [29, 30],
    [44.99, 30],
    [45, 60],
    [89.99, 60],
    [90, 120],
    [149.99, 120],
    [150, 180],
    [569.99, 540],
    [570, 600],
    [600, 600],
    [600.01, 600],
    [749.99, 600],
    [750, 900],
    [1049.99, 900],
    [1050, 1200],
    [3449.99, 3300],
    [3450, 3600],
    [3600, 3600],
    [3600.01, 3600],
    [4049.99, 3600],
    [4050, 4500],
    [4949.99, 4500],
    [4950, 5400],
    [172_800, 172_800],
  ])("says %s s as %s", (raw, figure) => {
    expect(roundTimeLeft(raw)).toBe(figure);
  });

  it("reads a missing, negative or infinite time left as the lowest figure", () => {
    for (const raw of [NaN, Infinity, -Infinity, -1, -0.001, -1e300, -0]) {
      expect(roundTimeLeft(raw)).toBe(30);
    }
  });

  it("lists, in cellOf, exactly the raw times that round to each figure, and the cells tile the line", () => {
    GRID.forEach((figure, i) => {
      const cell = cellOf(figure);
      expect(cell).toEqual(cellRef(figure));
      expect(roundTimeLeft(cell.lo)).toBe(figure);
      expect(roundTimeLeft(cell.hi - 1e-6)).toBe(figure);
      if (i > 0) expect(roundTimeLeft(cell.lo - 1e-6)).toBe(GRID[i - 1]);
      if (i + 1 < GRID.length) {
        expect(cell.hi).toBe(cellOf(GRID[i + 1]).lo);
        expect(roundTimeLeft(cell.hi)).toBe(GRID[i + 1]);
      }
    });
    expect(cellOf(30).lo).toBe(0);
  });

  it("lays every raw time left inside the cell of the figure it rounds to", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200_000, noNaN: true }), (raw) => {
        const cell = cellOf(roundTimeLeft(raw));
        expect(cell.lo <= raw && raw < cell.hi).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

// ── R2 and R12: before the gate ────────────────────────────────────────────────────────────────

describe("R2 before the gate nothing is said", () => {
  it("says no figure in the first 20 s of the render's own clock, however fast the pace, and Finishing only from 0.9", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.constantFrom(0.25, 0.5, 1, 2),
        (pace, dt) => {
          const reps = steady(pace, dt, Math.floor(19.9 / dt) * dt);
          const vs = valuesOf(reps);
          reps.forEach((r, i) => {
            const want = r.f >= 0.9 ? "finishing" : "none";
            if (vs[i].kind !== want) throw new Error(`${r.t} s, ${r.f} made: said ${show(vs[i])}`);
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it("says nothing before 20 s on the render's clock, nor before 60 s while less than 15 % is made (Finishing only from 0.9), on any feed", () => {
    let reachedAFigure = 0;
    fc.assert(
      fc.property(feedSpecArb, (spec) => {
        const reps = buildFeed(spec);
        const vs = valuesOf(reps);
        let best = 0;
        let sawFigure = false;
        reps.forEach((r, i) => {
          best = Math.max(best, r.f);
          if (isFigure(vs[i])) sawFigure = true;
          const renderedMs = msOf(r.t) - msOf(reps[0].t);
          if (renderedMs < 20_000 || (renderedMs < 60_000 && best < 0.15)) {
            if (vs[i].kind !== (best >= 0.9 ? "finishing" : "none")) {
              throw new Error(`${show(vs[i])} at ${renderedMs} ms with ${best} made`);
            }
          }
        });
        if (sawFigure) reachedAFigure += 1;
      }),
      { numRuns: 300 },
    );
    expect(reachedAFigure).toBeGreaterThan(40);
  });

  it("never says a figure for an export whose clock is under 20 s in all, only the word Finishing near its end", () => {
    const reps: Rep[] = [
      { t: 0, f: 0 },
      { t: 1, f: 0.05 },
      { t: 3, f: 0.2 },
      { t: 6, f: 0.45 },
      { t: 9, f: 0.7 },
      { t: 12, f: 0.85 },
      { t: 15, f: 0.8999 },
      { t: 17, f: 0.9 },
      { t: 19.999, f: 0.97 },
    ];
    expect(shows(reps)).toEqual([
      "none",
      "none",
      "none",
      "none",
      "none",
      "none",
      "none",
      "finishing",
      "finishing",
    ]);
  });

  it("opens at exactly 20 s on a fast steady feed, not a report sooner and not a report later", () => {
    // 0.012 a second: at 20 s 24 % is made and 0.76 is left, which is 63 s
    expect(shows(steady(0.012, 1, 24))).toEqual([
      ...Array(20).fill("none"),
      ...Array(5).fill("left 60"),
    ]);
  });

  it("opens as soon as 15 % is made when that comes between 20 s and 60 s", () => {
    // 0.005 a second: 14.5 % at 29 s, exactly 15 % at 30 s; 0.85 left is 170 s
    expect(shows(steady(0.005, 1, 33))).toEqual([
      ...Array(30).fill("none"),
      ...Array(4).fill("left 180"),
    ]);
  });

  it("opens by the 60 s clock alone when 15 % is not reached, at exactly 60 s", () => {
    // 0.001 a second: 6 % at 60 s; 0.94 left is 940 s, which rounds to 15 min
    expect(shows(steady(0.001, 1, 63))).toEqual([
      ...Array(60).fill("none"),
      ...Array(4).fill("left 900"),
    ]);
  });

  it("opens on whichever of 15 % or 60 s comes first: 20 s alone at 14 % is not enough", () => {
    // 0.007 a second: 14 % at 20 s, 14.7 % at 21 s, 15.4 % at 22 s; 0.846 left is 121 s
    expect(shows(steady(0.007, 1, 24))).toEqual([
      ...Array(22).fill("none"),
      ...Array(3).fill("left 120"),
    ]);
  });

  it("starts the render's clock at its first report, not at its first picture", () => {
    // no picture for 10 s, then 20 % made and 0.02 a second: the gate is the first report plus 20 s
    const reps = [...quiet(0, 9), ...line(10, 24, 1, 0.2, 0.02)];
    expect(shows(reps)).toEqual([...Array(20).fill("none"), ...Array(5).fill("left 30")]);
  });

  it("needs 5 s of pictures before a pace can be read, even when the clock is long past the gate", () => {
    // first picture at 19 s with 30 % made and 0.03 a second: 4 s of pictures at 23 s, 5 s at 24 s
    const reps = [...quiet(0, 18), ...line(19, 25, 1, 0.3, 0.03)];
    expect(shows(reps)).toEqual([...Array(24).fill("none"), "left 30", "left 30"]);
  });

  it("says nothing for a render with no picture at all, however long, and starts once a pace can be read", () => {
    expect(shows(quiet(0, 150))).toEqual(Array(151).fill("none"));
    // the first picture at 70 s (2 % made), then 0.002 a second: a pace from 75 s; 0.97 left is 485 s
    const late = [...quiet(0, 69), ...line(70, 78, 1, 0.02, 0.002)];
    expect(shows(late)).toEqual([...Array(75).fill("none"), ...Array(4).fill("left 480")]);
  });

  it("reads the pace over the last 20 s only: a feed that sped up says the new pace, not the average", () => {
    // 0.002 a second for 20 s, then 0.012 a second: at 30 s 16 % is made, 14 % of it in the last 20 s
    // 20 s window: 2 % at 10 s -> 16 % at 30 s is 0.007 a second, 0.84 left is 120 s.
    // 10 s window would say 70 s (60), the whole feed would say 154 s (180)
    const reps = [...line(0, 20, 1, 0, 0.002), ...line(21, 30, 1, 0.052, 0.012)];
    const vs = valuesOf(reps);
    expect(vs.slice(0, 30).every((v) => v.kind === "none")).toBe(true);
    expect(show(vs[30])).toBe("left 120");
  });

  it("interpolates the start of the 20-s window between the two reports around it", () => {
    // reports at 0, 10, 30 and 40 s; at 40 s the window starts at 20 s, between the reports at 10 and 30
    // share at 20 s = 0.02 + 0.02 * 10 / 20 = 0.03; made = 0.34 - 0.03 over 20 s; 0.66 left is 43 s
    // (the oldest report instead would give 0.01067 a second and 62 s)
    const reps: Rep[] = [
      { t: 0, f: 0.01 },
      { t: 10, f: 0.02 },
      { t: 30, f: 0.04 },
      { t: 40, f: 0.34 },
    ];
    expect(shows(reps)).toEqual(["none", "none", "none", "left 30"]);
  });

  it("keeps the one report at or before the start of the window, so that the start can be interpolated", () => {
    // reports at 0, 5 and 50 s: the window at 50 s starts at 30 s, 25 s into the 45 s between the last two
    // share there = 0.02 + 0.48 * 25 / 45; made = 0.5 - 0.2867 over 20 s; 0.5 left is 47 s
    const reps: Rep[] = [
      { t: 0, f: 0.01 },
      { t: 5, f: 0.02 },
      { t: 50, f: 0.5 },
    ];
    expect(shows(reps)).toEqual(["none", "none", "left 60"]);
  });

  it("reads two reports at one instant as the later one", () => {
    // 15 s: 1 % made, then 17 % at the same instant; 22 % at 20 s: 5 % over 5 s is 0.01 a second, 78 s left
    // (if the 1 % counted: 21 % over 5 s is 0.042 a second, 19 s left)
    const reps: Rep[] = [
      ...quiet(0, 14),
      { t: 15, f: 0.01 },
      { t: 15, f: 0.17 },
      { t: 16, f: 0.18 },
      { t: 17, f: 0.19 },
      { t: 18, f: 0.2 },
      { t: 19, f: 0.21 },
      { t: 20, f: 0.22 },
    ];
    expect(shows(reps)).toEqual([...Array(21).fill("none"), "left 60"]);
  });

  it("survives thousands of reports at one instant and then reads the pace as if only the last had counted", () => {
    const burst: Rep[] = [];
    for (let i = 1; i <= 4000; i += 1) burst.push({ t: 15, f: (0.17 * i) / 4000 });
    const reps: Rep[] = [
      ...quiet(0, 14),
      ...burst,
      { t: 16, f: 0.18 },
      { t: 17, f: 0.19 },
      { t: 18, f: 0.2 },
      { t: 19, f: 0.21 },
      { t: 20, f: 0.22 },
    ];
    const vs = valuesOf(reps);
    expect(vs.slice(0, -1).every((v) => v.kind === "none")).toBe(true);
    expect(show(vs[vs.length - 1])).toBe("left 60");
  });

  it("never says a time left beyond 48 hours, and says one just inside", () => {
    // pace chosen so that the raw time left is `raw` s at the 60-s gate: the pace is 1 / (raw + 60)
    const sayAt60 = (raw: number): string => {
      const reps = steady(1 / (raw + 60), 1, 62);
      return shows(reps)[60];
    };
    expect(sayAt60(100_000)).toBe("left 99900");
    expect(sayAt60(171_000)).toBe("left 171000");
    expect(sayAt60(172_790)).toBe("left 172800");
    expect(sayAt60(172_810)).toBe("none");
    expect(sayAt60(174_000)).toBe("none");
    expect(sayAt60(200_000)).toBe("none");
    expect(sayAt60(333_000)).toBe("none");
    // no figure at all for the whole stretch while it stays beyond 48 h
    expect(shows(steady(1 / 400_060, 1, 62)).every((s) => s === "none")).toBe(true);
  });
});

describe("R12 20 s alone is not enough, and a render with no picture has no figure", () => {
  it("stays silent from 20 s to 60 s while under 15 % is made, whatever the pace", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.0001, max: 0.0074, noNaN: true }), (pace) => {
        // under 0.0075 a second the share is under 0.15 at 20 s; stop before it reaches 0.15 or 60 s
        const stop = Math.min(59, Math.ceil(0.15 / pace) - 1);
        fc.pre(stop >= 20);
        const vs = valuesOf(steady(pace, 1, stop));
        expect(vs.every((v) => v.kind === "none")).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("has no figure at 60 s when nothing has been drawn yet, nor ever while the share is 0", () => {
    const vs = valuesOf(quiet(0, 300, 5));
    expect(vs.every((v) => v.kind === "none")).toBe(true);
  });
});

// ── R3 ─────────────────────────────────────────────────────────────────────────────────────────

describe("R3 the figure itself", () => {
  const paceArb = fc.oneof(
    fc.double({ min: 0.008, max: 0.044, noNaN: true }),
    fc.double({ min: 0.00003, max: 0.0024, noNaN: true }),
  );
  // fast feeds open at 20 s (15 % is made by then); slow ones at 60 s
  const gateOf = (pace: number): number => (pace > 0.0075 ? 20 : 60);
  const stableCell = (raw: number): boolean =>
    gridRef(raw * (1 - 1e-6)) === gridRef(raw * (1 + 1e-6));

  it("is, on a steady feed, the grid rounding of the true time left, said at the gate", () => {
    fc.assert(
      fc.property(paceArb, fc.constantFrom(0.25, 0.5, 1, 2), (pace, dt) => {
        const gate = gateOf(pace);
        const trueLeft = 1 / pace - gate;
        fc.pre(stableCell(trueLeft));
        const reps = steady(pace, dt, gate + 4 * dt);
        const vs = valuesOf(reps);
        const first = vs.findIndex((v) => v.kind !== "none");
        expect(reps[first].t).toBe(gate);
        expect(show(vs[first])).toBe(`left ${gridRef(trueLeft)}`);
      }),
      { numRuns: 400 },
    );
  });

  it("is also said, between 20 s and 60 s, at the first report that reaches 15 %", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0026, max: 0.0074, noNaN: true }),
        fc.constantFrom(0.25, 0.5, 1, 2),
        (pace, dt) => {
          const steps = 0.15 / pace / dt;
          fc.pre(Math.abs(steps - Math.round(steps)) > 1e-6);
          const gate = Math.max(20, Math.ceil(steps) * dt);
          const trueLeft = 1 / pace - gate;
          fc.pre(stableCell(trueLeft));
          const reps = steady(pace, dt, gate + 2 * dt);
          const vs = valuesOf(reps);
          const first = vs.findIndex((v) => v.kind !== "none");
          expect(reps[first].t).toBe(gate);
          expect(show(vs[first])).toBe(`left ${gridRef(trueLeft)}`);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is the same whether reports come every 0.25 s, 0.5 s or 2 s", () => {
    fc.assert(
      fc.property(paceArb, (pace) => {
        const gate = gateOf(pace);
        const trueLeft = 1 / pace - gate;
        fc.pre(stableCell(trueLeft));
        const firsts = [0.25, 0.5, 2].map((dt) => {
          const vs = valuesOf(steady(pace, dt, gate + 8));
          return show(vs[vs.findIndex((v) => v.kind !== "none")]);
        });
        expect(firsts).toEqual(Array(3).fill(`left ${gridRef(trueLeft)}`));
      }),
      { numRuns: 300 },
    );
  });

  it.each([
    [0.04, 20, "left 30"],
    [0.02, 20, "left 30"],
    [0.012, 20, "left 60"],
    [0.01, 20, "left 60"],
    [0.008, 20, "left 120"],
    [0.002, 60, "left 420"],
    [0.001, 60, "left 900"],
    [0.0007, 60, "left 1500"],
    [0.0004, 60, "left 2400"],
    [0.0001, 60, "left 9900"],
    [0.00002, 60, "left 49500"],
  ])("for %s of the render a second the answer at %s s is %s", (pace, gate, said) => {
    const vs = valuesOf(steady(pace, 1, gate));
    expect(vs.slice(0, gate).every((v) => v.kind === "none")).toBe(true);
    expect(show(vs[gate])).toBe(said);
  });
});

// ── R4 ─────────────────────────────────────────────────────────────────────────────────────────

describe("R4 finishing", () => {
  it("is said from the first report at 0.9, and not at 0.8999 or 0.89999999", () => {
    const reps: Rep[] = [
      ...steady(0.01, 1, 30),
      { t: 31, f: 0.8999 },
      { t: 32, f: 0.89999999 },
      { t: 33, f: 0.9 },
    ];
    expect(
      valuesOf(reps)
        .map((v) => v.kind)
        .slice(-3),
    ).toEqual(["left", "left", "finishing"]);
  });

  it("is said by a short export that never opened the gate, and by a run joined at 0.95", () => {
    const short: Rep[] = [
      { t: 0, f: 0 },
      { t: 3, f: 0.5 },
      { t: 9, f: 0.95 },
    ];
    expect(shows(short)).toEqual(["none", "none", "finishing"]);
    expect(shows([{ t: 0, f: 0.95 }])).toEqual(["finishing"]);
    expect(
      shows([
        { t: 0, f: 1 },
        { t: 5, f: 1 },
      ]),
    ).toEqual(["finishing", "finishing"]);
  });

  it("is never said while less than 0.9 is made, on any feed", () => {
    fc.assert(
      fc.property(perturbedArb, ([spec, seed, level]) => {
        const reps = perturb(buildFeed(spec), seed, level).map((r) =>
          Number.isFinite(r.f) ? { ...r, f: Math.min(r.f, 0.8999) } : r,
        );
        expect(valuesOf(reps).some((v) => v.kind === "finishing")).toBe(false);
      }),
      { numRuns: 250 },
    );
  });

  it("stays Finishing for good once 0.9 is reached, however the later reports go back, repeat or stall", () => {
    fc.assert(
      fc.property(feedSpecArb, fc.integer(), (spec, seed) => {
        const rnd = mulberry32(seed);
        const head = buildFeed(spec);
        const cut = head.findIndex((r) => r.f >= 0.9);
        const kept = cut < 0 ? head : head.slice(0, cut);
        const lastT = kept[kept.length - 1].t;
        const tail: Rep[] = [{ t: lastT + 1 + rnd() * 5, f: 0.9 + rnd() * 0.1 }];
        for (let i = 0; i < 40; i += 1) tail.push({ t: lastT + rnd() * 600, f: rnd() * 3 - 1 });
        valuesOf([...kept, ...tail]).forEach((v, i) => {
          if ((v.kind === "finishing") !== i >= kept.length)
            throw new Error(`report ${i}: ${show(v)}`);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("says no number again after Finishing, through a very long stall", () => {
    const vs = valuesOf([...steady(0.01, 1, 90), ...line(91, 900, 10, 0.9, 0)]);
    expect(vs.slice(0, 90).some((v) => v.kind === "finishing")).toBe(false);
    expect(vs.slice(90).every((v) => v.kind === "finishing")).toBe(true);
  });
});

// ── R5 ─────────────────────────────────────────────────────────────────────────────────────────

describe("R5 no flicker", () => {
  const ALLOWED: Record<TimeLeft["kind"], ReadonlyArray<TimeLeft["kind"]>> = {
    none: ["none", "left", "finishing"],
    left: ["left", "longer", "finishing"],
    longer: ["longer", "finishing"],
    finishing: ["finishing"],
  };

  it("goes only from nothing to a figure to taking longer to Finishing, never back, on any feed", () => {
    let reachedAFigure = 0;
    fc.assert(
      fc.property(perturbedArb, ([spec, seed, level]) => {
        const vs = valuesOf(perturb(buildFeed(spec), seed, level));
        let previous: TimeLeft = NO_TIME_LEFT;
        let said = false;
        vs.forEach((v, i) => {
          if (!ALLOWED[previous.kind].includes(v.kind)) {
            throw new Error(`report ${i}: ${show(previous)} and then ${show(v)}`);
          }
          const problem = problemWith(v);
          if (problem !== null) throw new Error(`report ${i}: ${problem}`);
          if (v.kind === "left") said = true;
          previous = v;
        });
        if (said) reachedAFigure += 1;
      }),
      { numRuns: 300 },
    );
    expect(reachedAFigure).toBeGreaterThan(40);
  });

  it("keeps a figure through a stall until it says taking longer, and never says nothing", () => {
    // 0.001 a second: the first figure at 60 s (6 % made); then no progress at all.
    // The average-pace total grows as t / 0.06, which passes 1.5 times its first value (1000 s) after 90 s.
    const vs = valuesOf([...steady(0.001, 1, 60), ...line(61, 95, 1, 0.06, 0)]);
    expect(vs.slice(0, 60).every((v) => v.kind === "none")).toBe(true);
    expect(vs.slice(60, 90).every((v) => v.kind === "left")).toBe(true);
    expect(vs.slice(91).every((v) => v.kind === "longer")).toBe(true);
  });
});

// ── R6 ─────────────────────────────────────────────────────────────────────────────────────────

describe("R6 hysteresis: a figure does not flap around a rounding boundary", () => {
  const none = "none";
  const scenario = (name: string, raws: number[], want: string[]): void => {
    it(name, () => {
      const reps = controlled(raws);
      expect(want).toHaveLength(reps.length);
      // the scenarios must not reach 'taking longer', or they would not be about the figure
      expect(
        totalRatio(
          reps,
          want.findIndex((w) => w.startsWith("left")),
        ),
      ).toBeLessThan(1.45);
      expect(shows(reps)).toEqual(want);
    });
  };

  scenario(
    "holds 2 min while the time left wobbles between 80 s and 100 s around the 90 s boundary",
    [100, 80, 95, 85, 92],
    [none, ...Array(5).fill("left 120")],
  );
  scenario(
    "holds 1 min while the time left wobbles between 80 s and 98 s around the 90 s boundary",
    [80, 95, 85, 98],
    [none, ...Array(4).fill("left 60")],
  );
  scenario(
    "changes the figure once, at the edge of its band, and then holds it while the time left wobbles back",
    [80, 102, 98],
    [none, "left 60", "left 120", "left 120"],
  );
  scenario(
    "moves the figure when the time left moves a whole cell away, and moves it back",
    [100, 190, 100],
    [none, "left 120", "left 180", "left 120"],
  );
  scenario(
    "holds 15 min while the time left wobbles by 10 s around the 750 s boundary",
    [760, 740, 760, 740, 760, 740, 770, 735],
    [none, none, none, ...Array(6).fill("left 900")],
  );
  scenario(
    "keeps 15 min at 1120 s and moves to 20 min at 1130 s (the band reaches 75 s past the cell)",
    [760, 740, 760, 1120, 1130],
    [none, none, none, "left 900", "left 900", "left 1200"],
  );
  scenario(
    "keeps 15 min at 680 s and moves to 10 min at 670 s (the band reaches 75 s below the cell)",
    [760, 740, 760, 680, 670],
    [none, none, none, "left 900", "left 900", "left 600"],
  );
  scenario(
    "moves to a far figure in one step",
    [760, 740, 760, 1500],
    [none, none, none, "left 900", "left 1500"],
  );
  scenario(
    "keeps 2 min at 76 s and moves to 1 min at 74 s (the band reaches 15 s below the cell)",
    [100, 76, 74],
    [none, "left 120", "left 120", "left 60"],
  );

  it("says a figure never further than a quarter of its cell from the time left, and moves it only when the time left leaves that band", () => {
    let moved = 0;
    fc.assert(
      fc.property(feedSpecArb, (spec) => {
        const reps = buildFeed(spec);
        const run = modelRun(reps);
        fc.pre(!run.fragile);
        let previous: number | null = null;
        valuesOf(reps).forEach((v, i) => {
          if (v.kind !== "left") return;
          const raw = run.raws[i];
          const inBand = (figure: number): boolean => {
            const cell = cellRef(figure);
            const margin = 0.25 * (cell.hi - cell.lo);
            return raw !== null && raw >= cell.lo - margin && raw < cell.hi + margin;
          };
          if (raw !== null && !inBand(v.seconds)) {
            throw new Error(`report ${i}: ${v.seconds} s said for ${raw} s left`);
          }
          if (previous !== null && previous !== v.seconds) {
            moved += 1;
            if (raw === null) throw new Error(`report ${i}: the figure moved with no pace to read`);
            if (inBand(previous))
              throw new Error(`report ${i}: moved while ${raw} s was in the band`);
            if (v.seconds !== gridRef(raw)) throw new Error(`report ${i}: moved to ${v.seconds}`);
          }
          previous = v.seconds;
        });
      }),
      { numRuns: 300 },
    );
    expect(moved).toBeGreaterThan(30);
  });
});

// ── R7 ─────────────────────────────────────────────────────────────────────────────────────────

describe("R7 taking longer", () => {
  it("is never said for a render whose average pace stays the same, with or without a slow start", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0003, max: 0.04, noNaN: true }),
        fc.constantFrom(0.5, 1, 2),
        fc.constantFrom(0, 4, 16, 40),
        (pace, dt, startUp) => {
          const reps = [
            ...quiet(0, startUp, dt),
            ...line(startUp + dt, 150, dt, round12(pace * dt), pace),
          ];
          const vs = valuesOf(reps);
          expect(vs.some((v) => v.kind === "longer")).toBe(false);
          expect(vs.some((v) => v.kind === "left")).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("does not take a short stall inside a healthy render for taking longer: it reads the average pace, not the 20-s pace", () => {
    // 0.01 a second, 12 s of no progress, then 0.01 a second again.
    // The 20-s pace falls to 0.004 and the 20-s total reaches 250 s, 2.5 times its first value (100 s);
    // the average-pace total is 52 / 0.4 = 130 s at the worst moment, 1.3 times.
    const reps = [
      ...steady(0.01, 1, 40),
      ...line(41, 52, 1, 0.4, 0),
      ...line(53, 70, 1, 0.41, 0.01),
    ];
    const vs = valuesOf(reps);
    expect(vs.some((v) => v.kind === "longer")).toBe(false);
    expect(vs.slice(20).every((v) => v.kind === "left")).toBe(true);
  });

  it("turns when the average-pace total passes 1.5 times its first value: a stall of 29.8 s is still a figure, 30.2 s is taking longer", () => {
    // 0.01 a second for 20 s: first figure, total 20 s / 0.2 = 100 s. Then no progress: the total at t is t / 0.2.
    const upTo = (end: number): Rep[] => [...steady(0.01, 1, 20), ...line(20.2, end, 0.2, 0.2, 0)];
    const before = valuesOf(upTo(29.8));
    const after = valuesOf(upTo(30.2));
    expect(before[before.length - 1].kind).toBe("left");
    expect(before.some((v) => v.kind === "longer")).toBe(false);
    expect(after[after.length - 1].kind).toBe("longer");
  });

  it("turns exactly where the average-pace total crosses 1.5 times its first value: 1.49 times is a figure, 1.51 times is taking longer", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.008, max: 0.025, noNaN: true }),
        fc.integer({ min: 1, max: 80 }),
        (pace, extra) => {
          const end = 30 + extra;
          const gateShare = round12(pace * 20);
          for (const [ratio, want] of [
            [1.49, "left"],
            [1.51, "longer"],
          ] as const) {
            // a share at `end` that makes the total there `ratio` times its value at the first figure (20 s)
            const endShare = (end * pace) / ratio;
            fc.pre(endShare > gateShare && endShare < 0.85);
            const slope = (endShare - gateShare) / (end - 20);
            const reps = [
              ...steady(pace, 1, 19),
              ...line(20, end, (end - 20) / 20, gateShare, slope),
            ];
            const vs = valuesOf(reps);
            const last = vs[vs.length - 1];
            if (last.kind !== want) throw new Error(`at ${ratio} times: ${show(last)}`);
            if (ratio < 1.5 && vs.some((v) => v.kind === "longer")) throw new Error("turned early");
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("stays 'taking longer' after a sprint, until Finishing replaces it at 0.9, and Finishing then stays", () => {
    const reps: Rep[] = [
      ...steady(0.01, 1, 20),
      ...line(21, 40, 1, 0.2, 0),
      { t: 41, f: 0.8 },
      { t: 42, f: 0.85 },
      { t: 43, f: 0.9 },
      { t: 44, f: 0.5 },
    ];
    const kinds = valuesOf(reps).map((v) => v.kind);
    expect(kinds.slice(0, 20)).toEqual(Array(20).fill("none"));
    expect(kinds.slice(20, 30)).toEqual(Array(10).fill("left"));
    // 41 s and 42 s: the average-pace total is far under its first value again, and it is still said
    expect(kinds.slice(31, 43)).toEqual(Array(12).fill("longer"));
    expect(kinds.slice(43)).toEqual(["finishing", "finishing"]);
  });
});

// ── R8 ─────────────────────────────────────────────────────────────────────────────────────────

describe("R8 a render in parts", () => {
  it("says nothing in any part before the last, and the final encode says its first figure only after its own 20 s", () => {
    // the final encode: 68 % at 140 s, 0.004 a second, 0.32 left is 80 s
    expect(shows(threeParts())).toEqual([...Array(140).fill("none"), ...Array(11).fill("left 60")]);
  });

  it("says nothing in any part before the last, whatever the pace, and nothing in the final encode before its own gate", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            seconds: fc.integer({ min: 5, max: 90 }),
            pace: fc.double({ min: 0, max: 0.02, noNaN: true }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (parts) => {
          const steps = parts.length + 1;
          const reps: Rep[] = [];
          let t = 0;
          let f = 0;
          parts.forEach((part, k) => {
            for (let s = 0; s < part.seconds; s += 1) {
              f = Math.min(0.88, round12(f + part.pace));
              reps.push({ t, f, step: k, steps });
              t += 1;
            }
          });
          const partCount = reps.length;
          const finalStart = t;
          reps.push(...inPart(line(finalStart, finalStart + 40, 1, f, 0.003), steps - 1, steps));
          valuesOf(reps).forEach((v, i) => {
            if (i < partCount && v.kind !== "none") throw new Error(`part report ${i}: ${show(v)}`);
            if (i < partCount) return;
            const own = reps[i].t - finalStart;
            if (isFigure(v) && (own < 20 || (own < 60 && reps[i].f < 0.15))) {
              throw new Error(`final encode, ${own} s in, ${reps[i].f} made: ${show(v)}`);
            }
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("says nothing in a part before the last even when 0.9 is made in it", () => {
    const reps = inPart(
      [
        { t: 0, f: 0 },
        { t: 10, f: 0.5 },
        { t: 20, f: 0.95 },
      ],
      0,
      2,
    );
    expect(shows(reps)).toEqual(["none", "none", "none"]);
  });

  it("restarts the clock and the gate on a change of part: back in the final encode, a figure waits for its own 20 s", () => {
    const reps = [
      ...inPart(line(0, 30, 1, 0.5, 0.004), 3, 4),
      ...inPart(line(31, 40, 1, 0.2, 0), 1, 4),
      ...inPart(line(41, 70, 1, 0.7, 0.004), 3, 4),
    ];
    // the first final encode says 120 from 20 s on; the part says nothing; the second final encode says
    // nothing for 20 s and then 60 (0.22 left at 0.004 a second is 55 s)
    expect(shows(reps)).toEqual([
      ...Array(20).fill("none"),
      ...Array(11).fill("left 120"),
      ...Array(10).fill("none"),
      ...Array(20).fill("none"),
      ...Array(10).fill("left 60"),
    ]);
  });

  it("restarts the clock and the gate when only the number of parts changes", () => {
    // the final encode of a plan of 4 (a figure from 20 s), 5 s of a plan of 5 (3 of 5 is a part before the last),
    // then the final encode of 4 again: it waits for its own 20 s, the figure then is 55 s, a minute
    const reps = [
      ...inPart(line(0, 30, 1, 0.5, 0.004), 3, 4),
      ...inPart(line(31, 35, 1, 0.2, 0), 3, 5),
      ...inPart(line(36, 70, 1, 0.7, 0.004), 3, 4),
    ];
    expect(shows(reps)).toEqual([
      ...Array(20).fill("none"),
      ...Array(11).fill("left 120"),
      ...Array(5).fill("none"),
      ...Array(20).fill("none"),
      ...Array(15).fill("left 60"),
    ]);
  });

  it("keeps the highest share seen across a change of part: a final encode that reports less stands still and says nothing", () => {
    const reps = [
      ...inPart(line(0, 30, 1, 0.5, 0.004), 3, 4),
      ...inPart(line(31, 40, 1, 0.2, 0), 1, 4),
      ...inPart(line(41, 90, 1, 0.3, 0.01), 3, 4),
    ];
    const vs = valuesOf(reps);
    // 0.62 was seen; the new final encode reports 0.30 up to 0.62 (at 73 s), which stands still
    expect(vs.slice(41, 74).every((v) => v.kind === "none")).toBe(true);
    expect(vs[90].kind).toBe("left");
  });

  const plain = shows(steady(0.01, 1, 40));
  it("has a feed worth comparing: the one-process feed says a figure", () => {
    expect(plain).toContain("left 60");
  });

  it.each<[number | null | undefined, number | null | undefined]>([
    [0.5, 3],
    [-1, 3],
    [3, 3],
    [5, 3],
    [0, 1],
    [0, 0],
    [NaN, 3],
    [1, NaN],
    [Infinity, 3],
    [1, Infinity],
    [1.5, 3],
    [1, 2.5],
    [-1, -1],
    [null, 3],
    [1, null],
    [undefined, 3],
    [2, undefined],
    [null, null],
  ])("reads step %s of %s steps as a render in one process", (step, steps) => {
    const given = shows(steady(0.01, 1, 40).map((r) => ({ ...r, step, steps })));
    expect(given).toEqual(plain);
  });
});

// ── R9 ─────────────────────────────────────────────────────────────────────────────────────────

describe("R9 robustness", () => {
  const atArb = fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 0, max: 600_000 }).map((ms) => 1.7e12 + ms) },
    {
      weight: 3,
      arbitrary: fc.constantFrom(
        NaN,
        Infinity,
        -Infinity,
        0,
        -1,
        1.7e12,
        1.7e12 + 0.5,
        1e308,
        -1e308,
        Number.MAX_SAFE_INTEGER,
        8e15,
      ),
    },
    { weight: 1, arbitrary: fc.double() },
  );
  const shareArb = fc.oneof(
    { weight: 6, arbitrary: fc.double({ min: -0.5, max: 1.5, noNaN: true }) },
    {
      weight: 3,
      arbitrary: fc.constantFrom(
        NaN,
        Infinity,
        -Infinity,
        0,
        0.15,
        0.8999,
        0.9,
        1,
        2,
        -1,
        1e300,
        -1e300,
        Number.MIN_VALUE,
      ),
    },
    { weight: 1, arbitrary: fc.double() },
  );
  const partArb = fc.constantFrom(undefined, null, NaN, -1, 0, 1, 2, 3, 1.5, Infinity);
  const wildReportArb = fc.record(
    { at: atArb, fraction: shareArb, step: partArb, steps: partArb },
    { requiredKeys: ["at", "fraction"] },
  );

  it("never throws and always answers one of the four kinds, a grid figure within 48 h, nothing NaN, negative or infinite", () => {
    fc.assert(
      fc.property(fc.array(wildReportArb, { minLength: 1, maxLength: 80 }), (reports) => {
        let s = startPace();
        for (const r of reports) {
          s = notePace(s, r);
          const problem = problemWith(s.value);
          if (problem !== null) throw new Error(`${problem} after ${JSON.stringify(r)}`);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it("never changes the state it was given, and answers the same from a frozen state", () => {
    fc.assert(
      fc.property(perturbedArb, ([spec, seed, level]) => {
        const reps = perturb(buildFeed(spec), seed, level).slice(0, 300);
        const plainRun = shows(reps);
        let s = deepFreeze(startPace());
        const frozenRun: string[] = [];
        for (const r of reps) {
          const before = JSON.stringify(snapshot(s));
          const next = notePace(s, reportOf(r, BASE));
          if (JSON.stringify(snapshot(s)) !== before) throw new Error("the given state changed");
          s = deepFreeze(next);
          frozenRun.push(show(s.value));
        }
        expect(frozenRun).toEqual(plainRun);
      }),
      { numRuns: 40 },
    );
  });

  it("answers from a given state the same however often it is asked and whatever else was done with that state", () => {
    const warm = states(steady(0.01, 1, 25))[25];
    const next: PaceReport = { at: BASE + 26_000, fraction: 0.26 };
    const first = notePace(warm, next);
    notePace(warm, { at: BASE + 27_000, fraction: 0.9 });
    notePace(warm, { at: BASE + 99_000, fraction: 0.3 });
    const again = notePace(warm, next);
    expect(show(again.value)).toBe(show(first.value));
    expect(snapshot(again)).toEqual(snapshot(first));
  });

  it("keeps two runs apart: played in turn on the same module, each gives what it gives alone", () => {
    const a = steady(0.01, 1, 40);
    const b = steady(0.0007, 1, 70);
    let sa = startPace();
    let sb = startPace();
    const mixedA: string[] = [];
    const mixedB: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (i < a.length) {
        sa = notePace(sa, reportOf(a[i], BASE));
        mixedA.push(show(sa.value));
      }
      if (i < b.length) {
        sb = notePace(sb, reportOf(b[i], BASE + 7));
        mixedB.push(show(sb.value));
      }
    }
    expect(mixedA).toEqual(shows(a));
    expect(mixedB).toEqual(shows(b));
  });

  it("ignores a malformed report or state instead of throwing", () => {
    const warm = states(steady(0.01, 1, 30))[30];
    const noNumbers: unknown[] = [null, undefined, {}, [], 42, "report"];
    for (const bad of noNumbers) {
      expect(() => notePace(warm, bad as PaceReport)).not.toThrow();
      expect(notePace(warm, bad as PaceReport).value).toBe(warm.value);
    }
    const odd: unknown[] = [
      { at: "5", fraction: "0.5" },
      { at: BASE + 31_000, fraction: 1n },
      {
        get at(): number {
          throw new Error("a report whose time cannot be read");
        },
        fraction: 0.5,
      },
    ];
    for (const bad of odd) {
      expect(() => notePace(warm, bad as PaceReport)).not.toThrow();
    }
    const stripped = { value: NO_TIME_LEFT } as unknown as PaceState;
    expect(() => notePace(stripped, { at: BASE, fraction: 0.5 })).not.toThrow();
    expect(problemWith(notePace(stripped, { at: BASE, fraction: 0.5 }).value)).toBeNull();
  });
});

// ── R10 ────────────────────────────────────────────────────────────────────────────────────────

describe("R10 the answer depends on the feed, not on the clock it was read from", () => {
  it("is the same when a constant, even a huge one, is added to every time", () => {
    fc.assert(
      fc.property(feedSpecArb, fc.constantFrom(1, 1_234_567, 1.7e12, 8e15), (spec, shift) => {
        const reps = buildFeed(spec);
        expect(shows(reps, shift)).toEqual(shows(reps, 0));
      }),
      { numRuns: 200 },
    );
  });

  it("treats a late join (the first report already at 0.45, as after a reload) as a fresh clock whose starting share was not made here", () => {
    // 0.004 a second from 0.45: no figure before 20 s of its own although 45 % is "made";
    // at 20 s 0.47 is left: 117.5 s
    const reps = line(0, 100, 1, 0.45, 0.004);
    const vs = valuesOf(reps);
    expect(vs.slice(0, 20).every((v) => v.kind === "none")).toBe(true);
    expect(show(vs[20])).toBe("left 120");
    // the average pace here is the 0.004 a second made here, so 'taking longer' never comes
    expect(vs.some((v) => v.kind === "longer")).toBe(false);
  });
});

// ── R11 ────────────────────────────────────────────────────────────────────────────────────────

describe("R11 an unchanged answer is the very same object", () => {
  it("hands out the identical value object whenever two reports leave the answer unchanged", () => {
    let same = 0;
    fc.assert(
      fc.property(perturbedArb, ([spec, seed, level]) => {
        const vs = valuesOf(perturb(buildFeed(spec), seed, level));
        for (let i = 1; i < vs.length; i += 1) {
          if (show(vs[i]) !== show(vs[i - 1])) continue;
          same += 1;
          if (vs[i] !== vs[i - 1])
            throw new Error(`report ${i}: ${show(vs[i])} came as a new object`);
        }
      }),
      { numRuns: 250 },
    );
    expect(same).toBeGreaterThan(5000);
  });

  const unchangedButNewObject = (vs: readonly TimeLeft[]): string | null => {
    for (let i = 1; i < vs.length; i += 1) {
      if (show(vs[i]) === show(vs[i - 1]) && vs[i] !== vs[i - 1]) {
        return `report ${i}: ${show(vs[i])} came as a new object`;
      }
    }
    return null;
  };

  it("hands out one object for each unchanged answer through nothing, a figure, taking longer and Finishing", () => {
    const vs = valuesOf(stallSprintFinish());
    expect(new Set(vs.map((v) => v.kind))).toEqual(
      new Set(["none", "left", "longer", "finishing"]),
    );
    expect(unchangedButNewObject(vs)).toBeNull();
  });

  it("hands out one object for each unchanged answer in a render in parts too", () => {
    const vs = valuesOf(threeParts());
    expect(new Set(vs.map((v) => v.kind))).toEqual(new Set(["none", "left"]));
    expect(unchangedButNewObject(vs)).toBeNull();
  });

  it("hands back the identical value for a report that is no report", () => {
    const warm = states(steady(0.01, 1, 30))[30];
    const bad: PaceReport[] = [
      { at: NaN, fraction: 0.5 },
      { at: Infinity, fraction: 0.5 },
      { at: -Infinity, fraction: 0.5 },
      { at: BASE + 31_000, fraction: NaN },
      { at: BASE + 31_000, fraction: Infinity },
      { at: BASE + 31_000, fraction: -Infinity },
    ];
    for (const r of bad) expect(notePace(warm, r).value).toBe(warm.value);
  });
});

// ── the written rule, report by report ─────────────────────────────────────────────────────────

describe("the written rule, report by report", () => {
  const disagreement = (reps: readonly Rep[], got: string[], want: string[]): string | null => {
    const bad = got.findIndex((g, i) => g !== want[i]);
    if (bad < 0) return null;
    return `report ${bad} (${reps[bad].t} s, ${reps[bad].f} made): the module says ${got[bad]}, the rule says ${want[bad]}`;
  };

  it("is followed exactly by the module on any feed a real export could produce", () => {
    let withFigures = 0;
    fc.assert(
      fc.property(feedSpecArb, (spec) => {
        const reps = buildFeed(spec);
        const run = modelRun(reps);
        fc.pre(!run.fragile);
        const got = valuesOf(reps).map(show);
        const problem = disagreement(reps, got, run.said.map(showSaid));
        if (problem !== null) throw new Error(problem);
        if (got.some((g) => g.startsWith("left"))) withFigures += 1;
      }),
      { numRuns: 400 },
    );
    expect(withFigures).toBeGreaterThan(80);
  });

  it("is followed exactly on feeds that go back in time and in share, repeat and carry garbage", () => {
    fc.assert(
      fc.property(perturbedArb, ([spec, seed, level]) => {
        const reps = perturb(buildFeed(spec), seed, level);
        const run = modelRun(reps);
        fc.pre(!run.fragile);
        const problem = disagreement(reps, shows(reps), run.said.map(showSaid));
        if (problem !== null) throw new Error(problem);
      }),
      { numRuns: 300 },
    );
  });
});

// ── a feed that is cleaned before it is read ───────────────────────────────────────────────────

describe("R14 a report that goes back in time is read as the same instant as the newest", () => {
  it("gives, for a feed whose clock goes back, what the same feed gives with the clock held at the newest instant", () => {
    fc.assert(
      fc.property(feedSpecArb, fc.integer(), (spec, seed) => {
        const rnd = mulberry32(seed);
        const wobbly = buildFeed(spec).map((r, i) =>
          i > 0 && rnd() < 0.3 ? { ...r, t: r.t - rnd() * 40 } : r,
        );
        expect(shows(wobbly)).toEqual(shows(holdClock(wobbly)));
      }),
      { numRuns: 300 },
    );
  });

  it("reads a report from 10 s ago as being now: the share it carries is counted over the last 20 s up to now", () => {
    // 0.002 a second to 80 s (the figure 7 min from 60 s), then a report stamped 70 s with 38.42 % made.
    // As a report at 80 s: 26.42 % over the window from 60 s, 0.01321 a second, 0.6158 left is 47 s (1 min).
    // Read at 70 s it would be 0.01421 a second and 43 s (under a minute)
    const reps: Rep[] = [...steady(0.002, 1, 80), { t: 70, f: 0.3842 }];
    const vs = valuesOf(reps);
    expect(show(vs[60])).toBe("left 420");
    expect(show(vs[80])).toBe("left 420");
    expect(show(vs[81])).toBe("left 60");
  });
});

describe("R15 a share that goes back stands still, and one out of range is clamped", () => {
  it("gives, for a feed whose share goes back or out of range, what the same feed gives with the share clamped and held at the highest seen", () => {
    fc.assert(
      fc.property(feedSpecArb, fc.integer(), (spec, seed) => {
        const rnd = mulberry32(seed);
        const odd = buildFeed(spec).map((r) => {
          const roll = rnd();
          if (roll < 0.2) return { ...r, f: r.f * rnd() };
          if (roll < 0.25) return { ...r, f: -rnd() * 5 };
          if (roll < 0.3) return { ...r, f: 1 + rnd() * 5 };
          return r;
        });
        expect(shows(odd)).toEqual(shows(holdShare(odd)));
      }),
      { numRuns: 300 },
    );
  });

  it("counts a share that stands still as time passing with no progress: the time left grows instead of keeping the old figure", () => {
    // 0.002 a second to 80 s, then reports of 5 % (below the 16 % seen) for 15 s: the share stands still
    const vs = valuesOf([...steady(0.002, 1, 80), ...line(81, 95, 1, 0.05, 0)]);
    const last = vs[vs.length - 1];
    expect(last.kind).toBe("left");
    expect(last.kind === "left" && last.seconds >= 1500).toBe(true);
  });

  it("reads a share below 0 as 0 and a share above 1 as 1", () => {
    const clean = steady(0.01, 1, 60);
    // a first report of -0.5 is 'no picture yet', not a starting share of -0.5 that would count as made
    const negativeStart = clean.map((r, i) => (i === 0 ? { ...r, f: -0.5 } : r));
    expect(shows(negativeStart)).toEqual(shows(clean));
    expect(shows(clean)).toContain("left 60");
    const short = clean.slice(0, 31);
    expect(shows([...short, { t: 31, f: 7 }])).toEqual(shows([...short, { t: 31, f: 1 }]));
    expect(valuesOf([...short, { t: 31, f: 7 }])[31].kind).toBe("finishing");
  });
});

describe("R17 a report that is not finite is no report", () => {
  it("gives what the feed gives without it, and hands back the answer it had", () => {
    fc.assert(
      fc.property(feedSpecArb, fc.integer(), (spec, seed) => {
        const rnd = mulberry32(seed);
        const clean = buildFeed(spec);
        const withJunk: Rep[] = [];
        const isJunk: boolean[] = [];
        const addJunk = (): void => {
          const pick = Math.floor(rnd() * 6);
          withJunk.push(
            pick < 3 ? { t: clean[0].t, f: NON_FINITE[pick] } : { t: NON_FINITE[pick - 3], f: 0.5 },
          );
          isJunk.push(true);
        };
        if (rnd() < 0.5) addJunk();
        for (const r of clean) {
          withJunk.push(r);
          isJunk.push(false);
          if (rnd() < 0.2) addJunk();
        }
        const got = valuesOf(withJunk);
        const want = valuesOf(clean);
        let k = 0;
        got.forEach((v, j) => {
          if (isJunk[j]) {
            const before = j === 0 ? NO_TIME_LEFT : got[j - 1];
            if (v !== before) throw new Error(`junk report ${j} changed the answer`);
          } else if (show(v) !== show(want[k++])) {
            throw new Error(
              `report ${j}: ${show(v)} where the clean feed says ${show(want[k - 1])}`,
            );
          }
        });
      }),
      { numRuns: 300 },
    );
  });
});

describe("R18 reports that come very fast", () => {
  it("keeps a bounded memory however fast the reports arrive", () => {
    let s = startPace();
    for (let i = 0; i <= 30_000; i += 1) {
      s = notePace(s, { at: BASE + i, fraction: round12(1e-6 * i) });
    }
    const size = JSON.stringify(snapshot(s)).length;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(250_000);
    expect(problemWith(s.value)).toBeNull();
  });

  it("reads the same pace from reports 50 times a second as from twice a second", () => {
    const fast = valuesOf(steady(0.01, 0.02, 25));
    const slow = valuesOf(steady(0.01, 0.5, 25));
    const firstFigure = (vs: TimeLeft[]): string =>
      show(vs[vs.findIndex((v) => v.kind !== "none")]);
    // 0.01 a second: 80 s left at 20 s
    expect(firstFigure(fast)).toBe("left 60");
    expect(firstFigure(slow)).toBe("left 60");
    expect(fast.findIndex((v) => v.kind !== "none")).toBe(1000);
  });
});
