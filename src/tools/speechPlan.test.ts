// The speech planner (S2): what to do with a whole-file transcription on this PC, and how to cover
// the parts of a file that are actually used. Pure, so every rule here is a property of it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CAP_S, planSpans, planWholeFile, type SpanWindow } from "./speechPlan";
import {
  paceBook,
  projectedS,
  spanLimitS,
  SPEECH_BACKENDS,
  type PaceBook,
  type PaceModel,
  type SpeechBackend,
} from "./speechPace";

const model = (backend: SpeechBackend, startupS: number, rate: number): PaceModel => ({
  backend,
  startupS,
  rate,
  runs: 1,
});
const book = (cpu: PaceModel, gpu: PaceModel): PaceBook => ({ cpu, gpu });

const startup = fc.integer({ min: 1, max: 120 });
const rate = fc.double({ min: 0.02, max: 8, noNaN: true });
const models = fc.tuple(startup, rate).map(([s, r]) => model("cpu", s, r));
const books = fc
  .tuple(startup, rate, startup, rate)
  .map(([cs, cr, gs, gr]) => book(model("cpu", cs, cr), model("gpu", gs, gr)));
const audio = fc.double({ min: 0, max: 200_000, noNaN: true });
const backend = fc.constantFrom<SpeechBackend>(...SPEECH_BACKENDS);

describe("planning a whole-file transcription", () => {
  it("never defers a graphics-chip job for its length alone", () => {
    fc.assert(
      fc.property(books, audio, (pace, audioS) => {
        const plan = planWholeFile({ backend: "gpu", held: false, audioS, pace });
        expect(plan).toMatchObject({ plan: "whole", why: "ok" });
      }),
    );
  });

  it("defers a processor job exactly when its projection on this PC passes the cap", () => {
    fc.assert(
      fc.property(books, audio, fc.boolean(), (pace, audioS, held) => {
        const plan = planWholeFile({ backend: held ? "gpu" : "cpu", held, audioS, pace });
        const projected = projectedS(pace.cpu, audioS);
        expect(plan.projectedS).toBe(projected);
        if (projected > CAP_S) expect(plan).toMatchObject({ plan: "ondemand", why: "cap" });
        else expect(plan).toMatchObject({ plan: "whole", why: held ? "gpu_held" : "cpu_only" });
      }),
    );
  });

  it("never plans a graphics-chip run while the chip is held: it is costed on the processor's own pace", () => {
    fc.assert(
      fc.property(books, audio, (pace, audioS) => {
        const held = planWholeFile({ backend: "gpu", held: true, audioS, pace });
        expect(held.projectedS).toBe(projectedS(pace.cpu, audioS));
        expect(held.why === "gpu_held" || held.why === "cap").toBe(true);
        // so a held chip is deferred exactly as a processor-only PC is
        expect(held.plan).toBe(planWholeFile({ backend: "cpu", held: false, audioS, pace }).plan);
      }),
    );
  });

  it("is monotone: a longer file or a slower PC never turns a deferred job into a whole one", () => {
    fc.assert(
      fc.property(
        books,
        backend,
        fc.boolean(),
        audio,
        audio,
        fc.double({ min: 1, max: 10, noNaN: true }),
        (pace, where, held, a, b, slower) => {
          const [short, long] = a <= b ? [a, b] : [b, a];
          const at = (p: PaceBook, audioS: number) =>
            planWholeFile({ backend: where, held, audioS, pace: p }).plan;
          if (at(pace, short) === "ondemand") expect(at(pace, long)).toBe("ondemand");
          const slow = book(
            model("cpu", pace.cpu.startupS * slower, pace.cpu.rate * slower),
            model("gpu", pace.gpu.startupS * slower, pace.gpu.rate * slower),
          );
          if (at(pace, long) === "ondemand") expect(at(slow, long)).toBe("ondemand");
        },
      ),
    );
  });

  it("agrees with the span limit: whatever fits the cap as a span is a whole file the plan runs", () => {
    fc.assert(
      fc.property(models, (cpu) => {
        const pace = book(cpu, cpu);
        const limit = spanLimitS(cpu, CAP_S);
        expect(planWholeFile({ backend: "cpu", held: false, audioS: limit, pace }).plan).toBe(
          "whole",
        );
        if (limit > 0)
          expect(planWholeFile({ backend: "cpu", held: false, audioS: limit + 1, pace }).plan).toBe(
            "ondemand",
          );
      }),
    );
  });

  it("is a decision for any input at all, never a crash", () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        fc.constantFrom(NaN, Infinity, -Infinity, -1, 0, 1e300, undefined, null, "9"),
        (where, held, audioS) => {
          const plan = planWholeFile({
            backend: where as SpeechBackend,
            held: held as boolean,
            audioS: audioS as number,
            pace: paceBook([], "windows"),
          });
          expect(["whole", "ondemand"]).toContain(plan.plan);
          expect(["ok", "cap", "cpu_only", "gpu_held"]).toContain(plan.why);
          expect(Number.isFinite(plan.projectedS)).toBe(true);
        },
      ),
    );
  });
});

