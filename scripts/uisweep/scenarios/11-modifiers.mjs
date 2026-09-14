// Alt is the OVERRIDE key, and snapping is a MODE — the D9 addendum.
//
// Alt used to mean "no snap", which was our own invention: Premiere and other NLEs both reserve
// Alt/Option for "do the un-defaulted thing" (duplicate instead of move, one half of a linked
// pair instead of both, ignore the trim handle). Snapping moved to an S toggle, as in Premiere,
// and split moved off S to Ctrl+K.
//
// Each scenario asserts the OUTCOME in the persisted document, and each asserts the FAILURE
// direction too: the plain-drag control proves the override is doing something, not that the
// drag happened to land there anyway.
import { resetTimeline, ruler, setSnapping } from "../lib/setup.mjs";

/** Pixels per frame, calibrated from what is DRAWN against what is SAVED. */
async function scale(d, t, track) {
  const els = await d.clipsOn(track);
  const clips = await t.track(track);
  if (!els.length || !clips.length) return null;
  return els[0].w / (clips[0].tout - clips[0].tin);
}

const kindsOn = (d, track) =>
  d.eval(
    `(() => { const tl = window.__artdaddyTest.editor.getState().timeline;
       const t = (tl?.tracks ?? []).find(t => String(t.id) === ${JSON.stringify(track)});
       return (t?.clips ?? []).map(c => ({ id: String(c.id), tin: c.timeline_in,
         tout: c.timeline_out, lg: c.link_group ?? null })); })()`,
  );

