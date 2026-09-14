// Phase 5, slice 2 — track lock, solo, and select-forward.
//
// Lock is the interesting one: "blocks ALL edits on that track" is a CLASS invariant, so these
// scenarios deliberately probe several different edit kinds. A lock enforced per-tool would pass
// one of these and fail the next.
import { resetTimeline, ruler } from "../lib/setup.mjs";

const lockBtn = (label) =>
  `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)})`;

/** Click a track-header toggle by its aria-label. */
async function toggle(d, label) {
  const r = await d.eval(
    `(() => { const e = ${lockBtn(label)}; if (!e) return null;
       const r = e.getBoundingClientRect();
       return { cx: r.x + r.width/2, cy: r.y + r.height/2 }; })()`,
  );
  if (!r) return false;
  await d.clickAtPoint(r.cx, r.cy);
  return true;
}

export const scenarios = [
  {
    area: "lock",
    name: "a locked track refuses a MOVE",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 60 }]);
      if (!(await toggle(d, "lock v1"))) return t.expect(false, "a lock control on v1");
      const before = await t.spansOf("v1");
      const els = await d.clipsOn("v1");
      const g = await ruler(d, t, "v1");
      if (!els.length || !g) return t.expect(false, "a clip to drag");
      await d.drag({ x: els[0].cx, y: els[0].cy }, { x: els[0].cx + g.px * 30, y: els[0].cy });
      t.eq(await t.spansOf("v1"), before, "the clip did not move");
      await toggle(d, "lock v1");
    },
  },

  {
    area: "lock",
    name: "a locked track refuses a TRIM",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 60 }]);
      if (!(await toggle(d, "lock v1"))) return t.expect(false, "a lock control on v1");
      const before = await t.spansOf("v1");
      const g = await ruler(d, t, "v1");
      const h = await d.handleOn("v1", 0, "end");
      if (!g || !h) return t.expect(false, "a trim handle");
      await d.drag({ x: h.cx, y: h.cy }, { x: g.xOf(50), y: h.cy });
      t.eq(await t.spansOf("v1"), before, "the edge did not move");
      await toggle(d, "lock v1");
    },
  },

  {
    area: "lock",
    name: "a locked track refuses a DELETE",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 60 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip to delete");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      if (!(await toggle(d, "lock v1"))) return t.expect(false, "a lock control on v1");
      const before = await t.spansOf("v1");
      await d.key("Delete");
      t.eq(await t.spansOf("v1"), before, "the clip survived");
      await toggle(d, "lock v1");
    },
  },

  {
    area: "lock",
    name: "an UNLOCKED track still edits — the guard is not just refusing everything",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 60 }]);
      const els = await d.clipsOn("v1");
      const g = await ruler(d, t, "v1");
      if (!els.length || !g) return t.expect(false, "a clip to drag");
      await d.drag({ x: els[0].cx, y: els[0].cy }, { x: els[0].cx + g.px * 30, y: els[0].cy });
      const after = await t.spansOf("v1");
      t.expect(after[0] && after[0][0] !== 20, "the clip moved", JSON.stringify(after));
    },
  },

  {
    area: "lock",
    name: "locking persists to the document and is one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await t.assertOneUndo(() => toggle(d, "lock v1"), "lock a track");
    },
  },

  {
    area: "lock",
    name: "solo persists to the document and is one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await t.assertOneUndo(() => toggle(d, "solo v1"), "solo a track");
    },
  },

  {
    area: "selection",
    name: "A selects every clip at or after the click, on that track only",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 0, len: 40 },
        { media: "bars3s.mp4", track: "v1", at: 40, len: 40 },
        { media: "still.png", track: "v1", at: 80, len: 40 },
        { media: "bars3s.mp4", track: "v2", at: 40, len: 40 },
      ]);
      const els = await d.clipsOn("v1");
      if (els.length < 3) return t.expect(false, "three clips on v1", `${els.length}`);
      // Track-select-forward: click the MIDDLE clip, press A -> it and everything after it.
      await d.clickAtPoint(els[1].cx, els[1].cy);
      await d.key("a");
      const ui = await t.ui();
      const picked = await d.eval(
        `(() => { const s = window.__artdaddyTest.editor.getState();
           const tl = s.timeline; const ids = new Set(s.selectedIds ?? []);
           const on = id => (tl?.tracks ?? []).find(t => (t.clips ?? []).some(c => String(c.id) === id))?.id;
           return (s.selectedIds ?? []).map(id => [String(on(id)), id]); })()`,
      );
      const v1 = picked.filter(([tr]) => tr === "v1").length;
      const v2 = picked.filter(([tr]) => tr === "v2").length;
      t.eq([v1, v2], [2, 0], "the clicked clip and the one after it, and nothing on another track");
      void ui;
    },
  },
];