/** The rule get_transcript already uses: each span padded, and the padded spans that overlap one. */
function mergedPadded(spans: Array<[number, number]>, pad: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of [...spans].sort((p, q) => p[0] - q[0])) {
    const start = Math.max(0, a - pad);
    const end = b + pad;
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

const span = fc
  .tuple(fc.integer({ min: 0, max: 20_000 }), fc.integer({ min: 1, max: 2_000 }))
  .map(([start, len]): [number, number] => [start, start + len]);
const spans = fc.array(span, { minLength: 1, maxLength: 12 });
const caps = fc.integer({ min: 60, max: 1_200 });

describe("planning the parts of a file that are used", () => {
  const plan = (used: Array<[number, number]>, pace: PaceModel, capS: number, padS = 1) =>
    planSpans({ usedSpans: used, padS, pace, capS });

  it("covers every used second, in windows that are in order and never overlap", () => {
    fc.assert(
      fc.property(spans, models, caps, (used, pace, capS) => {
        const { windows } = plan(used, pace, capS);
        for (const [a, b] of used)
          expect(
            windows.some((w) => w.start <= a && w.end >= b),
            `[${a}, ${b}] is in no window`,
          ).toBe(true);
        for (let i = 1; i < windows.length; i++)
          expect(windows[i].start).toBeGreaterThan(windows[i - 1].end);
      }),
      { numRuns: 300 },
    );
  });

  it("costs every window on its own start-up, and the plan is their sum", () => {
    fc.assert(
      fc.property(spans, models, caps, (used, pace, capS) => {
        const { windows, projectedS: total } = plan(used, pace, capS);
        for (const w of windows)
          expect(w.projectedS).toBeCloseTo(projectedS(pace, w.end - w.start), 6);
        expect(total).toBeCloseTo(
          windows.reduce((n, w) => n + w.projectedS, 0),
          6,
        );
      }),
    );
  });

  it("never plans a window past the cap unless the used span alone is past it, and says so", () => {
    fc.assert(
      fc.property(spans, models, caps, (used, pace, capS) => {
        const { windows } = plan(used, pace, capS);
        const base = mergedPadded(used, 1);
        const isBase = (w: SpanWindow) => base.some(([s, e]) => s === w.start && e === w.end);
        for (const w of windows) {
          if (w.overCap) {
            expect(isBase(w), "an over-cap window is one used window, never a merge").toBe(true);
            expect(w.projectedS).toBeGreaterThan(capS);
          } else expect(w.projectedS).toBeLessThanOrEqual(capS + 1e-9);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("merges across a gap only when the gap costs less than a new start-up, and never costs more than not merging", () => {
    fc.assert(
      fc.property(spans, models, caps, (used, pace, capS) => {
        const { windows, projectedS: total } = plan(used, pace, capS);
        const apart = mergedPadded(used, 1).reduce((n, [s, e]) => n + projectedS(pace, e - s), 0);
        expect(total).toBeLessThanOrEqual(apart + 1e-6);
        for (let i = 1; i < windows.length; i++) {
          const [left, right] = [windows[i - 1], windows[i]];
          const gap = right.start - left.end;
          const together = projectedS(pace, right.end - left.start);
          // two windows that stayed apart: merging them would not have paid, or would not have fitted
          expect(gap * pace.rate >= pace.startupS || together > capS, `gap ${gap}`).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("does the same whatever order the spans come in", () => {
    fc.assert(
      fc.property(spans, models, caps, (used, pace, capS) => {
        expect(plan([...used].reverse(), pace, capS)).toEqual(plan(used, pace, capS));
      }),
    );
  });

  it("is an empty plan for no usable span, and never a crash for any input", () => {
    const pace = model("cpu", 20, 3.7);
    expect(plan([], pace, CAP_S)).toEqual({ windows: [], projectedS: 0 });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.anything(), fc.anything()), { maxLength: 8 }),
        fc.anything(),
        fc.anything(),
        (junk, padS, capS) => {
          const out = planSpans({
            usedSpans: junk as unknown as Array<[number, number]>,
            padS: padS as number,
            pace,
            capS: capS as number,
          });
          expect(Number.isFinite(out.projectedS)).toBe(true);
          for (const w of out.windows) expect(w.end).toBeGreaterThan(w.start);
        },
      ),
    );
    expect(
      plan(
        [
          [10, 5],
          [NaN, 4],
          [3, Infinity],
        ] as Array<[number, number]>,
        pace,
        CAP_S,
      ).windows,
    ).toEqual([]);
  });

  // Ten clips of one long file, as a person's timeline cuts it (docs/ALIGNMENT 5.3): what a PC that
  // starts in 3 s and one that needs 65 s each have to do for the same ten used stretches.
  const TEN: Array<[number, number]> = [
    30, 400, 800, 1_300, 1_900, 2_300, 2_800, 3_400, 3_900, 4_500,
  ].map((s) => [s, s + 20]);

  it("runs ten distant clips as ten runs where a start-up is short, and as one where it is a minute and the cap allows", () => {
    const quick = plan(TEN, model("gpu", 3, 0.1), CAP_S);
    const slowModel = model("gpu", 65, 0.1);
    const slowStart = plan(TEN, slowModel, CAP_S);
    expect(quick.windows).toHaveLength(10); // every gap is 300+ s of audio at 0.1 s each: 30 s > 3 s
    expect(slowStart.windows.length).toBeLessThan(quick.windows.length);
    // the same clips are covered either way, and the merge is what pays for the extra audio read
    for (const [a, b] of TEN)
      for (const p of [quick, slowStart])
        expect(p.windows.some((w) => w.start <= a && w.end >= b)).toBe(true);
    const separately = TEN.reduce((n, [s, e]) => n + projectedS(slowModel, e - s + 2), 0);
    expect(slowStart.projectedS).toBeLessThan(separately);
    expect(slowStart.windows.every((w) => !w.overCap)).toBe(true);
    // a cap that the merged window would pass keeps the runs apart rather than pass it
    const tight = plan(TEN, slowModel, 300);
    expect(tight.windows.length).toBeGreaterThan(1);
    expect(tight.windows.every((w) => w.projectedS <= 300)).toBe(true);
  });

  it("returns a clip longer than this PC can do within the cap as ONE over-cap window, to run and to be told first", () => {
    const pace = model("cpu", 20, 3.7);
    const longClip: Array<[number, number]> = [[100, 100 + spanLimitS(pace, CAP_S) + 600]];
    const { windows } = plan(longClip, pace, CAP_S);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ overCap: true });
    expect(windows[0].projectedS).toBeGreaterThan(CAP_S);
  });
});
