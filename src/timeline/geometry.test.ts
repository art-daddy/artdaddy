import { describe, expect, it } from "vitest";

import {
  frameToX,
  secToX,
  snapFrame,
  snapTargets,
  totalFrames,
  xToFrame,
  xToSec,
} from "./geometry";
import { emptyTimeline, type Timeline } from "./model";

function tl(
  clips: Array<{ id: string; kind?: string; in: number; out: number; track?: string }>,
): Timeline {
  const byTrack = new Map<string, Array<Record<string, unknown>>>();
  for (const c of clips) {
    const t = c.track ?? "v1";
    if (!byTrack.has(t)) byTrack.set(t, []);
    byTrack.get(t)!.push({
      id: c.id,
      kind: c.kind ?? "video",
      media_ref: "x",
      timeline_in: c.in,
      timeline_out: c.out,
    });
  }
  return {
    ...emptyTimeline(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tracks: [...byTrack].map(([id, cs]) => ({ id, kind: "video", clips: cs })) as any,
  };
}

describe("timeline geometry", () => {
  it("maps seconds <-> x with zoom and scroll", () => {
    expect(secToX(2, 40)).toBe(80);
    expect(secToX(2, 40, 30)).toBe(50);
    expect(xToSec(80, 40)).toBe(2);
    expect(xToSec(50, 40, 30)).toBe(2);
  });

  it("maps frames <-> x at fps and rounds to whole frames", () => {
    expect(frameToX(30, 30, 40)).toBe(40); // 1s at 40px/s
    expect(xToFrame(40, 30, 40)).toBe(30);
    expect(xToFrame(41, 30, 40)).toBe(31);
  });

  it("collects snap targets: 0, playhead, and other clips' edges (sorted)", () => {
    const t = tl([
      { id: "a", in: 0, out: 30 },
      { id: "b", in: 60, out: 90 },
    ]);
    expect(snapTargets(t, { playheadFrame: 45 })).toEqual([0, 30, 45, 60, 90]);
    expect(snapTargets(t, { excludeIds: ["b"] })).toEqual([0, 30]);
  });

  // A linked A/V pair sits at the SAME frames. Excluding only the grabbed clip leaves its
  // partner offering the pair its own starting edges, so every small drag snapped straight
  // back to where it began — which reads as "moving clips doesn't snap" / "won't budge".
  it("excludes the whole travelling set, so a linked pair cannot snap to its own origin", () => {
    const t = tl([
      { id: "vid", in: 100, out: 200 },
      { id: "aud", in: 100, out: 200, track: "a1" },
      { id: "other", in: 400, out: 500 },
    ]);
    expect(snapTargets(t, { excludeIds: ["vid"] })).toContain(100); // the partner's edge: the bug
    const live = snapTargets(t, { excludeIds: ["vid", "aud"] });
    expect(live).not.toContain(100);
    expect(live).not.toContain(200);
    expect(live).toEqual([0, 400, 500]); // only genuinely stationary edges remain
  });

  it("snaps a candidate to the nearest target within the px threshold", () => {
    const targets = [0, 30, 60];
    expect(snapFrame(62, targets, 30, 40, 8)).toBe(60); // ~2.7px away -> snaps
    expect(snapFrame(45, targets, 30, 40, 8)).toBe(45); // ~20px away -> no snap
  });

  it("totalFrames is the max clip end across tracks", () => {
    const t = tl([
      { id: "a", in: 0, out: 90, track: "v1" },
      { id: "b", in: 0, out: 120, track: "a1" },
    ]);
    expect(totalFrames(t)).toBe(120);
    expect(totalFrames(emptyTimeline())).toBe(0);
  });
});
