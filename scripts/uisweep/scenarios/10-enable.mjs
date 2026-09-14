// Phase 5, slice 3 — clip enable/disable (Premiere's Shift+E).
//
// The sweep proves the GESTURE persists; whether a disabled clip actually stops rendering is a
// render-plan question, asserted in renderPlan.resolve.test.ts. Splitting it that way is deliberate:
// the same split is what let a hidden track keep exporting for months.
import { resetTimeline } from "../lib/setup.mjs";

const flags = (d) =>
  d.eval(
    `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
       const t = (tl?.tracks ?? []).find(t => String(t.id) === 'v1');
       return (t?.clips ?? []).map(c => ({ tin: c.timeline_in, tout: c.timeline_out,
         disabled: c.disabled === true })); })()`,
  );

export const scenarios = [
  {
    area: "enable",
    name: "Shift+E disables a clip WITHOUT moving or removing it",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 60 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip to disable");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      const before = await t.spansOf("v1");
      await d.key("Shift+E");
      t.eq(await t.spansOf("v1"), before, "the clip is still there, same span");
      const f = await flags(d);
      t.expect(f[0]?.disabled === true, "and it is marked disabled", JSON.stringify(f));
    },
  },

  {
    area: "enable",
    name: "Shift+E again re-enables it",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 60 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip to toggle");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await d.key("Shift+E");
      await d.key("Shift+E");
      const f = await flags(d);
      t.expect(f[0]?.disabled === false, "back to enabled", JSON.stringify(f));
    },
  },

  {
    area: "enable",
    name: "toggling enable is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 60 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip to toggle");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await t.assertOneUndo(() => d.key("Shift+E"), "disable a clip");
    },
  },

  {
    area: "enable",
    name: "disabling carries the LINKED audio, so picture and sound cannot disagree",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 60 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip with linked audio");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await d.key("Shift+E");
      const all = await d.eval(
        `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
           return (tl?.tracks ?? []).flatMap(t => (t.clips ?? [])
             .map(c => [String(c.kind ?? ''), c.disabled === true])); })()`,
      );
      const on = all
        .filter(([, dis]) => dis)
        .map(([k]) => k)
        .sort();
      t.eq(on, ["audio", "video"], "both halves of the pair went dark together");
    },
  },
];
