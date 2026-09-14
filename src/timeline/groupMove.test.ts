// Dragging a MULTI-CLIP selection.
//
// Reported by an alpha user: "audio video select together using shift not working - and when you
// drag together selected clips they don't move together". The second half was real - the drag
// captured a single clipId, so a marquee over five clips still moved one.
//
// These pin the OUTCOME on the timeline (where every clip ended up), not the arguments handed to
// the operation, and they lead with the failure directions: a refused move must leave the document
// untouched, and the group must clamp as one unit rather than piling up at the rail.
import { describe, expect, it } from "vitest";

import type { Timeline, Track } from "./model";
import { nudgeClips } from "./operations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clip = (id: string, tin: number, tout: number, extra: any = {}) => ({
  id,
  media_ref: "cam.mp4",
  timeline_in: tin,
  timeline_out: tout,
  source_in: tin,
  source_out: tout,
  speed: 1,
  ...extra,
});

const tl = (v1: unknown[], a1: unknown[] = []): Timeline =>
  ({
    canvas: { width: 1920, height: 1080, fps: 30 },
    tracks: [
      { id: "v1", kind: "video", z: 0, clips: v1 },
      { id: "a1", kind: "audio", z: 0, clips: a1 },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const on = (t: Timeline, id: string): Track => t.tracks!.find((x) => x.id === id)!;
const spans = (t: Timeline, id: string) =>
  (on(t, id).clips ?? [])
    .map((c) => [Number(c.timeline_in), Number(c.timeline_out)])
    .sort((x, y) => x[0] - y[0]);

describe("dragging a selection of clips", () => {
  it("moves every selected clip by the same delta, preserving the gaps between them", () => {
    const t = tl([clip("a", 0, 30), clip("b", 60, 90), clip("c", 200, 230)]);
    nudgeClips(t, ["a", "b"], 10);
    // The two selected clips shift together; the unselected one does not move at all.
    expect(spans(t, "v1")).toEqual([
      [10, 40],
      [70, 100],
      [200, 230],
    ]);
  });

  it("clamps the GROUP at frame 0, rather than squashing it against the rail", () => {
    const t = tl([clip("a", 10, 40), clip("b", 60, 90)]);
    nudgeClips(t, ["a", "b"], -50); // would put 'a' at -40
    // Both move by the same -10; the 50-frame gap between them survives. Clamping per clip
    // would have parked 'a' at 0 and 'b' at 10, silently collapsing the selection.
    expect(spans(t, "v1")).toEqual([
      [0, 30],
      [50, 80],
    ]);
  });

  it("REFUSES the whole move when any clip would land on a bystander, changing nothing", () => {
    const t = tl([clip("a", 0, 30), clip("b", 60, 90), clip("victim", 100, 130)]);
    const before = JSON.stringify(t);
    expect(() => nudgeClips(t, ["a", "b"], 40, { refuseOverwrite: true })).toThrow(/on top of/);
    // All-or-nothing: 'a' had a clear landing at [40,70) and must NOT have been moved either.
    expect(JSON.stringify(t)).toBe(before);
  });

  it("does not treat the selection's own members as obstacles", () => {
    // 'b' currently occupies [60,90); after the move 'a' lands exactly there. Since 'b' is
    // travelling too, that is not a collision - a naive check would refuse this legal drag.
    const t = tl([clip("a", 0, 30), clip("b", 60, 90)]);
    nudgeClips(t, ["a", "b"], 60);
    expect(spans(t, "v1")).toEqual([
      [60, 90],
      [120, 150],
    ]);
  });

  it("carries a linked partner exactly once, not twice, when both halves are selected", () => {
    // Selection expands to the link group, so BOTH ids arrive. If the operation moved the
    // explicit entry and then moved it again as its partner's companion, the pair would drift
    // to double the delta.
    const t = tl(
      [clip("vid", 0, 120, { link_group: "g1" })],
      [clip("aud", 0, 120, { link_group: "g1" })],
    );
    nudgeClips(t, ["vid", "aud"], 30);
    expect(spans(t, "v1")).toEqual([[30, 150]]);
    expect(spans(t, "a1")).toEqual([[30, 150]]);
  });

  it("a single-clip drag still overwrites, because refuseOverwrite is opt-in", () => {
    const t = tl([clip("a", 0, 30), clip("victim", 40, 70)]);
    nudgeClips(t, ["a"], 40);
    expect(spans(t, "v1")).toEqual([[40, 70]]); // the victim was overwritten, as an NLE does
  });
});
