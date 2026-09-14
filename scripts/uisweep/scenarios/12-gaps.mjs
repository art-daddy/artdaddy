// Gap selection and ripple-delete-gap (Premiere: click the empty space, press Delete).
//
// The gap is stored as a POINT (track + frame) and resolved against the live timeline every
// time it is drawn or acted on, so an edit that moves the frames cannot leave a stale span
// pointing at material. These scenarios assert the resolved OUTCOME in the saved document,
// and the failure directions: trailing space is not a gap, selecting a clip drops the gap,
// and Delete on a gap must never remove a clip.
import { laneRect, resetTimeline, ruler } from "../lib/setup.mjs";

const gapEl = (d) =>
  d.eval(
    `(() => { const e = document.querySelector('[data-testid="gap-selection"]');
       if (!e) return null; const r = e.getBoundingClientRect();
       return { x: r.x, w: r.width, cx: r.x + r.width/2, cy: r.y + r.height/2,
                track: e.getAttribute('data-track-id'),
                start: Number(e.getAttribute('data-start')),
                end: Number(e.getAttribute('data-end')) }; })()`,
  );

/** Click the middle of the empty span [from, to) on `track`. */
async function clickGap(d, t, track, from, to) {
  const r = await ruler(d, t, track);
  const lane = await laneRect(d, track);
  if (!r || !lane) return false;
  await d.clickAtPoint((r.xOf(from) + r.xOf(to)) / 2, lane.cy);
  return true;
}

const TWO_WITH_GAP = [
  { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
  { media: "bars3s.mp4", track: "v1", at: 100, len: 60 },
];

export const scenarios = [
  {
    area: "gaps",
    name: "clicking the empty space between two clips selects THAT gap",
    async run(t, d) {
      await resetTimeline(d, t.projectId, TWO_WITH_GAP);
      if (!(await clickGap(d, t, "v1", 60, 100))) return t.expect(false, "a calibrated v1 lane");
      const g = await gapEl(d);
      t.expect(!!g, "a gap selection is drawn", JSON.stringify(g));
      if (g) t.eq([g.track, g.start, g.end], ["v1", 60, 100], "and it spans exactly the gap");
    },
  },

  {
    area: "gaps",
    name: "Delete closes the selected gap and pulls the later clip back",
    async run(t, d) {
      await resetTimeline(d, t.projectId, TWO_WITH_GAP);
      if (!(await clickGap(d, t, "v1", 60, 100))) return t.expect(false, "a calibrated v1 lane");
      await d.key("Delete");
      t.eq(
        await t.spansOf("v1"),
        [
          [0, 60],
          [60, 120],
        ],
        "the clips now abut — the 40-frame gap is gone and nothing was removed",
      );
    },
  },

  {
    area: "gaps",
    name: "closing a gap is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, TWO_WITH_GAP);
      if (!(await clickGap(d, t, "v1", 60, 100))) return t.expect(false, "a calibrated v1 lane");
      await t.assertOneUndo(() => d.key("Delete"), "close a gap");
    },
  },

  {
    area: "gaps",
    name: "the space AFTER the last clip is not a gap",
    async run(t, d) {
      // Failure direction: trailing space is unbounded, so "select the gap" there would either
      // select nothing or select to infinity. Premiere selects nothing; so do we.
      await resetTimeline(d, t.projectId, TWO_WITH_GAP);
      if (!(await clickGap(d, t, "v1", 170, 260))) return t.expect(false, "a calibrated v1 lane");
      t.expect(!(await gapEl(d)), "no gap is selected past the last clip");
    },
  },

  {
    area: "gaps",
    name: "the space BEFORE the first clip IS a gap",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 40, len: 60 }]);
      if (!(await clickGap(d, t, "v1", 0, 40))) return t.expect(false, "a calibrated v1 lane");
      const g = await gapEl(d);
      t.expect(!!g, "a gap selection is drawn at the head of the track", JSON.stringify(g));
      if (g) t.eq([g.start, g.end], [0, 40], "spanning frame 0 to the first clip");
      await d.key("Delete");
      t.eq(await t.spansOf("v1"), [[0, 60]], "and Delete pulls the clip to frame 0");
    },
  },

  {
    area: "gaps",
    name: "selecting a clip drops the gap selection — Delete has ONE target",
    async run(t, d) {
      await resetTimeline(d, t.projectId, TWO_WITH_GAP);
      if (!(await clickGap(d, t, "v1", 60, 100))) return t.expect(false, "a calibrated v1 lane");
      t.expect(!!(await gapEl(d)), "the gap is selected to begin with");
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip to select");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      t.expect(!(await gapEl(d)), "clicking a clip clears the gap");
      await d.key("Delete");
      const spans = await t.spansOf("v1");
      t.expect(
        spans.length === 1 && spans[0][0] === 100,
        "Delete removed the CLIP, not the gap",
        JSON.stringify(spans),
      );
    },
  },

  {
    area: "gaps",
    name: "Delete on a gap never removes a clip, even one that touches it",
    async run(t, d) {
      // The op behind this cuts a frame range; if the range leaked one frame into a
      // neighbour, that neighbour would be trimmed. Assert both lengths survive intact.
      await resetTimeline(d, t.projectId, TWO_WITH_GAP);
      if (!(await clickGap(d, t, "v1", 60, 100))) return t.expect(false, "a calibrated v1 lane");
      await d.key("Delete");
      const spans = await t.spansOf("v1");
      t.expect(spans.length === 2, "both clips are still there", JSON.stringify(spans));
      t.expect(
        spans.every(([a, b]) => b - a === 60),
        "and neither was trimmed by the cut",
        JSON.stringify(spans),
      );
    },
  },

  {
    area: "gaps",
    name: "Escape clears a gap selection",
    async run(t, d) {
      await resetTimeline(d, t.projectId, TWO_WITH_GAP);
      if (!(await clickGap(d, t, "v1", 60, 100))) return t.expect(false, "a calibrated v1 lane");
      await d.key("Escape");
      t.expect(!(await gapEl(d)), "the gap is deselected");
      await d.key("Delete");
      t.eq(
        await t.spansOf("v1"),
        [
          [0, 60],
          [100, 160],
        ],
        "and Delete with nothing selected writes nothing",
      );
    },
  },
];
