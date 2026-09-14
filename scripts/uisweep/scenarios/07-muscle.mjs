// Phase 5 — the muscle-memory edits: nudge, trim-to-playhead, cut, select-forward.
//
// Written BEFORE the implementation, per docs/MANUAL_EDITING_PARITY.md §7: a scenario that is
// written afterwards tends to describe what the code happens to do.
import { resetTimeline } from "../lib/setup.mjs";

/** Select the clip at index `i` on a lane and return its rect. */
async function selectClip(d, track, i = 0) {
  const els = await d.clipsOn(track);
  const el = els[i];
  if (!el) return null;
  await d.clickAtPoint(el.cx, el.cy);
  return el;
}

export const scenarios = [
  {
    area: "muscle",
    name: "Alt+arrow nudges the selected clip by ONE frame",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 40, len: 60 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to nudge");
      await d.key("Alt+ArrowRight");
      t.eq((await t.spansOf("v1"))[0], [41, 101], "one frame right");
      await d.key("Alt+ArrowLeft");
      await d.key("Alt+ArrowLeft");
      t.eq((await t.spansOf("v1"))[0], [39, 99], "and back one frame past where it started");
    },
  },

  {
    area: "muscle",
    name: "Shift+Alt+arrow nudges by FIVE",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 40, len: 60 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to nudge");
      await d.key("Shift+Alt+ArrowRight");
      t.eq((await t.spansOf("v1"))[0], [45, 105], "five frames right, not one");
    },
  },

  {
    area: "muscle",
    name: "a nudge STOPS at frame 0 rather than going negative",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 2, len: 60 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to nudge");
      // A 5-frame nudge from frame 2 must land ON the rail, not stop short and not go negative.
      // Asserting only ">= 0" would pass while nudge does nothing at all.
      await d.key("Shift+Alt+ArrowLeft");
      t.eq((await t.spansOf("v1"))[0], [0, 60], "clamped to the rail, keeping its 60-frame length");
    },
  },

  {
    area: "muscle",
    name: "a nudge is exactly one undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 40, len: 60 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to nudge");
      await t.assertOneUndo(() => d.key("Alt+ArrowRight"), "nudge a clip");
    },
  },

  {
    area: "muscle",
    name: "Q trims the clip's HEAD to the playhead and leaves a gap",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 80 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to trim");
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${50 / 30})`);
      await d.key("q");
      const span = (await t.spansOf("v1"))[0];
      t.eq(span, [50, 100], "the head moved to the playhead; the tail did not move");
    },
  },

  {
    area: "muscle",
    name: "W trims the clip's TAIL to the playhead",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 80 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to trim");
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${70 / 30})`);
      await d.key("w");
      const span = (await t.spansOf("v1"))[0];
      t.eq(span, [20, 70], "the tail moved to the playhead; the head did not move");
    },
  },

  {
    area: "muscle",
    name: "trim-to-playhead REFUSES when the playhead is outside the clip",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 20, len: 80 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to trim");
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${200 / 30})`);
      // Outside the clip there is no meaningful trim — it must do NOTHING, not collapse the clip.
      await t.assertNoOp(() => d.key("q"), "Q with the playhead past the clip");
    },
  },

  {
    area: "muscle",
    name: "Ctrl+X removes the clip, and ONE Ctrl+Z brings it back",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 40, len: 60 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to cut");
      // Cut is copy + remove. Two operations, ONE intent — so it must cost one undo, which is the
      // whole reason the transaction primitive exists.
      await t.assertOneUndo(() => d.key("Control+x"), "cut a clip");
    },
  },

  {
    area: "muscle",
    name: "what Ctrl+X took, Ctrl+V puts back",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 40, len: 60 }]);
      if (!(await selectClip(d, "v1"))) return t.expect(false, "a clip to cut");
      await d.key("Control+x");
      t.eq(await t.spansOf("v1"), [], "the lane is empty after the cut");
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${10 / 30})`);
      await d.key("Control+v");
      const spans = await t.spansOf("v1");
      t.expect(spans.length === 1, "the clip came back", JSON.stringify(spans));
      t.expect(
        spans.length === 1 && spans[0][1] - spans[0][0] === 60,
        "and it is the same LENGTH it was cut at",
        JSON.stringify(spans),
      );
    },
  },

  {
    area: "muscle",
    name: "Shift+arrow steps the playhead FIVE frames, not one",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(0)`);
      await d.key("ArrowRight");
      const one = Math.round((await t.ui()).playhead * 30);
      await d.key("Shift+ArrowRight");
      const five = Math.round((await t.ui()).playhead * 30);
      t.eq([one, five], [1, 6], "a plain step is 1 frame and a shifted step is 5");
    },
  },
];
