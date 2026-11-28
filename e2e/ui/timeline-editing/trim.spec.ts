// Trimming by hand: the edge handles, the rails at the ends of the footage, a picture that has no end,
// Shift for a ripple trim, and Q/W to the playhead. The rule each test holds is the one the saved
// clip must keep: a clip never asks for footage its file does not have, and the frames it plays move
// with the edge that was dragged.
import { onShippedEngineOnly, expect, onTrack, spans, test, timelineWait } from "./lib/timeline";

test.describe("timeline: trimming clips", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("drag the end handle left: the clip is shorter and plays less footage; one Undo puts it back", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 20 }]);
    const [clip] = onTrack(before, "v1");
    expect([clip.timeline_in, clip.timeline_out, clip.source_in, clip.source_out]).toEqual([
      20, 80, 0, 60,
    ]);

    const wait = timelineWait("trim a clip's end to its saved length");
    await tl.trimEdge(clip.id, "end", 60);
    const after = await tl.changed(before);
    wait.stop();
    const [t] = onTrack(after, "v1");
    expect([t.timeline_in, t.timeline_out, t.source_in, t.source_out]).toEqual([20, 60, 0, 40]);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the full clip");
  });

  test("the end handle stops at the last frame of the footage, however far it is dragged", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 30 }]);
    const [clip] = onTrack(before, "v1");

    await tl.trimEdge(clip.id, "end", 110);
    const after = await tl.changed(before);
    const [t] = onTrack(after, "v1");
    // bars_2s.mp4 is 60 frames long at 30 fps: the clip can show all of it and not one frame more.
    expect([t.timeline_in, t.timeline_out, t.source_in, t.source_out]).toEqual([0, 60, 0, 60]);
  });

  test("drag the start handle right: the clip starts later on the same footage and leaves a gap before it", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 20 }]);
    const [clip] = onTrack(before, "v1");

    await tl.trimEdge(clip.id, "start", 35);
    const after = await tl.changed(before);
    const [t] = onTrack(after, "v1");
    // The frames from 35 on are the frames that were there before: the start moved, the picture did not.
    expect([t.timeline_in, t.timeline_out, t.source_in, t.source_out]).toEqual([35, 80, 15, 60]);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the start");
  });

  test("the start handle stops at the first frame of the footage", async ({ tl }) => {
    await tl.start(["bars_2s.mp4"]);
    const placed = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 20 }]);
    const [clip] = onTrack(placed, "v1");
    await tl.trimEdge(clip.id, "start", 40);
    const trimmed = await tl.saved((d) => onTrack(d, "v1")[0]?.timeline_in === 40, "trimmed in");

    // Pulled back past where the footage begins (frame 20 on the timeline): it stops there.
    await tl.trimEdge(clip.id, "start", 4);
    const after = await tl.changed(trimmed);
    const [t] = onTrack(after, "v1");
    expect([t.timeline_in, t.timeline_out, t.source_in, t.source_out]).toEqual([20, 80, 0, 60]);
  });

  test("a picture has no end: its end handle stretches it as far as it is dragged", async ({
    tl,
  }) => {
    await tl.start(["card.png"]);
    const before = await tl.seed([{ media: "card.png", track: "v1", at: 0, len: 30 }]);
    const [clip] = onTrack(before, "v1");

    await tl.trimEdge(clip.id, "end", 150);
    const after = await tl.changed(before);
    const [t] = onTrack(after, "v1");
    expect([t.timeline_in, t.timeline_out]).toEqual([0, 150]);
  });

  test("Shift+drag on an end handle is a ripple trim: the clips after it move by the same amount", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 60 },
      { media: "bars_2s.mp4", track: "v1", at: 60, len: 40 },
    ]);
    const [first, second] = onTrack(before, "v1");

    await tl.trimEdge(first.id, "end", 40, ["Shift"]);
    const after = await tl.changed(before);
    expect(spans(after, "v1")).toEqual([
      [0, 40],
      [40, 80],
    ]);
    const [a, b] = onTrack(after, "v1");
    expect([a.id, a.source_out]).toEqual([first.id, 40]);
    // The clip that moved plays exactly what it played before.
    expect([b.id, b.source_in, b.source_out]).toEqual([
      second.id,
      second.source_in,
      second.source_out,
    ]);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores both clips");
  });

  test("Q trims the selected clip's start to the playhead, W its end; each is one Undo", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 10 }]);
    const [clip] = onTrack(before, "v1");
    await tl.clickClip(clip.id);
    await expect.poll(async () => (await tl.ui()).selection).toBe(clip.id);

    await tl.setPlayheadFrame(30);
    await tl.press("q");
    const headDone = await tl.changed(before, "Q trims the start");
    const [h] = onTrack(headDone, "v1");
    expect([h.timeline_in, h.timeline_out, h.source_in, h.source_out]).toEqual([30, 70, 20, 60]);

    await tl.setPlayheadFrame(50);
    await tl.press("w");
    const tailDone = await tl.changed(headDone, "W trims the end");
    const [w] = onTrack(tailDone, "v1");
    expect([w.timeline_in, w.timeline_out, w.source_in, w.source_out]).toEqual([30, 50, 20, 40]);

    await tl.press("Mod+z");
    await tl.savedAs(headDone, "one Undo takes back W only");
    await tl.press("Mod+z");
    await tl.savedAs(before, "a second takes back Q");
  });
});
