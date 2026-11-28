// Selection and the keyboard: click, Shift+click, a box drawn over empty lanes, Ctrl+A, Esc; copy,
// paste, duplicate, disable; the playhead and zoom keys; the Edit menu's Undo and Redo; and the one
// rule that guards all of them: keys typed into a text box never edit the timeline.
import {
  onShippedEngineOnly,
  clipsOf,
  expect,
  knownBug,
  onTrack,
  spans,
  test,
} from "./lib/timeline";

const FOCUS_BUG =
  "After typing in the chat box, clicking a clip leaves the keyboard in the chat box (QA catch-up, qa-timeline, 28 Nov)";

test.describe("timeline: selection and keys", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("click selects a clip, Shift+click adds one, Esc clears the selection", async ({ tl }) => {
    await tl.start(["bars_2s.mp4"]);
    const d = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
      { media: "bars_2s.mp4", track: "v1", at: 40, len: 30 },
    ]);
    const [a, b] = onTrack(d, "v1");
    await tl.clickClip(a.id);
    await expect.poll(async () => (await tl.ui()).selectedIds).toEqual([a.id]);
    await tl.clickClip(b.id, ["Shift"]);
    await expect
      .poll(async () => [...(await tl.ui()).selectedIds].sort())
      .toEqual([a.id, b.id].sort());
    await expect(tl.clip(a.id)).toHaveClass(/ring-white/);
    await expect(tl.clip(b.id)).toHaveClass(/ring-white/);
    await tl.press("Escape");
    await expect.poll(async () => (await tl.ui()).selectedIds).toEqual([]);
    await expect(tl.clip(a.id)).not.toHaveClass(/ring-white/);
  });

  test("Ctrl+A selects every clip on every track, and Delete then removes them all in one Undo step", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4", "tone_2s.m4a"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
      { media: "tone_2s.m4a", track: "a1", at: 10, len: 30 },
    ]);
    await tl.clickClip(onTrack(before, "v1")[0].id);
    await tl.press("Mod+a");
    await expect
      .poll(async () => [...(await tl.ui()).selectedIds].sort())
      .toEqual(
        clipsOf(before)
          .map((c) => c.id)
          .sort(),
      );
    await tl.press("Delete");
    const after = await tl.changed(before);
    expect(clipsOf(after)).toEqual([]);
    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo brings both back");
  });

  for (const across of [false, true]) {
    test(`a box drawn over empty lane space ${across ? "from one track into another" : "on one track"} selects exactly the clips it touches`, async ({
      tl,
    }) => {
      await tl.start(["bars_2s.mp4", "tone_2s.m4a"]);
      const d = await tl.seed([
        { media: "bars_2s.mp4", track: "v1", at: 0, len: 30 },
        { media: "bars_2s.mp4", track: "v1", at: 60, len: 30 },
        { media: "tone_2s.m4a", track: "a1", at: 100, len: 30 },
      ]);
      const [, second] = onTrack(d, "v1");
      const [third] = onTrack(d, "a1");
      const yV = await tl.laneY("v1");
      const yA = await tl.laneY("a1");

      if (!across) {
        // From the gap on v1 (frame 45) to frame 95: touches the second clip only.
        await tl.drag({ x: await tl.xOf(45), y: yV - 8 }, { x: await tl.xOf(95), y: yV + 8 });
        await expect.poll(async () => (await tl.ui()).selectedIds).toEqual([second.id]);
      } else {
        // From empty a1 space (frame 60) up into v1 past frame 110: the second clip and the sound.
        await tl.drag({ x: await tl.xOf(60), y: yA }, { x: await tl.xOf(110), y: yV - 8 });
        await expect
          .poll(async () => [...(await tl.ui()).selectedIds].sort())
          .toEqual([second.id, third.id].sort());
      }
      // Selecting writes nothing.
      expect(clipsOf(await tl.doc())).toEqual(clipsOf(d));
    });
  }

  test("Ctrl+C then Ctrl+V pastes a copy at the playhead on the clip's track; one Undo removes it", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 30 }]);
    const [clip] = onTrack(before, "v1");
    await tl.clickClip(clip.id);
    await tl.press("Mod+c");
    await tl.setPlayheadFrame(50);
    await tl.press("Mod+v");
    const after = await tl.changed(before);
    const [orig, copy] = onTrack(after, "v1");
    expect([orig.id, orig.timeline_in, orig.timeline_out]).toEqual([clip.id, 0, 30]);
    expect(copy.id).not.toBe(clip.id);
    expect([
      copy.timeline_in,
      copy.timeline_out,
      copy.media_ref,
      copy.source_in,
      copy.source_out,
    ]).toEqual([50, 80, clip.media_ref, clip.source_in, clip.source_out]);
    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo removes the pasted copy");
  });

  test("Ctrl+D duplicates the selected clip without touching the original; one Undo removes the copy", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 30 }]);
    const [clip] = onTrack(before, "v1");
    await tl.clickClip(clip.id);
    await tl.press("Mod+d");
    const after = await tl.changed(before);
    const all = clipsOf(after);
    expect(all).toHaveLength(2);
    const orig = all.find((c) => c.id === clip.id)!;
    const copy = all.find((c) => c.id !== clip.id)!;
    expect([orig.track, orig.timeline_in, orig.timeline_out]).toEqual(["v1", 0, 30]);
    expect([copy.media_ref, copy.source_in, copy.source_out]).toEqual([
      clip.media_ref,
      clip.source_in,
      clip.source_out,
    ]);
    expect(copy.timeline_out - copy.timeline_in).toBe(30);
    // The copy is selected, ready to be moved.
    await expect.poll(async () => (await tl.ui()).selection).toBe(copy.id);
    await tl.press("Mod+z");
    await tl.savedAs(before, "one Undo removes the duplicate");
  });

  test("Shift+E disables the selected clip and Shift+E again enables it", async ({ tl }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 30 }]);
    const [clip] = onTrack(before, "v1");
    await tl.clickClip(clip.id);
    await tl.press("Shift+E");
    const off = await tl.saved(
      (d) => onTrack(d, "v1")[0]?.disabled === true,
      "the clip is disabled",
    );
    expect(spans(off, "v1")).toEqual([[0, 30]]);
    await tl.press("Shift+E");
    await tl.saved((d) => onTrack(d, "v1")[0]?.disabled !== true, "the clip is enabled again");
  });

  test("keys typed in the chat box never edit the timeline, Ctrl+Z included", async ({ tl }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 40 }]);
    const [clip] = onTrack(before, "v1");
    await tl.clickClip(clip.id);
    await expect.poll(async () => (await tl.ui()).selection).toBe(clip.id);

    await tl.qa.composer.click();
    await tl.page.keyboard.type("cut s k at 1s");
    await tl.press("Backspace");
    await tl.press("Delete");
    await tl.press("Mod+k");
    await tl.press("Mod+d");
    await tl.press("Mod+z");
    await tl.press("Shift+Delete");
    // Every key went to the text; the clip and the document are untouched.
    await expect(tl.clip(clip.id)).toBeVisible();
    await expect(tl.page.getByRole("button", { name: "razor tool" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(clipsOf(await tl.doc())).toEqual(clipsOf(before));
  });

  test("after typing in the chat box, a click on a clip and Backspace deletes the clip, not a letter of the message", async ({
    tl,
  }) => {
    knownBug(FOCUS_BUG, /reaches the clip, not the chat box/);
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 40 }]);
    const [clip] = onTrack(before, "v1");
    await tl.qa.composer.click();
    await tl.page.keyboard.type("make it shorter");
    await tl.clickClip(clip.id);
    // Backspace is the timeline's Delete too, and the key a Mac keyboard labels "delete".
    await tl.press("Backspace");
    const after = await tl.changed(before, "Backspace reaches the clip, not the chat box");
    expect(clipsOf(after)).toEqual([]);
    await expect(tl.qa.composer).toHaveValue("make it shorter");
  });

  test("Home, End and the arrow keys walk the playhead; Shift+arrow moves five frames", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const d = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0 }]);
    await tl.clickClip(onTrack(d, "v1")[0].id);
    await tl.setPlayheadFrame(30);
    await tl.press("Home");
    await expect.poll(() => tl.playheadFrame()).toBe(0);
    await tl.press("End");
    await expect.poll(() => tl.playheadFrame()).toBe(60);
    await tl.press("ArrowLeft");
    await expect.poll(() => tl.playheadFrame()).toBe(59);
    await tl.press("Shift+ArrowLeft");
    await expect.poll(() => tl.playheadFrame()).toBe(54);
    await tl.press("ArrowRight");
    await expect.poll(() => tl.playheadFrame()).toBe(55);
    // Walking the playhead is not an edit.
    expect(clipsOf(await tl.doc())).toEqual(clipsOf(d));
  });

  test("+ and - zoom the timeline in and out, and Fit shows the whole edit", async ({ tl }) => {
    await tl.start(["bars_2s.mp4"]);
    const d = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0 },
      { media: "bars_2s.mp4", track: "v1", at: 300 },
    ]);
    const z0 = (await tl.ui()).zoom;
    const w0 = (await tl.box(tl.clip(onTrack(d, "v1")[0].id))).width;
    await tl.clickClip(onTrack(d, "v1")[0].id);
    await tl.press("=");
    await expect.poll(async () => (await tl.ui()).zoom).toBeCloseTo(z0 * 1.3, 3);
    await expect
      .poll(async () => (await tl.box(tl.clip(onTrack(d, "v1")[0].id))).width)
      .toBeGreaterThan(w0);
    await tl.press("-");
    await tl.press("-");
    await expect.poll(async () => (await tl.ui()).zoom).toBeCloseTo(z0 / 1.3, 3);

    await tl.page.getByTitle("Fit", { exact: true }).click();
    const last = tl.clip(onTrack(d, "v1")[1].id);
    const lane = await tl.box(tl.lane("v1"));
    // The right edge of the timeline's scrolling view (the ruler sits inside it).
    const viewRight = await tl.page.evaluate(
      () =>
        document
          .querySelector('[aria-label="timeline scrubber"]')
          ?.parentElement?.parentElement?.getBoundingClientRect().right ?? 0,
    );
    await expect
      .poll(
        async () => {
          const lb = await tl.box(last);
          return lb.x + lb.width <= viewRight && lb.x >= lane.x;
        },
        { message: "after Fit the last clip ends inside the timeline's view" },
      )
      .toBe(true);
  });

  test("Edit > Undo and Edit > Redo do what Ctrl+Z and Ctrl+Y do", async ({ tl }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 30 }]);
    const [clip] = onTrack(before, "v1");
    await tl.dragClip(clip.id, 20);
    const moved = await tl.changed(before);
    await tl.menu("Edit", "Undo");
    await tl.savedAs(before, "Edit > Undo");
    await tl.menu("Edit", "Redo");
    await tl.savedAs(moved, "Edit > Redo");
    await tl.press("Mod+z");
    await tl.savedAs(before, "Ctrl+Z");
    await tl.press("Mod+y");
    await tl.savedAs(moved, "Ctrl+Y redoes");
  });
});
