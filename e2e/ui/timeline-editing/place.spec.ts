// Placing media by hand: dragging a library tile onto a lane with the real mouse. The landing frame is
// shown while dragging (the ghost) and must be the frame the clip is saved at; a video with sound
// brings its sound; a release anywhere else places nothing.
import {
  onShippedEngineOnly,
  clipsOf,
  expect,
  knownBug,
  onTrack,
  spans,
  test,
  timelineWait,
  type TimelineRig,
} from "./lib/timeline";

const FIRST_DROP_BUG =
  "Undoing the first clip dropped into a new project takes two Undos: the first leaves the project at that clip's size (QA catch-up, qa-timeline, 28 Nov)";

/** Press on the library tile of `file`, carry it to `to`, and hand back before the release. */
async function carryTile(tl: TimelineRig, file: string, to: { x: number; y: number }) {
  const tile = tl.page.getByRole("button", { name: file }).first();
  const t = await tl.box(tile);
  const m = tl.page.mouse;
  await m.move(t.x + t.width / 2, t.y + t.height / 2);
  await m.down();
  await m.move(t.x + t.width / 2 + 30, t.y + t.height / 2 + 30, { steps: 4 });
  await m.move(to.x, to.y, { steps: 12 });
}

test.describe("timeline: placing from the library", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("drag a library tile onto a lane: the ghost shows the landing frame and the clip is saved there, whole", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    await carryTile(tl, "bars_2s.mp4", { x: await tl.xOf(40), y: await tl.laneY("v1") });
    // The ghost is drawn by its children (the dashed box and the landing edge); it says its frame.
    const ghost = tl.page.getByTestId("drop-ghost");
    await expect(ghost).toHaveCount(1);
    await expect(ghost).toHaveAttribute("data-frame", "40");

    const wait = timelineWait("drop from the library to a saved clip on the lane");
    await tl.page.mouse.up();
    const after = await tl.saved((d) => clipsOf(d).length === 1, "the dropped clip is saved");
    await expect(tl.clips).toHaveCount(1);
    wait.stop();
    await expect(ghost).toHaveCount(0);
    const [clip] = onTrack(after, "v1");
    expect([clip.timeline_in, clip.timeline_out, clip.source_in, clip.source_out]).toEqual([
      40, 100, 0, 60,
    ]);
    expect(clip.media_ref).toBe(tl.refs["bars_2s.mp4"]);

    await tl.press("Mod+z");
    await tl.saved((d) => clipsOf(d).length === 0, "one Undo takes the placed clip off");
  });

  test("one Undo of the first clip dropped into a new project also gives back the project's own size", async ({
    tl,
  }) => {
    knownBug(FIRST_DROP_BUG, /one Undo restores the empty project as it was/);
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.doc();
    expect(before.canvas).toMatchObject({ width: 1080, height: 1920 });
    await carryTile(tl, "bars_2s.mp4", { x: await tl.xOf(10), y: await tl.laneY("v1") });
    await tl.page.mouse.up();
    // The first video into a new project sets the project's size to the video's (160 x 90).
    const after = await tl.saved((d) => clipsOf(d).length === 1, "the dropped clip is saved");
    expect(after.canvas).toMatchObject({ width: 160, height: 90 });

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the empty project as it was, size included", 5_000);
  });

  test("a video with sound dropped on a video lane brings its sound to the audio lane, linked", async ({
    tl,
  }) => {
    await tl.start(["talk_2s.mp4"]);
    await carryTile(tl, "talk_2s.mp4", { x: await tl.xOf(20), y: await tl.laneY("v1") });
    await tl.page.mouse.up();
    const after = await tl.saved((d) => clipsOf(d).length === 2, "both halves are saved");
    expect(spans(after, "v1")).toEqual([[20, 80]]);
    expect(spans(after, "a1")).toEqual([[20, 80]]);
    const [v] = onTrack(after, "v1");
    const [a] = onTrack(after, "a1");
    expect(v.link_group).toBeTruthy();
    expect(a.link_group).toBe(v.link_group);
  });

  test("a sound file dropped on the audio lane lands at the drop frame", async ({ tl }) => {
    await tl.start(["tone_2s.m4a"]);
    await carryTile(tl, "tone_2s.m4a", { x: await tl.xOf(12), y: await tl.laneY("a1") });
    await tl.page.mouse.up();
    const after = await tl.saved((d) => clipsOf(d).length === 1, "the sound is saved");
    expect(spans(after, "a1")).toEqual([[12, 72]]);
    expect(spans(after, "v1")).toEqual([]);
  });

  test("a sound file dropped on a video lane never lands on the video lane", async ({ tl }) => {
    await tl.start(["tone_2s.m4a"]);
    await carryTile(tl, "tone_2s.m4a", { x: await tl.xOf(12), y: await tl.laneY("v1") });
    await tl.page.mouse.up();
    // Whatever the app decides (an audio lane, or a refusal), the video lane holds no sound.
    await expect.poll(async () => spans(await tl.doc(), "v1"), { timeout: 5_000 }).toEqual([]);
  });

  test("a tile released outside the timeline places nothing and leaves no ghost", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.doc();
    const preview = await tl.box(tl.page.getByText("Live preview"));
    await carryTile(tl, "bars_2s.mp4", { x: preview.x + 200, y: preview.y + 150 });
    await expect(tl.page.getByTestId("drop-ghost")).toHaveCount(0);
    await tl.page.mouse.up();
    // A clip would be on screen within this wait if the drop had been taken.
    await expect(tl.clips).toHaveCount(0);
    expect(clipsOf(await tl.doc())).toEqual(clipsOf(before));
    const leftovers = await tl.page.evaluate(
      () =>
        [...document.body.children].filter((el) => (el as HTMLElement).style.zIndex === "9999")
          .length,
    );
    expect(leftovers, "the drag ghost was left on the page").toBe(0);
  });
});
