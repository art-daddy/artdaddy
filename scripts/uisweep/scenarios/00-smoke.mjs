// Harness self-proof.
//
// Phase 1's gate: these must PASS for the plumbing checks and FAIL for the two defects we
// already know about (track reorder and multi-file import each cost N undo entries). A
// harness that reports green on a known-broken case is worse than no harness.
import { placeFromLibrary } from "../lib/setup.mjs";

export const scenarios = [
  {
    area: "smoke",
    name: "a clip dragged from the library reaches the SAVED document",
    async run(t, d) {
      const before = await t.clips();
      await placeFromLibrary(d, t.projectId, "bars10s.mp4", "v1");
      const after = await t.clips();
      t.expect(
        Object.keys(after).length > Object.keys(before).length,
        "the drop added a clip to the persisted timeline",
        `before ${Object.keys(before).length}, after ${Object.keys(after).length}`,
      );
    },
  },

  {
    area: "smoke",
    name: "moving a clip is exactly one undo",
    async run(t, d) {
      const els = await d.clipEls();
      if (!els.length) return t.expect(false, "a clip is on the timeline to move");
      const el = els[0];
      await t.assertOneUndo(
        () => d.drag({ x: el.cx, y: el.cy }, { x: el.cx + 120, y: el.cy }),
        "move a clip",
      );
    },
  },

  {
    area: "smoke",
    name: "a press that never moves writes nothing",
    async run(t, d) {
      const els = await d.clipEls();
      if (!els.length) return t.expect(false, "a clip is on the timeline to press");
      await t.assertNoOp(() => d.pressRelease({ x: els[0].cx, y: els[0].cy }), "press a clip");
    },
  },

  {
    area: "smoke",
    name: "KNOWN BAD: reordering tracks is one undo",
    async run(t, d) {
      const labels = await d.eval(
        `(() => [...document.querySelectorAll('[aria-label^="delete "]')].map(b => {
            const row = b.closest('div').parentElement;
            const r = row.getBoundingClientRect();
            return { label: b.getAttribute('aria-label'), cx: r.x + 30, cy: r.y + r.height/2 }; }))()`,
      );
      if ((labels?.length ?? 0) < 2)
        return t.expect(false, "at least two track labels to reorder", JSON.stringify(labels));
      await t.assertOneUndo(
        () =>
          d.drag({ x: labels[0].cx, y: labels[0].cy }, { x: labels[1].cx, y: labels[1].cy + 8 }),
        "reorder tracks",
      );
    },
  },
];
