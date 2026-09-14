// Trimming: the area that shipped a data-corruption bug, so these are regression rails
// as much as parity checks. The oracle for the video cases is the media's REAL length,
// probed with ffprobe rather than assumed.
//
// Trim follows the pointer's ABSOLUTE frame (other NLEs do the same:
// `delta = snappedStart - drag.originalStartFrame`), so every expectation is stated as
// "drag the edge TO frame N", not "BY N frames". Handles are looked up per LANE: a global
// clip index drifts to the linked audio clip, which trims a different thing entirely.
import { durationFrames } from "../lib/fixtures.mjs";
import { resetTimeline, ruler, setSnapping } from "../lib/setup.mjs";

/** Everything a trim scenario needs, or null with the reason recorded.
 *
 *  Snapping goes OFF here because every expectation below is an exact frame and a snap would
 *  legitimately move it. It used to be "hold Alt", which now means the opposite of a trim:
 *  Alt SUPPRESSES the trim handle so the drag becomes a duplicate. */
async function grab(t, d, edge, index = 0) {
  await setSnapping(d, false);
  const r = await ruler(d, t, "v1");
  const h = await d.handleOn("v1", index, edge);
  const clips = await d.clipsOn("v1");
  if (!r || !h) {
    t.expect(false, `a calibrated ${edge} handle on v1`, `clips=${clips.length}`);
    return null;
  }
  return { r, h };
}

export const scenarios = [
  {
    area: "trim",
    name: "dragging the tail moves the out-point to the pointer",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 200 }]);
      const g = await grab(t, d, "end");
      if (!g) return;
      await d.drag({ x: g.h.cx, y: g.h.cy }, { x: g.r.xOf(140), y: g.h.cy });
      t.eq(await t.spansOf("v1"), [[0, 140]], "the out-point is where the pointer was released");
    },
  },

  {
    area: "trim",
    name: "a video's tail STOPS at the end of its own footage",
    async run(t, d, media) {
      // The shipped bug: this used to commit a clip claiming frames the file does not have.
      const total = durationFrames(media["bars10s.mp4"]);
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const g = await grab(t, d, "end");
      if (!g) return;
      const v = await d.viewport();
      await d.drag({ x: g.h.cx, y: g.h.cy }, { x: v.w - 8, y: g.h.cy });
      const c = (await t.track("v1"))[0];
      t.expect(
        c && c.tout - c.tin <= total,
        `the clip is no longer than the source (${total} frames)`,
        c ? `${c.tout - c.tin} frames` : "no clip",
      );
      t.expect(
        c && c.sout !== null && c.sout <= total,
        "source_out stays inside the file",
        c ? `sout=${c.sout}` : "",
      );
    },
  },

  {
    area: "trim",
    name: "a still extends past its placed length instead of snapping back",
    async run(t, d) {
      // The reported bug: a still has no source window, so the drag wrote half a window,
      // validation rejected the whole edit, and the clip visibly sprang back.
      await resetTimeline(d, t.projectId, [{ media: "still.png", track: "v1", at: 40, len: 60 }]);
      const g = await grab(t, d, "end");
      if (!g) return;
      await d.drag({ x: g.h.cx, y: g.h.cy }, { x: g.r.xOf(240), y: g.h.cy });
      const c = (await t.track("v1"))[0];
      t.expect(c && c.tout > 100, "the still got longer", c ? `tout=${c.tout}` : "no clip");
      t.expect(
        c && c.sin === null && c.sout === null,
        "and was given NO source window",
        c ? `sin=${c.sin} sout=${c.sout}` : "",
      );
    },
  },

  {
    area: "trim",
    name: "dragging the head moves the clip's start and leaves a gap",
    async run(t, d) {
      // At 40 rather than 0 so there is room to drag the head in BOTH directions.
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 40, len: 150 },
      ]);
      const g = await grab(t, d, "start");
      if (!g) return;
      await d.drag({ x: g.h.cx, y: g.h.cy }, { x: g.r.xOf(85), y: g.h.cy });
      const c = (await t.track("v1"))[0];
      t.expect(
        c && c.tin === 85,
        "the start moved to the pointer, leaving a gap (Premiere pins the media)",
        c ? `tin=${c.tin}` : "no clip",
      );
      t.expect(c && c.tout === 190, "the tail did NOT move", c ? `tout=${c.tout}` : "");
    },
  },

  {
    area: "trim",
    name: "the head cannot be pulled before source frame 0",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 90, len: 60 }]);
      const g = await grab(t, d, "start");
      if (!g) return;
      const before = (await t.track("v1"))[0];
      await d.drag({ x: g.h.cx, y: g.h.cy }, { x: g.r.xOf(20), y: g.h.cy });
      const c = (await t.track("v1"))[0];
      t.expect(
        c && c.sin !== null && c.sin >= 0,
        "source_in never goes negative",
        c ? `sin=${c.sin}` : "",
      );
      t.expect(
        c && c.tin >= before.tin - (before.sin ?? 0),
        "the head stopped at the start of the footage",
        c ? `tin=${c.tin} from ${before.tin}, sin was ${before.sin}` : "",
      );
    },
  },

  {
    area: "trim",
    name: "a clip cannot be trimmed away to nothing",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 40, len: 60 }]);
      const g = await grab(t, d, "end");
      if (!g) return;
      await d.drag({ x: g.h.cx, y: g.h.cy }, { x: g.r.xOf(41), y: g.h.cy });
      const c = (await t.track("v1"))[0];
      t.expect(
        c && c.tout - c.tin >= 1,
        "at least one frame survives",
        c ? `${c.tout - c.tin}` : "gone",
      );
    },
  },

  {
    area: "trim",
    name: "a trim carries the linked audio with it",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 150 }]);
      if (!(await t.track("a1")).length)
        return t.expect(false, "a linked audio clip on a1", "none");
      const g = await grab(t, d, "end");
      if (!g) return;
      await d.drag({ x: g.h.cx, y: g.h.cy }, { x: g.r.xOf(80), y: g.h.cy });
      const v = (await t.track("v1"))[0];
      const a = (await t.track("a1"))[0];
      t.expect(
        v && a && a.tout === v.tout,
        "the audio ends where the picture does (A/V must not desync)",
        v && a ? `video ${v.tout}, audio ${a.tout}` : "",
      );
    },
  },

  {
    area: "trim",
    name: "a trim is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 150 }]);
      const g = await grab(t, d, "end");
      if (!g) return;
      await t.assertOneUndo(
        () => d.drag({ x: g.h.cx, y: g.h.cy }, { x: g.r.xOf(100), y: g.h.cy }),
        "trim the tail",
      );
    },
  },

  {
    area: "trim",
    name: "grabbing a trim handle without moving writes nothing",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 150 }]);
      const g = await grab(t, d, "end");
      if (!g) return;
      await t.assertNoOp(() => d.pressRelease({ x: g.h.cx, y: g.h.cy }), "press the tail handle");
    },
  },
];
