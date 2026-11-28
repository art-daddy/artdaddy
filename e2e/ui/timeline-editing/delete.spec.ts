// Taking clips out: Delete leaves a gap, Shift+Delete and the menu's Ripple delete close it, a gap can
// be clicked and deleted, a video's sound goes with it, and a ripple carries the sync-locked tracks
// along while a released track stays put.
import { onShippedEngineOnly, expect, onTrack, spans, test, timelineWait } from "./lib/timeline";

test.describe("timeline: deleting and ripple delete", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("Delete removes the selected clip and leaves its space empty; one Undo brings it back", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
      { media: "bars_2s.mp4", track: "v1", at: 30, len: 30 },
      { media: "bars_2s.mp4", track: "v1", at: 60, len: 30 },
    ]);
    const middle = onTrack(before, "v1")[1];
    await tl.clickClip(middle.id);

    const wait = timelineWait("delete a clip to its saved removal");
    await tl.press("Delete");
    const after = await tl.changed(before);
    wait.stop();
    expect(spans(after, "v1")).toEqual([
      [0, 30],
      [60, 90],
    ]);
    await expect(tl.clip(middle.id)).toHaveCount(0);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the clip");
  });

  test("Shift+Delete removes the clip and closes the gap: the clips after it move left", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
      { media: "bars_2s.mp4", track: "v1", at: 30, len: 20 },
      { media: "bars_2s.mp4", track: "v1", at: 50, len: 30 },
    ]);
    const [first, middle, last] = onTrack(before, "v1");
    await tl.clickClip(middle.id);
    await tl.press("Shift+Delete");
    const after = await tl.changed(before);
    expect(onTrack(after, "v1").map((c) => [c.id, c.timeline_in, c.timeline_out])).toEqual([
      [first.id, 0, 30],
      [last.id, 30, 60],
    ]);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the clip and its place");
  });

  test("right-click > Ripple delete does the same as Shift+Delete", async ({ tl }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
      { media: "bars_2s.mp4", track: "v1", at: 30, len: 30 },
    ]);
    const [first, second] = onTrack(before, "v1");
    await tl.clipMenu(first.id, "Ripple delete");
    const after = await tl.changed(before);
    expect(onTrack(after, "v1").map((c) => [c.id, c.timeline_in, c.timeline_out])).toEqual([
      [second.id, 0, 30],
    ]);
  });

  test("click the empty space between two clips and press Delete: the gap closes and no clip is lost", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
      { media: "bars_2s.mp4", track: "v1", at: 70, len: 30 },
    ]);
    await tl.clickLane("v1", 50);
    const gap = tl.page.getByTestId("gap-selection");
    await expect(gap).toBeVisible();
    await expect(gap).toHaveAttribute("data-start", "30");
    await expect(gap).toHaveAttribute("data-end", "70");

    await tl.press("Delete");
    const after = await tl.changed(before);
    expect(spans(after, "v1")).toEqual([
      [0, 30],
      [30, 60],
    ]);
    await expect(gap).toHaveCount(0);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo reopens the gap");
  });

  test("the space after the last clip is not a gap: clicking it and pressing Delete changes nothing", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 30 }]);
    await tl.clickLane("v1", 80);
    await expect(tl.page.getByTestId("gap-selection")).toHaveCount(0);
    await tl.press("Delete");
    // Undo still reaches the last real edit (the trim in setup): Delete wrote nothing.
    await tl.press("Mod+z");
    const undone = await tl.changed(before, "Undo takes back the setup's trim");
    expect(spans(undone, "v1")).toEqual([[0, 60]]);
  });

  test("deleting a video with sound removes its sound too", async ({ tl }) => {
    await tl.start(["talk_2s.mp4"]);
    const before = await tl.seed([{ media: "talk_2s.mp4", track: "v1", at: 10 }]);
    const [video] = onTrack(before, "v1");
    expect(spans(before, "a1")).toEqual([[10, 70]]);
    await tl.clickClip(video.id);
    await tl.press("Delete");
    const after = await tl.changed(before);
    expect(spans(after, "v1")).toEqual([]);
    expect(spans(after, "a1")).toEqual([]);
  });

  test("a ripple delete moves the sync-locked tracks with it; a track released from sync lock stays put", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4", "tone_2s.m4a"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
      { media: "bars_2s.mp4", track: "v1", at: 30, len: 30 },
      { media: "tone_2s.m4a", track: "a1", at: 40, len: 20 },
    ]);
    const [first] = onTrack(before, "v1");

    await tl.clickClip(first.id);
    await tl.press("Shift+Delete");
    const locked = await tl.changed(before);
    expect(spans(locked, "v1")).toEqual([[0, 30]]);
    expect(spans(locked, "a1"), "a1 is sync-locked (the default), so it shifts too").toEqual([
      [10, 30],
    ]);
    await tl.press("Mod+z");
    await tl.savedAs(before, "Undo restores both tracks");

    const sync = await tl.trackButton("a1", "sync lock");
    await expect(sync).toHaveAttribute("aria-pressed", "true");
    await sync.click();
    await expect(sync).toHaveAttribute("aria-pressed", "false");
    const released = await tl.saved(
      (d) => (d.tracks ?? []).find((t) => t.id === "a1")?.sync_locked === false,
      "a1's sync lock released and saved",
    );
    await tl.clickClip(first.id);
    await tl.press("Shift+Delete");
    const after = await tl.changed(released);
    expect(spans(after, "v1")).toEqual([[0, 30]]);
    expect(spans(after, "a1"), "a released track keeps its place").toEqual([[40, 60]]);
  });
});
