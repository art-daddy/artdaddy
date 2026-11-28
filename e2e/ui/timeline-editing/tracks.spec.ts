// Tracks: adding them, the header toggles (hide, mute, solo, lock, sync lock), what a lock refuses,
// deleting a track (and the question before its clips go), and restacking by dragging a header.
import { onShippedEngineOnly, clipsOf, expect, onTrack, spans, test } from "./lib/timeline";

test.describe("timeline: tracks", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("+V, +A and +T add a video, an audio and a text track, each one Undo step", async ({
    tl,
  }) => {
    await tl.start();
    const before = await tl.doc();
    const v = await tl.addTrack("video");
    const a = await tl.addTrack("audio");
    const t = await tl.addTrack("text");
    const after = await tl.doc();
    expect((after.tracks ?? []).map((x) => [x.id, x.kind])).toEqual([
      ["v1", "video"],
      ["a1", "audio"],
      [v, "video"],
      [a, "audio"],
      [t, "text"],
    ]);
    await expect(tl.page.getByText(/5 tracks Ã‚Â· 0 clips/)).toBeVisible();
    expect([await tl.label(v), await tl.label(a)]).toEqual(["v2", "a2"]);

    await tl.press("Mod+z");
    await tl.saved((d) => (d.tracks ?? []).length === 4, "one Undo removes the text track only");
    await tl.press("Mod+z");
    await tl.press("Mod+z");
    await tl.savedAs(before, "three Undos give the two starting tracks back");
  });

  test("hide, mute and solo are saved on the track and shown pressed; Undo clears them", async ({
    tl,
  }) => {
    await tl.start();
    const before = await tl.doc();
    const hide = await tl.trackButton("v1", "hide");
    const mute = await tl.trackButton("a1", "mute");
    const solo = await tl.trackButton("a1", "solo");

    await hide.click();
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await solo.click();
    await expect(solo).toHaveAttribute("aria-pressed", "true");
    const after = await tl.saved((d) => {
      const [v1, a1] = d.tracks ?? [];
      return v1?.hidden === true && a1?.mute === true && a1?.solo === true;
    }, "hidden v1, muted and soloed a1 are saved");
    expect(clipsOf(after)).toEqual([]);

    await hide.click();
    await expect(hide).toHaveAttribute("aria-pressed", "false");
    await tl.saved((d) => d.tracks?.[0]?.hidden !== true, "v1 shown again is saved");
    for (let i = 0; i < 4; i++) await tl.press("Mod+z");
    await tl.savedAs(before, "four Undos clear the four toggles");
    await expect(mute).toHaveAttribute("aria-pressed", "false");
  });

  test("a locked track refuses a move, a trim, a split and a delete of its clip; unlocked, the move works", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 10, len: 40 }]);
    const lock = await tl.trackButton("v1", "lock");
    await lock.click();
    await expect(lock).toHaveAttribute("aria-pressed", "true");
    const locked = await tl.saved((d) => d.tracks?.[0]?.locked === true, "the lock is saved");
    const [clip] = onTrack(locked, "v1");

    await tl.dragClip(clip.id, 20);
    await tl.trimEdge(clip.id, "end", 30);
    await tl.clickClip(clip.id);
    await tl.setPlayheadFrame(25);
    await tl.press("Mod+k");
    await tl.press("Delete");
    // Nothing reached the clip. (An edit that is refused writes nothing; see the move tests for
    // the Undo list.)
    await expect.poll(async () => clipsOf(await tl.doc())).toEqual(clipsOf(locked));
    await expect(tl.clip(clip.id)).toBeVisible();

    await lock.click();
    await expect(lock).toHaveAttribute("aria-pressed", "false");
    const unlocked = await tl.saved((d) => d.tracks?.[0]?.locked !== true, "unlocked");
    await tl.dragClip(clip.id, 20);
    const moved = await tl.changed(unlocked);
    expect(spans(moved, "v1")).toEqual([[30, 70]]);
  });

  test("an empty track is deleted at once; one Undo brings it back", async ({ tl }) => {
    await tl.start();
    const v2 = await tl.addTrack("video");
    const before = await tl.doc();
    await (await tl.trackButton(v2, "delete")).click();
    const after = await tl.changed(before);
    expect((after.tracks ?? []).map((t) => t.id)).toEqual(["v1", "a1"]);
    expect(await tl.dialogsAsked()).toEqual([]);
    await tl.press("Mod+z");
    await tl.savedAs(before, "Undo restores the track");
  });

  test("deleting a track with clips asks first: Cancel keeps everything, OK deletes it with its clips, Undo restores both", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const v2 = await tl.addTrack("video");
    const before = await tl.seed([{ media: "bars_2s.mp4", track: v2, at: 0, len: 30 }]);
    const del = await tl.trackButton(v2, "delete");

    await tl.answerNextDialog("Cancel");
    await del.click();
    await expect.poll(async () => (await tl.dialogsAsked()).length).toBe(1);
    const [asked] = await tl.dialogsAsked();
    expect(asked.message).toBe("Delete v2 and its 1 clip(s)?");
    expect(JSON.stringify(await tl.doc())).toBe(JSON.stringify(before));

    await tl.answerNextDialog("Ok");
    await del.click();
    const after = await tl.changed(before, "OK deletes the track");
    expect((after.tracks ?? []).map((t) => t.id)).toEqual(["v1", "a1"]);
    expect(clipsOf(after)).toEqual([]);

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the track and its clip");
  });

  test("dragging a video track's header onto another video track restacks them in one Undo step", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const v2 = await tl.addTrack("video");
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
      { media: "bars_2s.mp4", track: v2, at: 30, len: 30 },
    ]);
    const z = (d: typeof before, id: string) =>
      Number((d.tracks ?? []).find((t) => t.id === id)?.z) || 0;
    expect(z(before, v2)).toBeGreaterThan(z(before, "v1"));

    // Press on v1's name strip (above its lane) and release over v2's lane.
    const v1Name = tl.page.getByText("v1", { exact: true });
    const from = await tl.box(v1Name);
    await tl.drag(
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: from.x + from.width / 2, y: await tl.laneY(v2) },
    );
    const after = await tl.changed(before);
    expect(z(after, "v1"), "v1 is now drawn above v2").toBeGreaterThan(z(after, v2));
    // The clips stay on their own tracks: a restack changes the order, not the content.
    expect(clipsOf(after)).toEqual(clipsOf(before));

    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo restores the order");
  });
});
