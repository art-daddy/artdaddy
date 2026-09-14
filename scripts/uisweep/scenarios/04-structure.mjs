// Structural edits: split, delete, ripple delete, duplicate, paste. Each asserts the
// resulting SPANS, because "the tool returned ok" has never been evidence of anything.
import { resetTimeline, ruler } from "../lib/setup.mjs";

export const scenarios = [
  {
    area: "structure",
    name: "Ctrl+K splits at the playhead into two clips that tile the original",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }]);
      const els = await d.clipEls();
      if (!els.length) return t.expect(false, "a clip to split");
      await d.clickAtPoint(els[0].cx, els[0].cy); // select it
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${40 / 30})`);
      await d.key("Ctrl+k");
      const spans = await t.spansOf("v1");
      t.eq(
        spans,
        [
          [0, 40],
          [40, 120],
        ],
        "two clips, abutting, covering the original exactly",
      );
    },
  },

  {
    area: "structure",
    name: "the razor tool cuts where you CLICK, not at the playhead",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }]);
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(0)`);
      const r = await ruler(d, t, "v1");
      const els = await d.clipEls();
      if (!r || !els.length) return t.expect(false, "a calibrated clip to cut");
      await d.key("c");
      await d.clickAtPoint(r.xOf(60), els[0].cy);
      await d.key("v"); // back to the pointer tool for the next scenario
      const spans = await t.spansOf("v1");
      t.expect(spans.length === 2, "the clip was cut in two", JSON.stringify(spans));
      t.expect(
        spans.length === 2 && Math.abs(spans[0][1] - 60) <= 2,
        "the cut is at the CLICK, not at the playhead (0)",
        JSON.stringify(spans),
      );
    },
  },

  {
    area: "structure",
    name: "delete leaves a gap; the neighbours do not move",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 50 },
        { media: "bars3s.mp4", track: "v1", at: 50, len: 50 },
      ]);
      const els = await d.clipEls();
      if (els.length < 2) return t.expect(false, "two clips", `${els.length}`);
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await d.key("Delete");
      const spans = await t.spansOf("v1");
      t.eq(spans, [[50, 100]], "the survivor stayed put — delete lifts, it does not ripple");
    },
  },

  {
    area: "structure",
    name: "ripple delete closes the gap",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 50 },
        { media: "bars3s.mp4", track: "v1", at: 50, len: 50 },
      ]);
      const els = await d.clipEls();
      if (els.length < 2) return t.expect(false, "two clips", `${els.length}`);
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await d.key("Shift+Delete");
      const spans = await t.spansOf("v1");
      t.eq(spans, [[0, 50]], "the later clip slid back to close the gap");
    },
  },

  {
    area: "structure",
    name: "a split is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }]);
      const els = await d.clipEls();
      if (!els.length) return t.expect(false, "a clip to split");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${40 / 30})`);
      await t.assertOneUndo(() => d.key("Ctrl+k"), "split at the playhead");
    },
  },

  {
    area: "structure",
    name: "a delete is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const els = await d.clipEls();
      if (!els.length) return t.expect(false, "a clip to delete");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await t.assertOneUndo(() => d.key("Delete"), "delete a clip");
    },
  },

  {
    area: "structure",
    name: "copy then paste puts a second clip on the timeline, as one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const els = await d.clipEls();
      if (!els.length) return t.expect(false, "a clip to copy");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await d.key("Control+c");
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${100 / 30})`);
      await t.assertOneUndo(() => d.key("Control+v"), "paste a clip");
    },
  },
];
