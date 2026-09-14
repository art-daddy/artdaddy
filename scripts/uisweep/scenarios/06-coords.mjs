// Timeline coordinates: does a pixel mean the same frame to the drawing code and to the
// pointer code? Three separate failures (trim head, trim tail, razor) were all off by the
// SAME amount, which is the signature of one shared conversion being wrong rather than
// three gestures being wrong.
import { resetTimeline } from "../lib/setup.mjs";

export const scenarios = [
  {
    area: "coords",
    name: "the playhead lines up with a clip that starts on the same frame",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }]);
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(0)`);
      const m = await d.eval(
        `(() => {
           const lane = document.querySelector('[data-track-id="v1"]');
           const clip = lane && lane.querySelector('[title]');
           const head = [...document.querySelectorAll('div')]
             .find(e => /bg-red-400/.test(e.className ?? '') && e.clientHeight > 4);
           if (!clip || !head) return null;
           return { clipX: clip.getBoundingClientRect().x, headX: head.getBoundingClientRect().x }; })()`,
      );
      if (!m) return t.expect(false, "a clip and the playhead line are both on screen");
      t.expect(
        Math.abs(m.clipX - m.headX) <= 1,
        "a clip at frame 0 is drawn where the playhead at frame 0 is drawn",
        `clip x=${m.clipX.toFixed(1)}, playhead x=${m.headX.toFixed(1)}, off by ${(m.clipX - m.headX).toFixed(1)}px`,
      );
    },
  },

  {
    area: "coords",
    name: "clicking the ruler at a clip's edge puts the playhead on that frame",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 60, len: 120 },
      ]);
      const clip = await d.eval(
        `(() => { const e = document.querySelector('[data-track-id="v1"] [title]');
           if (!e) return null; const r = e.getBoundingClientRect();
           return { x: r.x, y: r.y }; })()`,
      );
      const ruler = await d.rect(`[aria-label="timeline scrubber"]`);
      if (!clip || !ruler) return t.expect(false, "a clip and the ruler");
      await d.clickAtPoint(clip.x, ruler.cy);
      const ui = await t.ui();
      const frame = Math.round(ui.playhead * 30);
      t.expect(
        Math.abs(frame - 60) <= 1,
        "the playhead landed on the frame the clip visibly starts at",
        `playhead frame ${frame}, clip starts at 60`,
      );
    },
  },

  {
    area: "coords",
    name: "clicking a clip's left edge with the razor cuts at its start, not 9 frames in",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }]);
      const clip = await d.eval(
        `(() => { const e = document.querySelector('[data-track-id="v1"] [title]');
           if (!e) return null; const r = e.getBoundingClientRect();
           return { midX: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      if (!clip) return t.expect(false, "a clip to cut");
      await d.key("c");
      await d.clickAtPoint(clip.midX, clip.y);
      await d.key("v");
      const spans = await t.spansOf("v1");
      t.expect(spans.length === 2, "the clip was cut", JSON.stringify(spans));
      t.expect(
        spans.length === 2 && Math.abs(spans[0][1] - 60) <= 1,
        "the cut is at the clip's visible MIDPOINT (frame 60)",
        JSON.stringify(spans),
      );
    },
  },
];
