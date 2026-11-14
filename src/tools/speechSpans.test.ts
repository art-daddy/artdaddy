// The stretches of a file the clips play, and the windows transcribed for them (S2-10). The rules here
// are shared by get_transcript and add_captions, so they are checked as rules, not as a call's output.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Clip } from "../timeline/model";
import { currentPaceModel, type PaceModel } from "./speechPace";
import { CAP_S } from "./speechPlan";
import { padded, playedSpan, SPAN_PAD_S, spanWindows } from "./speechSpans";

const FPS = 30;
const clip = (over: Partial<Clip>): Clip =>
  ({
    id: "c",
    kind: "audio",
    media_ref: "library/a.m4a",
    timeline_in: 0,
    timeline_out: 300,
    source_in: 0,
    source_out: 300,
    ...over,
  }) as Clip;

describe("the source seconds a clip plays", () => {
  it("is the trimmed stretch of its file, at its speed", () => {
    // 3 s of timeline at speed 2 plays 6 s of the file, from its 10th second.
    expect(
      playedSpan(clip({ source_in: 300, timeline_out: 90, speed: 2 }), FPS, -Infinity, Infinity),
    ).toEqual([10, 16]);
  });

  it("is only the part inside the frames asked about, and nothing when none of the clip is there", () => {
    const c = clip({ timeline_in: 100, timeline_out: 400, source_in: 0 });
    // frames 200 to 250 of the timeline are 100 to 150 frames into the clip's source
    expect(playedSpan(c, FPS, 200, 250)).toEqual([100 / FPS, 150 / FPS]);
    expect(playedSpan(c, FPS, 0, 100)).toBeNull();
    expect(playedSpan(c, FPS, 400, 500)).toBeNull();
  });

  it("is the padded stretch a second either side, never before the start of the file", () => {
    expect(SPAN_PAD_S).toBe(1);
    expect(padded([10, 16])).toEqual({ start: 9, end: 17 });
    expect(padded([0.4, 2])).toEqual({ start: 0, end: 3 });
  });
});

const pace = (startupS: number, rate: number): PaceModel => ({
  backend: "cpu",
  startupS,
  rate,
  runs: 1,
});
const use = fc
  .tuple(
    fc.constantFrom("a", "b", "c"),
    fc.integer({ min: 0, max: 5_000 }),
    fc.integer({ min: 1, max: 900 }),
  )
  .map(([file, start, len]) => ({ file, span: [start, start + len] as [number, number] }));
const uses = fc.array(use, { minLength: 1, maxLength: 10 });
const paces = fc
  .tuple(fc.integer({ min: 1, max: 120 }), fc.double({ min: 0.02, max: 8, noNaN: true }))
  .map(([s, r]) => pace(s, r));

describe("the window transcribed for each use of a file", () => {
  it("holds the padded stretch of its use, and windows of one file never overlap", () => {
    fc.assert(
      fc.property(uses, paces, (list, p) => {
        const windows = spanWindows(list, (u) => u.file, p);
        for (const u of list) {
          const w = windows.get(u)!;
          const own = padded(u.span);
          expect(w.start).toBeLessThanOrEqual(own.start);
          expect(w.end).toBeGreaterThanOrEqual(own.end);
        }
        for (const file of ["a", "b", "c"]) {
          const mine = [
            ...new Set(list.filter((u) => u.file === file).map((u) => windows.get(u)!)),
          ].sort((x, y) => x.start - y.start);
          for (let i = 1; i < mine.length; i++)
            expect(mine[i].start, `${file}: windows overlap`).toBeGreaterThan(mine[i - 1].end);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("depends on the used spans alone: the same range whatever this PC's pace, so the cache finds it again", () => {
    fc.assert(
      fc.property(uses, paces, paces, (list, p, q) => {
        const a = spanWindows(list, (u) => u.file, p);
        const b = spanWindows(list, (u) => u.file, q);
        for (const u of list) {
          expect([a.get(u)!.start, a.get(u)!.end]).toEqual([b.get(u)!.start, b.get(u)!.end]);
        }
      }),
    );
  });

  it("flags only a window that alone passes the cap on this PC, and never merges clips to do it", () => {
    const slow = pace(20, 3.7);
    const [short, long] = [
      { file: "a", span: [0, 60] as [number, number] },
      { file: "b", span: [0, 4_000] as [number, number] },
    ];
    const windows = spanWindows([short, long], (u) => u.file, slow);
    expect(windows.get(short)!.overCap).toBe(false);
    expect(windows.get(long)!.overCap).toBe(true);
    expect(windows.get(long)!.projectedS).toBeGreaterThan(CAP_S);
  });

  it("gives two clips of one file that touch once padded one window, and clips of two files two", () => {
    const [x, y, z] = [
      { file: "a", span: [100, 110] as [number, number] },
      { file: "a", span: [110, 120] as [number, number] },
      { file: "b", span: [100, 110] as [number, number] },
    ];
    const windows = spanWindows([x, y, z], (u) => u.file, pace(20, 3.7));
    expect(windows.get(x)).toBe(windows.get(y));
    expect(windows.get(z)).not.toBe(windows.get(x));
    expect([windows.get(x)!.start, windows.get(x)!.end]).toEqual([99, 121]);
  });

  it("is never a crash: a span that is not a number still gets a window of its own", () => {
    const junk = { file: "a", span: [NaN, 4] as [number, number] };
    const ok = { file: "a", span: [10, 20] as [number, number] };
    const windows = spanWindows([junk, ok], (u) => u.file, currentPaceModel([], "linux"));
    expect(windows.get(ok)).toMatchObject({ start: 9, end: 21 });
    expect(windows.has(junk)).toBe(true);
  });
});
