// A hand edit outlives the app: quit, start again, open the project, and the timeline is as it was
// saved. The Undo list does not outlive it (by design: undo lives in memory for the open project).
import { onShippedEngineOnly, clipsOf, expect, onTrack, test, timelineWait } from "./lib/timeline";

test.describe("timeline: after a restart", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("a moved and trimmed clip is still there, drawn at its saved place, after the app restarts", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 40 }]);
    const [clip] = onTrack(before, "v1");
    await tl.dragClip(clip.id, 25);
    const moved = await tl.changed(before);
    await tl.trimEdge(clip.id, "end", 55);
    const edited = await tl.changed(moved);

    const wait = timelineWait("restart and reopen a project to its clips on the timeline");
    const again = await tl.qa.reopen("sweep_qa_timeline");
    expect(again).toBe(tl.projectId);
    await expect(tl.clip(clip.id)).toBeVisible({ timeout: 20_000 });
    wait.stop();

    expect(clipsOf(await tl.doc())).toEqual(clipsOf(edited));
    const [c] = onTrack(edited, "v1");
    expect([c.timeline_in, c.timeline_out]).toEqual([25, 55]);
    // Drawn at its saved length: 30 frames at the zoom the reopened app reports (30 fps).
    const { zoom } = await tl.ui();
    const b = await tl.box(tl.clip(clip.id));
    expect(b.width).toBeCloseTo((30 * zoom) / 30, 0);
  });
});
