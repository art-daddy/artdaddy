// The clip's details by hand: a transition chosen in the Inspector and resized on the timeline, an
// opacity curve keyed at two playhead positions, a fade dragged from the clip's corner, and a title
// the agent made (a scripted reply, no model) reworded and moved by hand. Times in the saved clip are
// frames: keyframe times are frames from the clip's own start.
import { addTitle } from "../agent-and-models/fixtures/replies/addTitle";
import { plainText } from "../agent-and-models/fixtures/replies/plainText";
import { callTools } from "../agent-and-models/lib/reply";
import {
  onShippedEngineOnly,
  clipsOf,
  expect,
  knownBug,
  onTrack,
  spans,
  test,
  type SavedClip,
  type TimelineRig,
} from "./lib/timeline";

/** A saved transition as the app reads it: kind and length in frames. */
function transitionOf(c: SavedClip | undefined): { kind?: string; duration?: number } | null {
  const t = c?.transition_in;
  if (!t) return null;
  if (typeof t === "string") return { kind: t };
  return t as { kind?: string; duration?: number };
}

test.describe("timeline: transitions, keyframes, fades and titles", () => {
  onShippedEngineOnly();
  test.setTimeout(180_000);

  test("a transition chosen in the Inspector is saved on the later clip and moves neither clip; dragging its edge resizes it", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([
      { media: "bars_2s.mp4", track: "v1", at: 0, len: 60 },
      { media: "bars_2s.mp4", track: "v1", at: 60, len: 60 },
    ]);
    const [, second] = onTrack(before, "v1");
    await tl.clickClip(second.id);
    await tl.page.getByLabel("transition kind").selectOption("crossfade");
    const withT = await tl.saved(
      (d) => transitionOf(onTrack(d, "v1")[1])?.kind === "crossfade",
      "the crossfade is saved on the second clip",
    );
    expect(transitionOf(onTrack(withT, "v1")[1])?.duration).toBe(15);
    expect(spans(withT, "v1")).toEqual(spans(before, "v1"));

    // The widget is centred on the cut: its end edge sits half the length after it. Drag that
    // edge to 10 frames after the cut and the transition is 20 frames long.
    const edge = tl.page.getByRole("separator", { name: "transition resize end" });
    const b = await tl.box(edge);
    const y = b.y + b.height / 2;
    await tl.drag({ x: b.x + b.width / 2, y }, { x: await tl.xOf(70), y });
    const resized = await tl.saved(
      (d) => transitionOf(onTrack(d, "v1")[1])?.duration === 20,
      "the transition is 20 frames after the drag",
    );
    expect(spans(resized, "v1")).toEqual(spans(before, "v1"));

    await tl.press("Mod+z");
    await tl.savedAs(withT, "one Undo restores the 15-frame transition");
  });

  test("an opacity curve keyed at two playhead positions is saved in frames from the clip's start", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const d = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 30, len: 60 }]);
    const [clip] = onTrack(d, "v1");
    await tl.clickClip(clip.id);
    await tl.setPlayheadFrame(30);
    await tl.page.getByRole("button", { name: "keyframe opacity", exact: true }).click();
    await tl.saved((x) => Array.isArray(onTrack(x, "v1")[0]?.opacity), "opacity is animated");

    await tl.setPlayheadFrame(60);
    await tl.page.getByRole("spinbutton", { name: "opacity" }).click();
    const field = tl.page.getByRole("textbox", { name: "opacity" });
    await field.fill("0.2");
    await field.press("Enter");
    const after = await tl.saved(
      (x) => (onTrack(x, "v1")[0]?.opacity as unknown[] | undefined)?.length === 2,
      "a second opacity key is saved",
    );
    const keys = (onTrack(after, "v1")[0].opacity as Array<{ t: number; v: number }>).map((k) => [
      k.t,
      k.v,
    ]);
    // Timeline frames 30 and 60 are frames 0 and 30 of a clip that starts at 30.
    expect(keys).toEqual([
      [0, 1],
      [30, 0.2],
    ]);
    // The clip shows a diamond for each key while it is selected.
    await expect(tl.clip(clip.id).getByRole("button", { name: "keyframe at 30" })).toBeVisible();
    expect(spans(after, "v1")).toEqual([[30, 90]]);
  });

  test("dragging the fade-in knob from the clip's corner sets a fade in frames, never past the clip", async ({
    tl,
  }) => {
    await tl.start(["bars_2s.mp4"]);
    const before = await tl.seed([{ media: "bars_2s.mp4", track: "v1", at: 0, len: 60 }]);
    const [clip] = onTrack(before, "v1");
    await tl.clickClip(clip.id);
    const knob = tl.clip(clip.id).getByRole("slider", { name: "fade in" });
    await expect(knob).toBeVisible();
    const k = await tl.box(knob);
    const y = k.y + k.height / 2;
    await tl.drag({ x: k.x + k.width / 2, y }, { x: await tl.xOf(15), y });
    const faded = await tl.saved(
      (d) => onTrack(d, "v1")[0]?.fade?.in === 15,
      "a 15-frame fade in is saved",
    );
    expect(spans(faded, "v1"), "a fade is not a move").toEqual([[0, 60]]);

    const k2 = await tl.box(knob);
    await tl.drag({ x: k2.x + k2.width / 2, y }, { x: await tl.xOf(200), y });
    const capped = await tl.changed(faded, "the second fade drag is saved");
    const fade = onTrack(capped, "v1")[0].fade ?? {};
    expect(fade.in ?? 0).toBeGreaterThan(15);
    expect(fade.in ?? 0, "a fade cannot be longer than its clip").toBeLessThanOrEqual(60);
  });

  test("a title the agent made can be moved and trimmed by hand", async ({ tl }) => {
    tl.qa.server.script(addTitle("Summer in the hills"), plainText("The title is on."));
    await tl.start();
    const title = await agentTitle(tl);
    const before = await tl.doc();

    await tl.dragClip(title.id, 30);
    const moved = await tl.changed(before, "the title moves");
    const m = clipsOf(moved).find((c) => c.id === title.id)!;
    expect([m.timeline_in, m.timeline_out]).toEqual([30, 120]);
    await tl.trimEdge(title.id, "end", 100);
    const trimmed = await tl.changed(moved, "the title is trimmed");
    const t = clipsOf(trimmed).find((c) => c.id === title.id)!;
    expect([t.timeline_in, t.timeline_out]).toEqual([30, 100]);
    expect(JSON.stringify(t.content)).toContain("Summer in the hills");
  });

  test("the Inspector's Text box shows the words of a title the agent made", async ({ tl }) => {
    knownBug(TITLE_BUG, /the Text box shows the title's words/);
    tl.qa.server.script(addTitle("Summer in the hills"), plainText("The title is on."));
    await tl.start();
    const title = await agentTitle(tl);
    await tl.clickClip(title.id);
    await expect(
      tl.page.getByLabel("text content"),
      "the Text box shows the title's words",
    ).toHaveValue("Summer in the hills", { timeout: 5_000 });
  });

  test("a title reworded by hand and then by the agent keeps only the agent's last words", async ({
    tl,
  }) => {
    knownBug(TITLE_BUG, /holds only the agent's last words/);
    tl.qa.server.script(addTitle("Summer in the hills"), plainText("The title is on."));
    await tl.start();
    const title = await agentTitle(tl);
    await tl.clickClip(title.id);
    await tl.page.getByLabel("text content").fill("Winter by the sea");
    await tl.saved(
      (d) =>
        JSON.stringify(clipsOf(d).find((c) => c.id === title.id)).includes("Winter by the sea"),
      "the hand-typed words are saved",
    );

    tl.qa.server.script(
      callTools(
        [{ name: "update_text", arguments: { clip_ids: [title.id], content: "Autumn leaves" } }],
        "Changing the words.",
      ),
      plainText("The title now says Autumn leaves."),
    );
    await tl.qa.send("Change the title to Autumn leaves");
    await expect(tl.qa.reply("The title now says Autumn leaves.")).toBeVisible({ timeout: 20_000 });
    await tl.qa.idle();
    const after = await tl.saved(
      (d) => JSON.stringify(clipsOf(d).find((c) => c.id === title.id)).includes("Autumn leaves"),
      "the agent's words are saved",
    );
    // Two sets of words in one title: the picture shows one, the agent reads the other.
    expect(
      JSON.stringify(clipsOf(after).find((c) => c.id === title.id)),
      "the title holds only the agent's last words",
    ).not.toContain("Winter by the sea");
  });

  for (const [pace, delay] of [
    ["at a steady pace", 80],
    ["quickly, with no pause between keys", 0],
  ] as const) {
    test(`a title typed ${pace} in the Inspector is saved whole, every letter in order`, async ({
      tl,
      browserName,
    }) => {
      if (delay === 0) {
        // Seen in Chromium (the Windows app's WebView2); WebKit kept every letter on 28 Nov.
        test.skip(browserName !== "chromium", "the lost letters were seen in Chromium only");
        knownBug(TYPING_RACE_BUG, /the whole sentence is saved/);
      }
      tl.qa.server.script(addTitle("Hi"), plainText("Done."));
      await tl.start();
      const title = await agentTitle(tl);
      await tl.clickClip(title.id);
      const words = tl.page.getByLabel("text content");
      await words.click();
      await words.press("ControlOrMeta+a");
      await words.pressSequentially("Hello there, how are you", { delay });
      await tl.saved(
        (d) =>
          JSON.stringify(clipsOf(d).find((c) => c.id === title.id)).includes(
            '"Hello there, how are you"',
          ),
        "the whole sentence is saved, not a prefix or an out-of-order mix",
        delay === 0 ? 5_000 : 15_000,
      );
      await expect(words).toHaveValue("Hello there, how are you");
    });
  }

  test("one Undo takes back a word typed in the Inspector, not one letter of it", async ({
    tl,
  }) => {
    knownBug(TYPING_BUG, /one Undo takes back the whole word/);
    tl.qa.server.script(addTitle("Hi"), plainText("Done."));
    await tl.start();
    const title = await agentTitle(tl);
    await tl.clickClip(title.id);
    const untyped = JSON.stringify(clipsOf(await tl.doc()).find((c) => c.id === title.id));
    const words = tl.page.getByLabel("text content");
    await words.click();
    await words.press("ControlOrMeta+a");
    await words.pressSequentially("Hello", { delay: 30 });
    await tl.saved(
      (d) => JSON.stringify(clipsOf(d).find((c) => c.id === title.id)).includes('"Hello"'),
      "the word is saved",
    );
    // Leave the text box (the timeline's own Undo, not the box's), then one Undo.
    await tl.clickClip(title.id);
    await tl.press("Mod+z");
    await tl.saved(
      (d) => JSON.stringify(clipsOf(d).find((c) => c.id === title.id)) === untyped,
      "one Undo takes back the whole word",
      5_000,
    );
  });
});

const TITLE_BUG =
  "The Inspector's Text box is blank for a title the agent made, and words typed there leave the old words in the title (QA catch-up, qa-timeline, 28 Nov)";
const TYPING_BUG =
  "Each letter typed in the Inspector's Text box is its own Undo step (QA catch-up, qa-timeline, 28 Nov)";
const TYPING_RACE_BUG =
  "Letters typed quickly into the Inspector's Text box are lost (QA catch-up, qa-timeline, 28 Nov)";

/** Ask for a title (the scripted replies are queued by the test) and return the saved text clip. */
async function agentTitle(tl: TimelineRig): Promise<SavedClip> {
  await tl.qa.send("Put a title at the start");
  await tl.qa.idle(20_000);
  const made = await tl.saved(
    (d) => clipsOf(d).some((c) => c.kind === "text"),
    "the agent's title is saved",
    20_000,
  );
  const title = clipsOf(made).find((c) => c.kind === "text")!;
  await expect(tl.clip(title.id)).toBeVisible();
  return title;
}
