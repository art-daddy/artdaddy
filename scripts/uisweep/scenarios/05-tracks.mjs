// Tracks: the toggles a user reaches for constantly, and the reorder that is known to
// cost more than one undo.
import { resetTimeline } from "../lib/setup.mjs";

/** Track rows keyed by their delete button's aria-label, which names the lane. */
function trackRows(d) {
  return d.eval(
    `(() => [...document.querySelectorAll('[aria-label^="delete "]')].map(b => {
        const row = b.closest('div').parentElement;
        const r = row.getBoundingClientRect();
        return { label: b.getAttribute('aria-label').replace('delete ', ''),
                 x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + 30, cy: r.y + r.height/2 }; }))()`,
  );
}

function trackFlags(d, id) {
  return d.eval(
    `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
       const t = (tl?.tracks ?? []).find(t => String(t.id) === ${JSON.stringify(id)});
       return t ? { mute: !!t.mute, hidden: !!t.hidden, sync: t.sync_locked !== false, z: t.z } : null; })()`,
  );
}

export const scenarios = [
  {
    area: "tracks",
    name: "mute persists to the document and is one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 40, len: 60 }]);
      const btn = await d.eval(
        `(() => { const e = [...document.querySelectorAll('button')]
            .find(x => /^mute /i.test(x.getAttribute('aria-label') ?? ''));
          if (!e) return null; const r = e.getBoundingClientRect();
          return { label: e.getAttribute('aria-label'), cx: r.x + r.width/2, cy: r.y + r.height/2 }; })()`,
      );
      if (!btn) return t.expect(false, "a mute control on an audio track");
      await t.assertOneUndo(() => d.clickAtPoint(btn.cx, btn.cy), `toggle ${btn.label}`);
    },
  },

  {
    area: "tracks",
    name: "adding a track is one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, []);
      await t.assertOneUndo(() => d.clickText("+V", "button"), "add a video track");
    },
  },

  {
    area: "tracks",
    name: "reordering tracks is one undo",
    async run(t, d) {
      // Known defect (IDEA-CLIENT-UNDO-001): the drag issues one set_track per affected
      // track, so it costs N entries. Kept as a failing scenario until Phase 3.
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
        { media: "bars3s.mp4", track: "v2", at: 0, len: 60 },
      ]);
      const rows = await trackRows(d);
      if ((rows?.length ?? 0) < 2)
        return t.expect(false, "at least two track rows", JSON.stringify(rows));
      await t.assertOneUndo(
        () => d.drag({ x: rows[0].cx, y: rows[0].cy }, { x: rows[1].cx, y: rows[1].cy + 8 }),
        "reorder tracks",
      );
    },
  },

  {
    area: "tracks",
    name: "a track reorder actually restacks the compositing order",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
        { media: "bars3s.mp4", track: "v2", at: 0, len: 60 },
      ]);
      const before = { v1: (await trackFlags(d, "v1")).z, v2: (await trackFlags(d, "v2")).z };
      const rows = await trackRows(d);
      if ((rows?.length ?? 0) < 2) return t.expect(false, "two track rows");
      await d.drag({ x: rows[0].cx, y: rows[0].cy }, { x: rows[1].cx, y: rows[1].cy + 8 });
      const after = { v1: (await trackFlags(d, "v1")).z, v2: (await trackFlags(d, "v2")).z };
      t.expect(
        after.v1 !== before.v1 || after.v2 !== before.v2,
        "z changed, so the drag really restacked (not just moved a row visually)",
        `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
      );
    },
  },
];
