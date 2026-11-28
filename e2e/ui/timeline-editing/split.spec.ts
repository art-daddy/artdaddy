// Cutting a clip in two: Ctrl+K at the playhead, the razor tool where you click, the clip's right-click
// menu and the Edit menu. Every way in must leave two clips that tile the original exactly, on the
// timeline and in the footage, and one Undo that gives the original back.
import {
  onShippedEngineOnly,
  expect,
  onTrack,
  spans,
  test,
  timelineWait,
  type Doc,
  type SavedClip,
} from "./lib/timeline";

/** The two halves of `orig` cut at `at` (a timeline frame), as the saved document must hold them. */
function expectHalves(after: Doc, track: string, orig: SavedClip, at: number): void {
  const [l, r] = onTrack(after, track);
  expect(onTrack(after, track)).toHaveLength(2);
  expect(l.id, "the left half keeps the clip's id").toBe(orig.id);
  expect([l.timeline_in, l.timeline_out, r.timeline_in, r.timeline_out]).toEqual([
    orig.timeline_in,
    at,
    at,
    orig.timeline_out,
  ]);
  const cut = (orig.source_in ?? 0) + (at - orig.timeline_in);
  expect([l.source_in, l.source_out, r.source_in, r.source_out]).toEqual([
    orig.source_in,
    cut,
    cut,
    orig.source_out,
  ]);
  expect(r.media_ref).toBe(orig.media_ref);
}

test.describe("timeline: splitting clips", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("Ctrl+K cuts the selected clip at the playhead into two that tile it; one Undo joins them", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 10 }]);
    const [clip] = onTrack(before, "v1");
    await tl.clickClip(clip.id);
    await tl.setPlayheadFrame(34);

    const wait = timelineWait("split at the playhead to two saved clips");
    await tl.press("Mod+k");
    const after = await tl.changed(before);
    wait.stop();
    expectHalves(after, "v1", clip, 34);
    await expect(tl.clips).toHaveCount(2);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the whole clip");
  });

  test("the razor tool (C) cuts where the clip is clicked; V goes back to the pointer", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0 }]);
    const [clip] = onTrack(before, "v1");

    await tl.press("c");
    await expect(tl.page.getByRole("button", { name: "razor tool" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await tl.page.mouse.click(await tl.xOf(25), await tl.laneY("v1"));
    const after = await tl.changed(before);
    expectHalves(after, "v1", clip, 25);

    await tl.press("v");
    await expect(tl.page.getByRole("button", { name: "pointer tool" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Back on the pointer, a click selects instead of cutting.
    const [left] = onTrack(after, "v1");
    await tl.clickClip(left.id);
    await expect.poll(async () => (await tl.ui()).selection).toBe(left.id);
    expect(spans(await tl.doc(), "v1")).toEqual(spans(after, "v1"));
  });

  test("right-click > Split at playhead, and Edit > Split at Playhead, cut at the playhead", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0 }]);
    const [clip] = onTrack(before, "v1");

    await tl.setPlayheadFrame(20);
    await tl.clipMenu(clip.id, "Split at playhead");
    const once = await tl.changed(before, "the menu's split reaches the saved timeline");
    expectHalves(once, "v1", clip, 20);

    const right = onTrack(once, "v1")[1];
    await tl.clickClip(right.id);
    await tl.setPlayheadFrame(45);
    await tl.menu("Edit", "Split at Playhead");
    const twice = await tl.changed(once, "Edit > Split at Playhead reaches the saved timeline");
    expect(spans(twice, "v1")).toEqual([
      [0, 20],
      [20, 45],
      [45, 60],
    ]);
  });

  test("splitting a video with sound cuts its sound at the same frame, and the halves stay paired", async ({
    tl,
  }) => {
    await tl.start(["talk_2s.mp4"]);
    const before = await tl.seed([{ media: "talk_2s.mp4", track: "v1", at: 0 }]);
    const [video] = onTrack(before, "v1");
    await tl.clickClip(video.id);
    await tl.setPlayheadFrame(24);
    await tl.press("Mod+k");
    const after = await tl.changed(before);
    expect(spans(after, "v1")).toEqual([
      [0, 24],
      [24, 60],
    ]);
    expect(spans(after, "a1")).toEqual([
      [0, 24],
      [24, 60],
    ]);
    const [vl, vr] = onTrack(after, "v1");
    const [al, ar] = onTrack(after, "a1");
    expect(al.link_group).toBe(vl.link_group);
    expect(ar.link_group).toBe(vr.link_group);
    expect(vl.link_group).not.toBe(vr.link_group);
  });
});
