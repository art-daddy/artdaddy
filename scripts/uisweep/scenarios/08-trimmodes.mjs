// Phase 6 — the four trim modes that separate an NLE from a clip arranger.
//
// Scenarios FIRST. Each asserts the property that DEFINES the mode, not the arithmetic:
//
//   ripple trim  the edge moves AND everything after it shifts by the same amount
//   roll         the shared cut moves; total length is unchanged
//   slip         the source window moves; the timeline footprint is unchanged
//   slide        the clip moves; its neighbours absorb it; total length is unchanged
//
// Those invariants survive a rewrite; "timeline_out === 47" would not.
import { resetTimeline, ruler } from "../lib/setup.mjs";

/** Total span of a track, ignoring gaps: first start -> last end. */
const extent = (spans) => (spans.length ? [spans[0][0], spans[spans.length - 1][1]] : null);

export const scenarios = [
  {
    area: "trimmodes",
    name: "ripple trim: shortening a clip's tail pulls every later clip back by the same amount",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
        { media: "bars3s.mp4", track: "v1", at: 60, len: 60 },
      ]);
      const before = await t.spansOf("v1");
      const g = await ruler(d, t, "v1");
      const h = await d.handleOn("v1", 0, "end");
      if (!g || !h) return t.expect(false, "a calibrated tail handle");
      // Shift+drag = ripple. Pull the first clip's tail from 60 back to 40.
      await d.drag({ x: h.cx, y: h.cy }, { x: g.xOf(40), y: h.cy }, { modifiers: "Shift" });
      const after = await t.spansOf("v1");
      t.expect(after.length === 2, "both clips survive", JSON.stringify(after));
      if (after.length !== 2) return;
      t.eq(after[0], [0, 40], "the dragged edge moved to the pointer");
      // THE ripple property: the neighbour closed up by exactly what was removed, no gap.
      t.eq(after[1], [40, 100], "the later clip followed by the same 20 frames");
      t.expect(
        extent(after)[1] === extent(before)[1] - 20,
        "the sequence got shorter by exactly the trimmed amount",
        `${JSON.stringify(extent(before))} -> ${JSON.stringify(extent(after))}`,
      );
    },
  },

  {
    area: "trimmodes",
    name: "ripple trim leaves NO gap where a plain trim would",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
        { media: "bars3s.mp4", track: "v1", at: 60, len: 60 },
      ]);
      const g = await ruler(d, t, "v1");
      const h = await d.handleOn("v1", 0, "end");
      if (!g || !h) return t.expect(false, "a calibrated tail handle");
      await d.drag({ x: h.cx, y: h.cy }, { x: g.xOf(40), y: h.cy }, { modifiers: "Shift" });
      const after = await t.spansOf("v1");
      if (after.length !== 2) return t.expect(false, "two clips", JSON.stringify(after));
      t.expect(after[0][1] === after[1][0], "the clips still abut", JSON.stringify(after));
    },
  },

  {
    area: "trimmodes",
    name: "ripple trim is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
        { media: "bars3s.mp4", track: "v1", at: 60, len: 60 },
      ]);
      const g = await ruler(d, t, "v1");
      const h = await d.handleOn("v1", 0, "end");
      if (!g || !h) return t.expect(false, "a calibrated tail handle");
      await t.assertOneUndo(
        () => d.drag({ x: h.cx, y: h.cy }, { x: g.xOf(40), y: h.cy }, { modifiers: "Shift" }),
        "ripple trim",
      );
    },
  },

  {
    area: "trimmodes",
    name: "roll: dragging the CUT between two clips moves it, and the total length is unchanged",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
        { media: "bars3s.mp4", track: "v1", at: 60, len: 60 },
      ]);
      const before = await t.spansOf("v1");
      const g = await ruler(d, t, "v1");
      const els = await d.clipsOn("v1");
      if (!g || els.length < 2) return t.expect(false, "two abutting clips");
      // The cut itself: the roll TOOL (N), then drag the seam. Roll RIGHT — the incoming clip
      // starts at source frame 0, so rolling left would need footage that does not exist.
      const seamX = g.xOf(60);
      await d.key("n");
      await d.drag({ x: seamX, y: els[0].cy }, { x: g.xOf(75), y: els[0].cy });
      await d.key("v");
      const after = await t.spansOf("v1");
      t.expect(after.length === 2, "both clips survive a roll", JSON.stringify(after));
      if (after.length !== 2) return;
      t.eq(after[0], [0, 75], "the outgoing clip took 15 more frames");
      t.eq(after[1], [75, 120], "the incoming clip gave up exactly those 15 frames");
      // THE roll property: nothing after the pair moved, so the sequence length is untouched.
      t.eq(extent(after), extent(before), "the total sequence length is unchanged");
    },
  },

  {
    area: "trimmodes",
    name: "slip: the source window moves but the clip does NOT",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 30, len: 60 }]);
      // Give the clip source headroom on both sides so a slip has somewhere to go.
      const c0 = (await t.track("v1"))[0];
      await d.eval(
        `window.__artdaddyTest.editor.getState().trimClip(${JSON.stringify(c0.id)},
           { source_in: 60, source_out: 120 }).then(() => 'ok')`,
      );
      const before = (await t.track("v1"))[0];
      const g = await ruler(d, t, "v1");
      const els = await d.clipsOn("v1");
      if (!g || !els.length) return t.expect(false, "a clip to slip");
      // The slip TOOL (Y): dragging the body moves the content under a fixed footprint.
      await d.key("y");
      await d.drag({ x: els[0].cx, y: els[0].cy }, { x: els[0].cx + g.px * 10, y: els[0].cy });
      await d.key("v");
      const after = (await t.track("v1"))[0];
      // THE slip property: the footprint is untouched...
      t.eq(
        [after.tin, after.tout],
        [before.tin, before.tout],
        "the clip did not move on the timeline",
      );
      // ...while the content under it did.
      t.expect(
        after.sin !== before.sin,
        "the source window moved",
        `sin ${before.sin} -> ${after.sin}`,
      );
      t.expect(
        after.sout - after.sin === before.sout - before.sin,
        "and it kept its length (a slip is not a trim)",
        `${before.sin}..${before.sout} -> ${after.sin}..${after.sout}`,
      );
    },
  },

  {
    area: "trimmodes",
    name: "slide: the clip moves between its neighbours and the total length is unchanged",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 40 },
        { media: "bars3s.mp4", track: "v1", at: 40, len: 40 },
        { media: "still.png", track: "v1", at: 80, len: 40 },
      ]);
      const before = await t.spansOf("v1");
      const g = await ruler(d, t, "v1");
      const els = await d.clipsOn("v1");
      if (!g || els.length < 3) return t.expect(false, "three abutting clips");
      // The slide TOOL (U): drag the MIDDLE clip; the neighbours absorb the move.
      await d.key("u");
      await d.drag({ x: els[1].cx, y: els[1].cy }, { x: els[1].cx + g.px * 10, y: els[1].cy });
      await d.key("v");
      const after = await t.spansOf("v1");
      t.expect(after.length === 3, "all three clips survive a slide", JSON.stringify(after));
      if (after.length !== 3) return;
      t.eq(after[1], [50, 90], "the middle clip moved 10 frames later");
      t.eq(after[0], [0, 50], "the left neighbour grew to absorb it");
      t.eq(after[2], [90, 120], "the right neighbour shrank by the same amount");
      t.eq(extent(after), extent(before), "the total sequence length is unchanged");
    },
  },
];
