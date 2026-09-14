// Moving a clip: where it lands, what it may overwrite, and what it costs to undo.
//
// These drags run with snapping OFF, because they assert an EXACT landing frame and a snap
// would legitimately move it. Turning it off used to mean holding Alt; Alt is now the
// override key (duplicate / one half of a link / ignore the trim handle), so it is a mode.
import { clipAt, laneRect, resetTimeline, setSnapping } from "../lib/setup.mjs";

/** Pixels per frame, calibrated from what is DRAWN against what is SAVED. Deriving it
 *  from the store's zoom would be a second copy of the app's own math. */
async function scale(d, t, track) {
  const els = await d.clipEls();
  const clips = await t.track(track);
  if (!els.length || !clips.length) return null;
  return els[0].w / (clips[0].tout - clips[0].tin);
}

async function clipEl(d, index = 0) {
  const els = await d.clipEls();
  return els[index] ?? null;
}

export const scenarios = [
  {
    area: "move",
    name: "a clip lands where the pointer left it",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 90 }]);
      await setSnapping(d, false);
      const px = await scale(d, t, "v1");
      const el = await clipEl(d);
      if (!px || !el) return t.expect(false, "a calibrated clip on v1");
      const byFrames = 60;
      await d.drag({ x: el.cx, y: el.cy }, { x: el.cx + byFrames * px, y: el.cy });
      const spans = await t.spansOf("v1");
      t.eq(spans, [[byFrames, byFrames + 90]], "moved by exactly the frames dragged");
    },
  },

  {
    area: "move",
    name: "a clip cannot be dragged before frame 0",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 30, len: 60 }]);
      await setSnapping(d, false);
      const px = await scale(d, t, "v1");
      const el = await clipEl(d);
      const lane = await laneRect(d, "v1");
      if (!px || !el || !lane) return t.expect(false, "a calibrated clip on v1");
      // Overshoot to the left, but never past the window: at a wider window `400 * px` lands at a
      // negative screen x, which no real pointer could reach and the driver rightly refuses.
      // Dragging the clip's CENTRE to the lane's start already asks for a negative timeline_in.
      const to = Math.max(lane.x + 2, el.cx - 400 * px);
      await d.drag({ x: el.cx, y: el.cy }, { x: to, y: el.cy });
      const spans = await t.spansOf("v1");
      t.eq(spans, [[0, 60]], "clamped at 0 and kept its length");
    },
  },

  {
    area: "move",
    name: "moving onto a neighbour overwrites it, Premiere-style",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
        { media: "bars3s.mp4", track: "v1", at: 100, len: 60 },
      ]);
      const px = await scale(d, t, "v1");
      const els = await d.clipEls();
      if (!px || els.length < 2) return t.expect(false, "two clips on v1", `${els.length}`);
      // Drag the SECOND clip left so it lands over the first's tail.
      await d.drag({ x: els[1].cx, y: els[1].cy }, { x: els[1].cx - 70 * px, y: els[1].cy });
      const spans = await t.spansOf("v1");
      const overlapping = spans.some((a, i) =>
        spans.some((b, j) => i !== j && a[0] < b[1] && b[0] < a[1]),
      );
      t.expect(!overlapping, "no two clips overlap after the move", JSON.stringify(spans));
      t.expect(
        spans.length === 2,
        "the overwritten clip was trimmed, not deleted",
        JSON.stringify(spans),
      );
    },
  },

  {
    area: "move",
    name: "a clip moves to another video track",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const el = await clipEl(d);
      const v2 = await laneRect(d, "v2");
      if (!el || !v2) return t.expect(false, "a clip and a v2 lane");
      await d.drag({ x: el.cx, y: el.cy }, { x: el.cx, y: v2.cy });
      const on2 = await t.track("v2");
      const on1 = await t.track("v1");
      t.expect(
        on2.length === 1 && on1.length === 0,
        "the clip is on v2 and gone from v1",
        `v1=${on1.length} v2=${on2.length}`,
      );
    },
  },

  {
    area: "move",
    name: "a video clip cannot be dropped on an audio track",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const el = await clipEl(d);
      const a1 = await laneRect(d, "a1");
      if (!el || !a1) return t.expect(false, "a clip and an a1 lane");
      await d.drag({ x: el.cx, y: el.cy }, { x: el.cx, y: a1.cy });
      // bars10s carries a tone, so a LINKED AUDIO clip legitimately lives on a1 already.
      // The invariant is that no VIDEO clip landed there.
      const video = (await t.track("a1")).filter((c) => c.kind !== "audio");
      t.expect(video.length === 0, "no video clip landed on the audio lane", JSON.stringify(video));
      t.expect((await t.track("v1")).length === 1, "and the clip stayed on v1");
    },
  },

  {
    area: "move",
    name: "a move is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const el = await clipEl(d);
      if (!el) return t.expect(false, "a clip to move");
      await t.assertOneUndo(
        () => d.drag({ x: el.cx, y: el.cy }, { x: el.cx + 100, y: el.cy }),
        "move a clip",
      );
    },
  },
];
