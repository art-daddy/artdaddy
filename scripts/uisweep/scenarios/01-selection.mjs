// Selection is UI-only state, so these read the live store rather than the document —
// but selection DRIVES what every destructive gesture applies to, so it has to be right.
//
// Every lookup is scoped to a named lane. A global "clip index" silently drifts to another
// track the moment a scenario leaves a clip behind, and a point past the window edge is
// discarded by the app entirely — both of which look like a passing test.
import { laneRect, resetTimeline } from "../lib/setup.mjs";

/** A point inside the lane AND inside the window, to the right of everything on it. */
async function emptySpotOn(d, trackId) {
  const lane = await laneRect(d, trackId);
  const v = await d.viewport();
  if (!lane) return null;
  const clips = await d.clipsOn(trackId);
  const rightmost = clips.reduce((m, c) => Math.max(m, c.x + c.w), lane.x);
  const x = Math.min(rightmost + 40, lane.x + lane.w - 4, v.w - 8);
  return x > rightmost + 4 ? { x, y: lane.cy } : null;
}

export const scenarios = [
  {
    area: "selection",
    name: "clicking a clip selects it; clicking empty lane clears it",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const clips = await d.clipsOn("v1");
      if (!clips.length) return t.expect(false, "a clip on v1 to click");
      await d.clickAtPoint(clips[0].cx, clips[0].cy);
      let ui = await t.ui();
      t.expect(ui.selected.length >= 1, "the clip is selected", JSON.stringify(ui.selected));

      const spot = await emptySpotOn(d, "v2");
      if (!spot) return t.expect(false, "an empty, on-screen spot to click");
      await d.clickAtPoint(spot.x, spot.y);
      ui = await t.ui();
      t.expect(
        ui.selected.length === 0,
        "clicking empty space deselects",
        JSON.stringify(ui.selected),
      );
    },
  },

  {
    area: "selection",
    name: "Escape deselects",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const clips = await d.clipsOn("v1");
      if (!clips.length) return t.expect(false, "a clip on v1 to click");
      await d.clickAtPoint(clips[0].cx, clips[0].cy);
      await d.key("Escape");
      const ui = await t.ui();
      t.expect(
        ui.selected.length === 0,
        "Escape cleared the selection",
        JSON.stringify(ui.selected),
      );
    },
  },

  {
    area: "selection",
    name: "a marquee across two clips selects both",
    async run(t, d) {
      // Placed away from frame 0 so the sweep has empty lane to the left to start from.
      await resetTimeline(d, t.projectId, [
        { media: "bars10s.mp4", track: "v1", at: 30, len: 40 },
        { media: "bars3s.mp4", track: "v1", at: 80, len: 40 },
      ]);
      const clips = await d.clipsOn("v1");
      const lane = await laneRect(d, "v1");
      const v = await d.viewport();
      if (clips.length !== 2) return t.expect(false, "exactly two clips on v1", `${clips.length}`);
      const to = Math.min(clips[1].x + clips[1].w + 6, v.w - 8);
      if (to <= clips[1].x)
        return t.expect(false, "the second clip's end is on screen", `x=${clips[1].x} w=${v.w}`);
      await d.drag({ x: clips[0].x - 8, y: lane.y - 4 }, { x: to, y: lane.y + lane.h + 4 });
      const ui = await t.ui();
      t.expect(ui.selected.length >= 2, "both clips are selected", JSON.stringify(ui.selected));
    },
  },

  {
    area: "selection",
    name: "selecting a video clip also selects its linked audio",
    async run(t, d) {
      // bars10s carries a tone, so placement splits a linked audio clip onto a1.
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const audio = await t.track("a1");
      if (!audio.length)
        return t.expect(false, "placement split a linked audio clip", "none on a1");
      const clips = await d.clipsOn("v1");
      await d.clickAtPoint(clips[0].cx, clips[0].cy);
      const ui = await t.ui();
      t.expect(
        ui.selected.length >= 2,
        "the A/V pair selects together (a timing edit must not desync them)",
        JSON.stringify(ui.selected),
      );
    },
  },

  {
    area: "selection",
    name: "selection alone never writes to the document",
    async run(t, d) {
      await resetTimeline(d, t.projectId, [{ media: "bars10s.mp4", track: "v1", at: 0, len: 60 }]);
      const clips = await d.clipsOn("v1");
      await t.assertNoOp(async () => {
        await d.clickAtPoint(clips[0].cx, clips[0].cy);
        await d.key("Escape");
      }, "select then deselect");
    },
  },
];
