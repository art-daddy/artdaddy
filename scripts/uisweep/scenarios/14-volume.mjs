// The volume rubber band on an audio clip: Cmd+click adds a key, dragging one moves it in 2D.
//
// The property this authors was inert until S13 — the exporter sent a curve to full level and the
// preview played its first key flat. So these assert the DOCUMENT the gesture writes, and the
// render/preview side is pinned separately (render.test.ts, audioEngine.test.ts). Splitting it
// that way is deliberate: it is the same split that let a hidden track keep exporting for months.
import { resetTimeline, ruler } from "../lib/setup.mjs";

const volOn = (d, track) =>
  d.eval(
    `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
       const t = (tl?.tracks ?? []).find(t => String(t.id) === ${JSON.stringify(track)});
       return (t?.clips ?? []).map(c => ({ tin: c.timeline_in, tout: c.timeline_out,
         vol: Array.isArray(c.volume) ? c.volume.map(k => [k.t, k.v]) : (c.volume ?? null) })); })()`,
  );

const band = (d, track) =>
  d.eval(
    `(() => { const lane = document.querySelector('[data-track-id=${JSON.stringify(track)}]');
       const e = lane?.querySelector('[data-testid="volume-band"]');
       if (!e) return null; const r = e.getBoundingClientRect();
       return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width/2, cy: r.y + r.height/2 }; })()`,
  );

const keys = (d, track) =>
  d.eval(
    `(() => { const lane = document.querySelector('[data-track-id=${JSON.stringify(track)}]');
       return [...(lane?.querySelectorAll('[aria-label="volume key"]') ?? [])].map(e => {
         const r = e.getBoundingClientRect();
         return { cx: r.x + r.width/2, cy: r.y + r.height/2,
                  t: Number(e.getAttribute('data-t')), v: Number(e.getAttribute('data-v')) }; }); })()`,
  );

const AUDIO = [{ media: "tone5s.m4a", track: "a1", at: 0, len: 120 }];

