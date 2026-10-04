// The storyboard's selection rules, independent of ffmpeg: which candidates become tiles, how many,
// and how times are labelled.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  OVERVIEW,
  candidateTimes,
  keepTiles,
  tileSize,
  timeLabel,
  type Candidate,
} from "./storyboard";

const flat = (v: number): Uint8Array => new Uint8Array(64).fill(v);
const cand = (t: number, v: number): Candidate => ({ t, grid: flat(v) });

describe("candidateTimes", () => {
  it("covers the window with at most ~120 points, none outside it", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 10_000, noNaN: true }),
        fc.double({ min: 0.5, max: 20_000, noNaN: true }),
        (start, span) => {
          const ts = candidateTimes(start, start + span);
          expect(ts.length).toBeGreaterThan(0);
          expect(ts.length).toBeLessThanOrEqual(OVERVIEW.candidates + 1);
          for (const t of ts) {
            expect(t).toBeGreaterThanOrEqual(start);
            expect(t).toBeLessThan(start + span + 1e-9);
          }
        },
      ),
    );
  });

  it("never samples closer than a second apart", () => {
    const ts = candidateTimes(0, 30);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(1 - 1e-9);
  });
});

describe("keepTiles", () => {
  it("a video that never changes is ONE tile", () => {
    const cands = Array.from({ length: 120 }, (_, i) => cand(i, 80));
    expect(keepTiles(cands)).toEqual([0]);
  });

  it("every visibly different scene gets a tile, up to 36", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 120 }), (scenes) => {
        // alternating dark/bright scenes: every change is far above the threshold
        const cands = Array.from({ length: scenes }, (_, i) => cand(i, i % 2 ? 200 : 20));
        expect(keepTiles(cands)).toHaveLength(Math.min(36, scenes));
      }),
    );
  });

  it("a change at or under the threshold is not a new tile; just over it is", () => {
    expect(keepTiles([cand(0, 100), cand(1, 100 + OVERVIEW.promoteDiff)])).toEqual([0]);
    expect(keepTiles([cand(0, 100), cand(1, 101 + OVERVIEW.promoteDiff)])).toEqual([0, 1]);
  });

  it("two seeks that landed on the same keyframe count once", () => {
    expect(keepTiles([cand(4, 20), cand(4, 200), cand(9, 200)])).toEqual([0, 2]);
  });

  it("thinning keeps tiles in order and spread across the whole video", () => {
    const cands = Array.from({ length: 100 }, (_, i) => cand(i, i % 2 ? 200 : 20));
    const kept = keepTiles(cands);
    expect(kept).toHaveLength(36);
    for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeGreaterThan(kept[i - 1]);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBeGreaterThan(90); // reaches the end, not just the start
  });
});

describe("timeLabel and tileSize", () => {
  it("labels like a player: m:ss, then h:mm:ss", () => {
    expect(timeLabel(0)).toBe("0:00");
    expect(timeLabel(59.6)).toBe("1:00");
    expect(timeLabel(3599.4)).toBe("59:59");
    expect(timeLabel(3600)).toBe("1:00:00");
    expect(timeLabel(9721)).toBe("2:42:01");
  });

  it("keeps the source's shape with a 160 px long edge and even sides", () => {
    expect(tileSize(1920, 1080)).toEqual({ w: 160, h: 90 });
    expect(tileSize(1080, 1920)).toEqual({ w: 90, h: 160 });
    expect(tileSize(768, 576)).toEqual({ w: 160, h: 120 });
    fc.assert(
      fc.property(
        fc.integer({ min: 16, max: 8000 }),
        fc.integer({ min: 16, max: 8000 }),
        (w, h) => {
          const t = tileSize(w, h);
          expect(Math.max(t.w, t.h)).toBe(160);
          expect(t.w % 2).toBe(0);
          expect(t.h % 2).toBe(0);
        },
      ),
    );
  });
});
