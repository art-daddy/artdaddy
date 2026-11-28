// Moving clips by hand: along a lane, to another lane, with a linked partner, over another clip, as a
// copy (Alt), with the arrow keys, and with snapping. Each check reads the SAVED timeline, and each
// gesture is one undo step that puts back exactly the document it changed.
import {
  onShippedEngineOnly,
  clipsOf,
  expect,
  knownBug,
  onTrack,
  spans,
  test,
  timelineWait,
} from "./lib/timeline";

test.describe("timeline: moving clips", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("drag a clip along its lane: it lands where it was dropped, keeps its length and footage, and one Undo puts it back", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 30, len: 45 }]);
    const [clip] = onTrack(before, "v1");

    const wait = timelineWait("drag a clip to its saved new place");
    await tl.dragClip(clip.id, 40);
    const after = await tl.changed(before);
    wait.stop();
    const [moved] = onTrack(after, "v1");
    expect(moved.id).toBe(clip.id);
    expect([moved.timeline_in, moved.timeline_out]).toEqual([70, 115]);
    // A move changes where the clip sits on the timeline, never which footage it plays.
    expect([moved.source_in, moved.source_out]).toEqual([clip.source_in, clip.source_out]);
    await expect(tl.page.getByText(/2 tracks \u00b7 1 clips/)).toBeVisible();

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the document from before the drag");
    await tl.press("Mod+Shift+z");
    await tl.savedAs(after, "Redo puts the move back");
  });

  test("a video with sound moves with its sound: both halves shift by the same frames and stay linked", async ({
    tl,
  }) => {
    await tl.start(["talk_2s.mp4"]);
    const before = await tl.seed([{ media: "talk_2s.mp4", track: "v1", at: 0 }]);
    const [video] = onTrack(before, "v1");
    const [audio] = onTrack(before, "a1");
    expect(audio?.link_group, "placing a video with sound brings its sound, linked").toBe(
      video.link_group,
    );

    await tl.dragClip(video.id, 30);
    const after = await tl.changed(before);
    expect(spans(after, "v1")).toEqual([[30, 90]]);
    expect(spans(after, "a1")).toEqual([[30, 90]]);
    expect(onTrack(after, "a1")[0].link_group).toBe(onTrack(after, "v1")[0].link_group);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo moves both halves back");
  });

  test("drag a clip onto another video track: it moves there; dropped on an audio track it stays on its own", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const v2 = await tl.addTrack("video");
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 20, len: 40 }]);
    const [clip] = onTrack(before, "v1");

    await tl.dragClip(clip.id, 0, { toTrack: v2 });
    const onV2 = await tl.changed(before, "the clip reaches the new video track");
    expect(spans(onV2, "v1")).toEqual([]);
    expect(onTrack(onV2, v2).map((c) => [c.id, c.timeline_in, c.timeline_out])).toEqual([
      [clip.id, 20, 60],
    ]);

    // A picture cannot go on a sound lane: the drop keeps the clip on its own track.
    await tl.dragClip(clip.id, 10, { toTrack: "a1" });
    const after = await tl.changed(onV2, "the clip moves along its own track");
    expect(spans(after, "a1")).toEqual([]);
    expect(spans(after, v2)).toEqual([[30, 70]]);
  });

  test("a clip dropped over another one overwrites the part it covers, and Undo gives that part back", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 60 },
      { media: "bars_2s.mp4", track: "v1", at: 90, len: 50 },
    ]);
    const [first, second] = onTrack(before, "v1");

    await tl.dragClip(second.id, -60);
    const after = await tl.changed(before);
    const [a, b] = onTrack(after, "v1");
    expect([a.id, a.timeline_in, a.timeline_out]).toEqual([first.id, 0, 30]);
    expect([b.id, b.timeline_in, b.timeline_out]).toEqual([second.id, 30, 80]);
    // The covered clip lost its tail, so it plays 30 frames of footage now, from the same start.
    expect(a.source_in).toBe(first.source_in);
    expect((a.source_out ?? 0) - (a.source_in ?? 0)).toBe(30);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the overwritten clip whole");
  });

  test("Alt+drag leaves the clip where it was and puts a copy where it is dropped", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 40 }]);
    const [clip] = onTrack(before, "v1");

    await tl.dragClip(clip.id, 60, { modifiers: ["Alt"] });
    const after = await tl.changed(before);
    const [orig, copy] = onTrack(after, "v1");
    expect([orig.id, orig.timeline_in, orig.timeline_out]).toEqual([clip.id, 0, 40]);
    expect(copy.id).not.toBe(clip.id);
    expect([copy.timeline_in, copy.timeline_out]).toEqual([60, 100]);
    expect([copy.media_ref, copy.source_in, copy.source_out]).toEqual([
      clip.media_ref,
      clip.source_in,
      clip.source_out,
    ]);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo removes the copy");
  });

  test("Alt+arrow nudges the selected clip one frame, Shift+Alt+arrow five; each press is one Undo", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const start = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 30, len: 30 }]);
    const [clip] = onTrack(start, "v1");
    await tl.clickClip(clip.id);
    await expect.poll(async () => (await tl.ui()).selection).toBe(clip.id);

    await tl.press("Alt+ArrowRight");
    const one = await tl.saved((d) => onTrack(d, "v1")[0]?.timeline_in === 31, "nudged 1 frame");
    await tl.press("Shift+Alt+ArrowRight");
    await tl.saved((d) => onTrack(d, "v1")[0]?.timeline_in === 36, "nudged 5 more frames");
    await tl.press("Alt+ArrowLeft");
    const back = await tl.saved((d) => onTrack(d, "v1")[0]?.timeline_in === 35, "nudged back 1");
    expect(spans(back, "v1")).toEqual([[35, 65]]);

    await tl.press("Mod+z");
    await tl.press("Mod+z");
    await tl.savedAs(one, "two Undos take back the last two nudges only");
    await tl.press("Mod+z");
    await tl.savedAs(start, "a third takes back the first");
  });

  test("with snapping on, a clip dropped near another clip's edge lands on that edge; with it off, where it was dropped", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 60 },
      { media: "bars_2s.mp4", track: "v1", at: 100, len: 40 },
    ]);
    const second = onTrack(before, "v1")[1];

    // Two frames short of the first clip's end, off: it lands where it was dropped.
    await tl.dragClip(second.id, -38);
    const loose = await tl.changed(before);
    expect(spans(loose, "v1")).toEqual([
      [0, 60],
      [62, 102],
    ]);
    await tl.press("Mod+z");
    await tl.savedAs(before, "Undo");

    // The same drop with snapping on butts it against the edge (S toggles it, as the toolbar says).
    await tl.press("s");
    await expect(tl.page.getByRole("button", { name: "snapping", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await tl.dragClip(second.id, -38);
    const snapped = await tl.changed(before);
    expect(spans(snapped, "v1")).toEqual([
      [0, 60],
      [60, 100],
    ]);
  });

  test("a press on a clip with no movement selects it and adds no Undo step", async ({ tl }) => {
    await tl.start(["bars_2s.mp4"]);
    const placed = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 10 }]);
    // The last real edit before the press: a trim of the clip's end to frame 40.
    await tl.trimEdge(onTrack(placed, "v1")[0].id, "end", 40);
    const trimmed = await tl.saved((d) => onTrack(d, "v1")[0]?.timeline_out === 40, "trimmed");
    const [clip] = onTrack(trimmed, "v1");
    await tl.clickClip(clip.id);
    await expect.poll(async () => (await tl.ui()).selection).toBe(clip.id);
    await expect(tl.clip(clip.id)).toHaveClass(/ring-white/);
    expect(clipsOf(await tl.doc())).toEqual(clipsOf(trimmed));
    // Undo reaches the trim: the press put nothing on the Undo list.
    await tl.press("Mod+z");
    await tl.savedAs(placed, "one Undo after the press takes back the trim before it");
  });

  test("a drag that changes nothing (a picture dropped straight down on a sound lane) adds no Undo step", async ({
    tl,
  }) => {
    knownBug(NOOP_BUG, /takes back the trim before it/);
    await tl.start(["bars_2s.mp4"]);
    const placed = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 10 }]);
    const [c] = onTrack(placed, "v1");
    await tl.trimEdge(c.id, "end", 50);
    const trimmed = await tl.saved((d) => onTrack(d, "v1")[0]?.timeline_out === 50, "trimmed");

    await tl.dragClip(c.id, 0, { toTrack: "a1" });
    expect(clipsOf(await tl.doc())).toEqual(clipsOf(trimmed));
    await tl.press("Mod+z");
    await tl.savedAs(
      placed,
      "one Undo after the refused drop takes back the trim before it",
      5_000,
    );
  });

  test("a clip dragged away and back to where it started leaves Redo working", async ({ tl }) => {
    knownBug(NOOP_BUG, /Redo still brings back the trim/);
    await tl.start(["bars_2s.mp4"]);
    const placed = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 10 }]);
    const [c] = onTrack(placed, "v1");
    await tl.trimEdge(c.id, "end", 50);
    const trimmed = await tl.saved((d) => onTrack(d, "v1")[0]?.timeline_out === 50, "trimmed");
    await tl.press("Mod+z");
    await tl.savedAs(placed, "Undo takes the trim back");

    // A nervous grab: forty pixels right and back again, released where it began.
    const b = await tl.box(tl.clip(c.id));
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await tl.page.mouse.move(at.x, at.y);
    await tl.page.mouse.down();
    await tl.page.mouse.move(at.x + 40, at.y, { steps: 6 });
    await tl.page.mouse.move(at.x, at.y, { steps: 6 });
    await tl.page.mouse.up();
    expect(clipsOf(await tl.doc())).toEqual(clipsOf(placed));
    await tl.press("Mod+Shift+z");
    await tl.savedAs(trimmed, "Redo still brings back the trim", 5_000);
  });
});

const NOOP_BUG =
  "A drag that changes nothing still takes an Undo step and wipes Redo (QA catch-up, qa-timeline, 28 Nov)";