export const scenarios = [
  {
    area: "volume",
    name: "an audio clip draws a volume band",
    async run(t, d) {
      await resetTimeline(d, t.projectId, AUDIO);
      t.expect(!!(await band(d, "a1")), "the band is drawn on the audio clip");
    },
  },

  {
    area: "volume",
    name: "Cmd+click on the band adds a volume keyframe there",
    async run(t, d) {
      await resetTimeline(d, t.projectId, AUDIO);
      const r = await ruler(d, t, "a1");
      const b = await band(d, "a1");
      if (!r || !b) return t.expect(false, "a calibrated band on a1");
      await d.clickAtPoint(r.xOf(60), b.y + b.h / 2, "Control");
      const v = await volOn(d, "a1");
      t.expect(Array.isArray(v[0]?.vol), "volume became a curve", JSON.stringify(v));
      t.expect((v[0]?.vol ?? []).length >= 1, "with a key on it", JSON.stringify(v[0]?.vol));
    },
  },

  {
    area: "volume",
    name: "the key lands at the frame that was clicked",
    async run(t, d) {
      // A key that always landed at frame 0 would satisfy "a key exists" while being useless.
      await resetTimeline(d, t.projectId, AUDIO);
      const r = await ruler(d, t, "a1");
      const b = await band(d, "a1");
      if (!r || !b) return t.expect(false, "a calibrated band on a1");
      await d.clickAtPoint(r.xOf(60), b.y + b.h / 2, "Control");
      const v = (await volOn(d, "a1"))[0]?.vol ?? [];
      t.expect(
        v.some(([kt]) => Math.abs(kt - 60) <= 2),
        "a key sits at ~frame 60, not at the clip's start",
        JSON.stringify(v),
      );
    },
  },

  {
    area: "volume",
    name: "clicking LOW on the band makes a quieter key than clicking HIGH",
    async run(t, d) {
      // The vertical axis has to mean something. Two clicks at different heights must
      // produce different values, in the right order.
      await resetTimeline(d, t.projectId, AUDIO);
      const r = await ruler(d, t, "a1");
      const b = await band(d, "a1");
      if (!r || !b) return t.expect(false, "a calibrated band on a1");
      await d.clickAtPoint(r.xOf(30), b.y + b.h * 0.85, "Control"); // near the bottom
      await d.clickAtPoint(r.xOf(90), b.y + b.h * 0.15, "Control"); // near the top
      const v = (await volOn(d, "a1"))[0]?.vol ?? [];
      const low = v.find(([kt]) => Math.abs(kt - 30) <= 2);
      const high = v.find(([kt]) => Math.abs(kt - 90) <= 2);
      t.expect(!!low && !!high, "both keys landed", JSON.stringify(v));
      t.expect(
        !!low && !!high && low[1] < high[1],
        "the low click is quieter than the high one",
        JSON.stringify(v),
      );
    },
  },

  {
    area: "volume",
    name: "adding a key is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, AUDIO);
      const r = await ruler(d, t, "a1");
      const b = await band(d, "a1");
      if (!r || !b) return t.expect(false, "a calibrated band on a1");
      await t.assertOneUndo(
        () => d.clickAtPoint(r.xOf(60), b.y + b.h / 2, "Control"),
        "add a volume key",
      );
    },
  },

  {
    area: "volume",
    name: "dragging a key moves it in time AND level, as one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, AUDIO);
      const r = await ruler(d, t, "a1");
      const b = await band(d, "a1");
      if (!r || !b) return t.expect(false, "a calibrated band on a1");
      await d.clickAtPoint(r.xOf(30), b.y + b.h * 0.2, "Control");
      const before = await keys(d, "a1");
      if (!before.length) return t.expect(false, "a key to drag");
      await t.assertOneUndo(
        () => d.drag({ x: before[0].cx, y: before[0].cy }, { x: r.xOf(80), y: b.y + b.h * 0.8 }),
        "drag a volume key",
      );
      const v = (await volOn(d, "a1"))[0]?.vol ?? [];
      t.expect(
        v.length === 1,
        "still exactly one key — it moved, not multiplied",
        JSON.stringify(v),
      );
      t.expect(
        v[0] && Math.abs(v[0][0] - 80) <= 3 && v[0][1] < before[0].v,
        "it landed later and quieter",
        `${JSON.stringify(v)} from ${JSON.stringify(before[0])}`,
      );
    },
  },

  {
    area: "volume",
    name: "a key cannot be dragged outside its own clip",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "tone5s.m4a", track: "a1", at: 60, len: 120 }]);
      const r = await ruler(d, t, "a1");
      const b = await band(d, "a1");
      if (!r || !b) return t.expect(false, "a calibrated band on a1");
      await d.clickAtPoint(r.xOf(120), b.y + b.h / 2, "Control");
      const before = await keys(d, "a1");
      if (!before.length) return t.expect(false, "a key to drag");
      await d.drag(
        { x: before[0].cx, y: before[0].cy },
        { x: before[0].cx - 400, y: before[0].cy },
      );
      const v = (await volOn(d, "a1"))[0]?.vol ?? [];
      t.expect(
        v[0] && v[0][0] >= 0,
        "the key stayed inside the clip (clip-relative frames are never negative)",
        JSON.stringify(v),
      );
    },
  },

  {
    area: "volume",
    name: "Cmd+click on a VIDEO clip does NOT add a volume key",
    async run(t, d) {
      // The modifier cost, bounded. Cmd+click is additive select everywhere else; the band
      // only claims it on audio. If it leaked to video, multi-select would break silently.
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a video clip");
      await d.clickAtPoint(els[0].cx, els[0].cy, "Control");
      const v = await volOn(d, "v1");
      t.expect(
        v[0]?.vol === null || !Array.isArray(v[0]?.vol),
        "no curve on the video clip",
        JSON.stringify(v),
      );
    },
  },

  {
    area: "volume",
    name: "pressing a key without moving writes nothing",
    async run(t, d) {
      await resetTimeline(d, t.projectId, AUDIO);
      const r = await ruler(d, t, "a1");
      const b = await band(d, "a1");
      if (!r || !b) return t.expect(false, "a calibrated band on a1");
      await d.clickAtPoint(r.xOf(60), b.y + b.h / 2, "Control");
      const k = await keys(d, "a1");
      if (!k.length) return t.expect(false, "a key to press");
      await t.assertNoOp(() => d.pressRelease({ x: k[0].cx, y: k[0].cy }), "press a volume key");
    },
  },
];