export const scenarios = [
  {
    area: "modifiers",
    name: "Alt+drag DUPLICATES: the original stays and a copy lands at the pointer",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await setSnapping(d, false);
      const px = await scale(d, t, "v1");
      const els = await d.clipsOn("v1");
      if (!px || !els.length) return t.expect(false, "a calibrated clip on v1");
      await d.drag(
        { x: els[0].cx, y: els[0].cy },
        { x: els[0].cx + 120 * px, y: els[0].cy },
        {
          modifiers: "Alt",
        },
      );
      t.eq(
        await t.spansOf("v1"),
        [
          [0, 60],
          [120, 180],
        ],
        "the original is untouched at 0 and the copy is at 120",
      );
    },
  },

  {
    area: "modifiers",
    name: "a PLAIN drag still moves — the duplicate is the override, not the default",
    async run(t, d) {
      // The failure direction for the scenario above: without this, "duplicate" passing could
      // just mean the drag never happened and a second clip was there all along.
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await setSnapping(d, false);
      const px = await scale(d, t, "v1");
      const els = await d.clipsOn("v1");
      if (!px || !els.length) return t.expect(false, "a calibrated clip on v1");
      await d.drag({ x: els[0].cx, y: els[0].cy }, { x: els[0].cx + 120 * px, y: els[0].cy });
      t.eq(await t.spansOf("v1"), [[120, 180]], "one clip, moved — nothing was copied");
    },
  },

  {
    area: "modifiers",
    name: "an Alt+drag is exactly ONE undo",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip to duplicate");
      await t.assertOneUndo(
        () =>
          d.drag(
            { x: els[0].cx, y: els[0].cy },
            { x: els[0].cx + 140, y: els[0].cy },
            {
              modifiers: "Alt",
            },
          ),
        "Alt+drag duplicate",
      );
    },
  },

  {
    area: "modifiers",
    name: "Alt+drag on a LINKED clip leaves its audio half where it is",
    async run(t, d) {
      // bars10s carries a tone, so placing it puts a linked pair on v1 + a1.
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await setSnapping(d, false);
      const audioBefore = await t.spansOf("a1");
      if (!audioBefore.length) return t.expect(false, "a linked audio half on a1");
      const px = await scale(d, t, "v1");
      const els = await d.clipsOn("v1");
      if (!px || !els.length) return t.expect(false, "a calibrated clip on v1");
      await d.drag(
        { x: els[0].cx, y: els[0].cy },
        { x: els[0].cx + 120 * px, y: els[0].cy },
        {
          modifiers: "Alt",
        },
      );
      t.eq(await t.spansOf("a1"), audioBefore, "the audio half did not follow the override");
    },
  },

  {
    area: "modifiers",
    name: "a PLAIN drag DOES carry the linked audio — the link is the default",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await setSnapping(d, false);
      const audioBefore = await t.spansOf("a1");
      if (!audioBefore.length) return t.expect(false, "a linked audio half on a1");
      const px = await scale(d, t, "v1");
      const els = await d.clipsOn("v1");
      if (!px || !els.length) return t.expect(false, "a calibrated clip on v1");
      await d.drag({ x: els[0].cx, y: els[0].cy }, { x: els[0].cx + 120 * px, y: els[0].cy });
      const after = await t.spansOf("a1");
      t.expect(
        after.length === audioBefore.length && after[0][0] === audioBefore[0][0] + 120,
        "the audio half moved with the video",
        `${JSON.stringify(audioBefore)} -> ${JSON.stringify(after)}`,
      );
    },
  },

  {
    area: "modifiers",
    name: "Alt on a trim handle MOVES instead of trimming",
    async run(t, d) {
      // The whole point of suppressing the handle: an Alt+drag aimed near an edge must not
      // silently become a trim. The clip's LENGTH is the tell — a trim changes it, a
      // duplicate does not.
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await setSnapping(d, false);
      const r = await ruler(d, t, "v1");
      const h = await d.handleOn("v1", 0, "end");
      if (!r || !h) return t.expect(false, "a calibrated end handle on v1");
      await d.drag({ x: h.cx, y: h.cy }, { x: r.xOf(150), y: h.cy }, { modifiers: "Alt" });
      const spans = await t.spansOf("v1");
      t.expect(spans.length === 2, "a copy was made, not a trim", JSON.stringify(spans));
      t.expect(
        spans.every(([a, b]) => b - a === 60),
        "and every clip kept the original 60-frame length",
        JSON.stringify(spans),
      );
    },
  },

  {
    area: "modifiers",
    name: "the duplicate gets its own identity, not the original's",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      await setSnapping(d, false);
      const px = await scale(d, t, "v1");
      const els = await d.clipsOn("v1");
      if (!px || !els.length) return t.expect(false, "a calibrated clip on v1");
      const before = await kindsOn(d, "v1");
      await d.drag(
        { x: els[0].cx, y: els[0].cy },
        { x: els[0].cx + 120 * px, y: els[0].cy },
        {
          modifiers: "Alt",
        },
      );
      const after = await kindsOn(d, "v1");
      const copy = after.find((c) => !before.some((b) => b.id === c.id));
      t.expect(!!copy, "a genuinely new clip id exists", JSON.stringify(after.map((c) => c.id)));
      t.expect(
        !!copy && (copy.lg === null || copy.lg !== before[0]?.lg),
        "and it does not share the original's link group",
        `${before[0]?.lg} vs ${copy?.lg}`,
      );
    },
  },

  {
    area: "modifiers",
    name: "S toggles snapping, and the toolbar shows which mode you are in",
    async run(t, d) {
      await resetTimeline(d, t.projectId, []);
      const pressed = () =>
        d.eval(`document.querySelector('[aria-label="snapping"]')?.ariaPressed ?? null`);
      t.eq(await pressed(), "true", "snapping starts on");
      await d.key("s");
      t.eq(await pressed(), "false", "S turns it off");
      await d.key("s");
      t.eq(await pressed(), "true", "and S turns it back on");
    },
  },

  {
    area: "modifiers",
    name: "snapping ON pulls a drag to a neighbour's edge; OFF leaves it where dropped",
    async run(t, d) {
      // The mode has to CHANGE the outcome, or it is decorative. Two drags of the same
      // near-miss distance, one per mode, asserted to differ.
      const place = () =>
        resetTimeline(d, t.projectId, [
          { media: "bars10s.mp4", track: "v1", at: 0, len: 60 },
          { media: "bars3s.mp4", track: "v1", at: 200, len: 60 },
        ]);
      const nearMiss = async () => {
        const px = await scale(d, t, "v1");
        const els = await d.clipsOn("v1");
        if (!px || els.length < 2) return null;
        // Aim the second clip's head 2 frames short of the first clip's tail (frame 60):
        // inside the 8px snap radius, outside anything a rounding error explains.
        await d.drag({ x: els[1].cx, y: els[1].cy }, { x: els[1].cx - 142 * px, y: els[1].cy });
        return (await t.spansOf("v1")).map(([a]) => a);
      };

      await place();
      await setSnapping(d, false);
      const off = await nearMiss();
      await place();
      await setSnapping(d, true);
      const on = await nearMiss();
      if (!off || !on) return t.expect(false, "two calibrated clips on v1");
      t.expect(off.includes(58), "with snapping OFF it lands exactly where dropped", `${off}`);
      t.expect(on.includes(60), "with snapping ON it snaps to the neighbour's edge", `${on}`);
    },
  },

  {
    area: "modifiers",
    name: "Ctrl+K splits at the playhead now that S is taken",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip to split");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${40 / 30})`);
      await d.key("Ctrl+k");
      t.eq(
        await t.spansOf("v1"),
        [
          [0, 40],
          [40, 120],
        ],
        "split into two abutting clips",
      );
    },
  },

  {
    area: "modifiers",
    name: "S no longer splits — the old binding is gone, not shadowed",
    async run(t, d) {
      // If S still split, the toggle scenario above would pass while every user pressing S
      // cut their clip in half. Assert the OLD behaviour is absent.
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 120 }]);
      const els = await d.clipsOn("v1");
      if (!els.length) return t.expect(false, "a clip that must survive");
      await d.clickAtPoint(els[0].cx, els[0].cy);
      await d.eval(`window.__artdaddyTest.editor.getState().setPlayhead(${40 / 30})`);
      await d.key("s");
      t.eq(await t.spansOf("v1"), [[0, 120]], "the clip is intact");
      await d.key("s"); // leave the mode as we found it
    },
  },
];
