// Captions after they are made, as a person works with them: correct one by hand in the Inspector,
// restyle the set, delete one, and cut a stretch of the clip out. Judged on what the app SAVED
// (internals/timeline.json) and on the screen; the assistant runs on scripted replies, the speech
// engine is the stand-in (lib/speech.ts).
import { expect, knownBug, test } from "../agent-and-models/lib/qa";
import { callTools, say, type Round } from "../agent-and-models/lib/reply";
import {
  attachSpoken,
  captionText,
  captionsByAssistant,
  captionsOf,
  chromiumCovers,
  clipsOf,
  placeSpoken,
  resultOf,
  wordsOf,
} from "./lib/rig";
import { SpeechStandIn, recordedWordTimes } from "./lib/speech";

/** A project with the spoken clip at frame 0 and its captions, made by the assistant. */
async function captioned(qa: Parameters<typeof attachSpoken>[0], name: string) {
  await SpeechStandIn.install(qa);
  await qa.openProject(name);
  const ref = await attachSpoken(qa);
  const placed = await placeSpoken(qa, ref);
  const { told, captions } = await captionsByAssistant(qa, { language: "en" });
  return { ref, ...placed, told, captions };
}

test.describe("editing captions", () => {
  test.setTimeout(180_000);

  test("a person selects a caption to correct it: the Inspector's Text box shows the caption's words", async ({
    qa,
  }) => {
    knownBug(
      "Selecting a caption shows an empty Text box in the Inspector (it reads the clip's text, captions keep their words in content)",
      /Text box for a caption/,
    );
    const { captions } = await captioned(qa, "sweep_qa_caption_box");
    const [first] = captions;
    await qa.timelineClip(first.id).click();
    const box = qa.page.getByLabel("text content");
    await expect(box).toBeVisible({ timeout: 10_000 });
    await expect(box, "the Inspector's Text box for a caption").toHaveValue(captionText(first));
  });

  test("a person types a correction in the Inspector: that caption says it, the others do not change, and Undo takes it back", async ({
    qa,
  }) => {
    const { captions } = await captioned(qa, "sweep_qa_caption_edit");
    const [first, ...rest] = captions;
    await qa.timelineClip(first.id).click();
    const box = qa.page.getByLabel("text content");
    await expect(box).toBeVisible({ timeout: 10_000 });

    const corrected = "Captions must follow the voice.";
    await box.fill(corrected);
    await expect(qa.timelineClip(first.id)).toContainText(corrected);
    const shown = async () => {
      const c = captionsOf(await qa.savedTimeline()).find((x) => x.id === first.id);
      return c ? (typeof c.text === "string" && c.text ? c.text : captionText(c)) : null;
    };
    await expect.poll(shown).toBe(corrected);
    // Only that caption changed.
    const after = captionsOf(await qa.savedTimeline());
    expect(after.filter((c) => c.id !== first.id).map(captionText)).toEqual(rest.map(captionText));

    // Undo, the way a person does it after typing: out of the text box, Ctrl+Z (Cmd+Z on a Mac).
    await box.blur();
    await qa.page.keyboard.press("ControlOrMeta+z");
    await expect.poll(shown).toBe(captionText(first));
  });

  test("restyling the set changes every caption in it and nothing else, and keeps their words and times", async ({
    qa,
  }) => {
    chromiumCovers();
    const { captions, told } = await captioned(qa, "sweep_qa_caption_style");
    let restyled: Record<string, unknown> = {};
    qa.server.script(
      callTools([
        {
          name: "update_text",
          arguments: {
            caption_group: String(told.caption_group),
            style: { font: "Anton", color: "#FFD400" },
          },
        },
      ]),
      (round: Round) => {
        restyled = resultOf(round, "update_text");
        return say("They are yellow now.");
      },
    );
    await qa.send("Make the captions yellow, in Anton");
    await expect(qa.reply("They are yellow now.")).toBeVisible({ timeout: 30_000 });
    await qa.idle();
    expect(restyled.ok, JSON.stringify(restyled)).not.toBe(false);
    const after = captionsOf(await qa.savedTimeline());
    expect(after.map((c) => c.id)).toEqual(captions.map((c) => c.id));
    for (const c of after) {
      const style = (c.style ?? {}) as Record<string, unknown>;
      expect(style.font, `caption ${c.id}`).toBe("Anton");
      expect(String(style.color).toUpperCase(), `caption ${c.id}`).toBe("#FFD400");
    }
    expect(after.map(captionText)).toEqual(captions.map(captionText));
    expect(after.map((c) => [c.timeline_in, c.timeline_out])).toEqual(
      captions.map((c) => [c.timeline_in, c.timeline_out]),
    );
  });

  test("a person deletes one caption with the Delete key; the rest stay; Undo brings it back", async ({
    qa,
  }) => {
    const { captions } = await captioned(qa, "sweep_qa_caption_delete");
    const victim = captions[1];
    await qa.timelineClip(victim.id).click();
    await qa.page.keyboard.press("Delete");
    await expect(qa.timelineClip(victim.id)).toHaveCount(0);
    await expect
      .poll(async () => captionsOf(await qa.savedTimeline()).map((c) => c.id))
      .toEqual(captions.filter((c) => c.id !== victim.id).map((c) => c.id));
    await qa.page.keyboard.press("ControlOrMeta+z");
    await expect(qa.timelineClip(victim.id)).toBeVisible();
    await expect
      .poll(async () => captionsOf(await qa.savedTimeline()).map((c) => c.id))
      .toEqual(captions.map((c) => c.id));
  });

  test("cutting a stretch out of the clip takes its captions out too, and the captions after it move with the voice", async ({
    qa,
  }) => {
    knownBug(
      "Cutting a stretch out of a captioned clip is refused because of the captions track, and the way the refusal offers leaves the captions out of step with the voice",
      /sync-locked track 'captions'/,
    );
    chromiumCovers();
    const { video, fps, captions } = await captioned(qa, "sweep_qa_caption_cut");
    // Cut out 4 s to 8 s: the second sentence ("Every word appears while it is spoken.").
    const cut = { start: Math.round(4 * fps), end: Math.round(8 * fps) };
    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "ripple_delete", arguments: { track_id: video.track, ranges: [cut] } }]),
      (round: Round) => {
        told = resultOf(round, "ripple_delete");
        return say("The middle sentence is cut.");
      },
    );
    await qa.send("Cut out the middle sentence, 4 s to 8 s");
    await expect(qa.reply("The middle sentence is cut.")).toBeVisible({ timeout: 30_000 });
    await qa.idle();
    expect(told.ok, JSON.stringify(told).slice(0, 600)).not.toBe(false);

    const tl = await qa.savedTimeline();
    // The sound is cut too (linked audio follows its video).
    const audioEnd = Math.max(
      ...clipsOf(tl)
        .filter((c) => c.trackKind === "audio")
        .map((c) => c.timeline_out),
    );
    expect(audioEnd).toBe(Math.round(12 * fps) - (cut.end - cut.start));
    const after = captionsOf(tl);
    const said = wordsOf(after.map(captionText).join(" "));
    // No caption shows words that were cut out.
    for (const w of ["every", "appears", "spoken"])
      expect(said, `"${w}" was cut out`).not.toContain(w);
    // The first and last sentences are still captioned, and each caption sits on its words: a word said at
    // source second t is at frame t x fps before the cut and (t - 4) x fps after it.
    expect(said).toContain("captions");
    expect(said).toContain("together");
    const times = recordedWordTimes();
    for (const c of after) {
      const first = wordsOf(captionText(c))[0];
      const heard = times.find((w) => w.word === first && (w.start < 4 || w.start >= 8));
      expect(heard, `"${first}" is not a word that remains`).toBeTruthy();
      const expected = Math.round((heard!.start < 4 ? heard!.start : heard!.start - 4) * fps);
      expect(
        Math.abs(c.timeline_in - expected),
        `"${captionText(c)}" starts at frame ${c.timeline_in}; its first word is now said at frame ${expected}`,
      ).toBeLessThanOrEqual(2);
      expect(c.timeline_out).toBeLessThanOrEqual(audioEnd);
    }
    expect(after.length).toBeLessThan(captions.length);
  });
});
