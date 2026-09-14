// Fade handles on the clip corners (Premiere: drag the knob, the ramp follows).
//
// `fade: { in, out }` already existed end to end — model, renderer, preview, Inspector, agent
// tool. What did not exist was any way to set it by hand, which is the gap this closes. So the
// assertions are about the GESTURE producing the right persisted frames, and about the rails:
// a fade cannot exceed its own clip, cannot go negative, cannot become a move, and a press
// that never moves writes nothing.
import { resetTimeline, ruler, setSnapping } from "../lib/setup.mjs";

const fadesOn = (d, track) =>
  d.eval(
    `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
       const t = (tl?.tracks ?? []).find(t => String(t.id) === ${JSON.stringify(track)});
       return (t?.clips ?? []).map(c => ({ tin: c.timeline_in, tout: c.timeline_out,
         fin: c.fade?.in ?? 0, fout: c.fade?.out ?? 0 })); })()`,
  );

/** The fade knob on the nth clip of a lane. */
const knob = (d, track, index, edge) =>
  d.eval(
    `(() => { const lane = document.querySelector('[data-track-id=${JSON.stringify(track)}]');
       if (!lane) return null;
       const clips = [...lane.querySelectorAll('[title]')]
         .filter(e => e.querySelector('[aria-label="trim end"]'))
         .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
       const c = clips[${Number(index)}]; if (!c) return null;
       const h = c.querySelector('[aria-label="fade ${edge}"]'); if (!h) return null;
       const r = h.getBoundingClientRect();
       return { cx: r.x + r.width/2, cy: r.y + r.height/2 }; })()`,
  );

const ONE = [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }];

export const scenarios = [
  {
    area: "fades",
    name: "dragging the head knob right sets a fade-IN of that many frames",
    async run(t, d) {
      await resetTimeline(d, t.projectId, ONE);
      await setSnapping(d, false);
      const r = await ruler(d, t, "v1");
      const k = await knob(d, "v1", 0, "in");
      if (!r || !k) return t.expect(false, "a fade-in knob on v1");
      await d.drag({ x: k.cx, y: k.cy }, { x: r.xOf(30), y: k.cy });
      const f = await fadesOn(d, "v1");
      t.eq([f[0]?.fin, f[0]?.fout], [30, 0], "fade.in follows the pointer; fade.out untouched");
      t.eq([f[0]?.tin, f[0]?.tout], [0, 120], "and the clip itself did not move or resize");
    },
  },

  {
    area: "fades",
    name: "dragging the tail knob left sets a fade-OUT",
    async run(t, d) {
      await resetTimeline(d, t.projectId, ONE);
      await setSnapping(d, false);
      const r = await ruler(d, t, "v1");
      const k = await knob(d, "v1", 0, "out");
      if (!r || !k) return t.expect(false, "a fade-out knob on v1");
      await d.drag({ x: k.cx, y: k.cy }, { x: r.xOf(90), y: k.cy });
      const f = await fadesOn(d, "v1");
      t.eq([f[0]?.fin, f[0]?.fout], [0, 30], "fade.out is measured back from the clip's end");
      t.eq([f[0]?.tin, f[0]?.tout], [0, 120], "and the clip itself did not move or resize");
    },
  },

  {
    area: "fades",
    name: "a fade cannot be longer than its own clip",
    async run(t, d) {
      // The rail. Dragging the head knob far past the tail must stop at the clip's length,
      // not write a fade the renderer would have to clamp behind the user's back.
      await resetTimeline(d, t.projectId, ONE);
      await setSnapping(d, false);
      const v = await d.viewport();
      const k = await knob(d, "v1", 0, "in");
      if (!k) return t.expect(false, "a fade-in knob on v1");
      await d.drag({ x: k.cx, y: k.cy }, { x: v.w - 8, y: k.cy });
      const f = await fadesOn(d, "v1");
      t.expect(f[0]?.fin === 120, "fade.in stopped at the clip's 120 frames", JSON.stringify(f));
    },
  },

  {
    area: "fades",
    name: "a fade cannot go negative",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 60, len: 120 },
      ]);
      await setSnapping(d, false);
      const k = await knob(d, "v1", 0, "in");
      if (!k) return t.expect(false, "a fade-in knob on v1");
      await d.drag({ x: k.cx, y: k.cy }, { x: k.cx - 300, y: k.cy });
      const f = await fadesOn(d, "v1");
      t.expect(f[0]?.fin === 0, "fade.in floored at 0", JSON.stringify(f));
      t.eq([f[0]?.tin, f[0]?.tout], [60, 180], "and dragging past the head did not move the clip");
    },
  },

  {
    area: "fades",
    name: "a fade drag is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, ONE);
      const r = await ruler(d, t, "v1");
      const k = await knob(d, "v1", 0, "in");
      if (!r || !k) return t.expect(false, "a fade-in knob on v1");
      await t.assertOneUndo(
        () => d.drag({ x: k.cx, y: k.cy }, { x: r.xOf(40), y: k.cy }),
        "drag a fade",
      );
    },
  },

  {
    area: "fades",
    name: "pressing a fade knob without moving writes nothing",
    async run(t, d) {
      // The same rule a bare click on a trim handle broke: a press is not an edit.
      await resetTimeline(d, t.projectId, ONE);
      const k = await knob(d, "v1", 0, "in");
      if (!k) return t.expect(false, "a fade-in knob on v1");
      await t.assertNoOp(() => d.pressRelease({ x: k.cx, y: k.cy }), "press the fade knob");
    },
  },

  {
    area: "fades",
    name: "the fade knob does not trim or move the clip it sits on",
    async run(t, d) {
      // The knob sits at the clip's corner, right on top of the trim handle's territory.
      // If it fell through, this would trim instead — silently, and only near the edges.
      await resetTimeline(d, t.projectId, ONE);
      await setSnapping(d, false);
      const r = await ruler(d, t, "v1");
      const k = await knob(d, "v1", 0, "in");
      if (!r || !k) return t.expect(false, "a fade-in knob on v1");
      await d.drag({ x: k.cx, y: k.cy }, { x: r.xOf(45), y: k.cy });
      t.eq(await t.spansOf("v1"), [[0, 120]], "the clip's span is untouched by a fade drag");
    },
  },

  {
    area: "fades",
    name: "a fade set on the picture reaches the linked AUDIO half",
    async run(t, d) {
      // fade is an audio-render property; on a video clip whose sound lives on a linked
      // partner, a fade that stopped at the picture would be inaudible — a silent no-op.
      await resetTimeline(d, t.projectId, ONE);
      await setSnapping(d, false);
      const r = await ruler(d, t, "v1");
      const k = await knob(d, "v1", 0, "in");
      if (!r || !k) return t.expect(false, "a fade-in knob on v1");
      const audio = await fadesOn(d, "a1");
      if (!audio.length) return t.expect(false, "a linked audio half on a1");
      await d.drag({ x: k.cx, y: k.cy }, { x: r.xOf(30), y: k.cy });
      const after = await fadesOn(d, "a1");
      t.expect(after[0]?.fin === 30, "the audio half faded too", JSON.stringify(after));
    },
  },
];
