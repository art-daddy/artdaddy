// Captions, the way a person gets them: they ask the assistant, the app transcribes the clip's
// sound and places captions on the timeline. The assistant runs on scripted replies (the agent
// lane's fake server); the speech engine is the stand-in in lib/speech.ts, which answers with what
// the real engine wrote for this clip. Judged on what the app SAVED (internals/timeline.json), on
// what it told the model, on what it asked the engine, and on the screen.
import { expect, knownBug, test } from "../agent-and-models/lib/qa";
import { callTools, say, type Round } from "../agent-and-models/lib/reply";
import { startTimer } from "../../lib/timing";
import {
  attachSpoken,
  captionText,
  captionsOf,
  chromiumCovers,
  clipsOf,
  placeSpoken,
  resultOf,
  wordsOf,
  type PlacedClip,
} from "./lib/rig";
import { RECORDED_WORDS, SUBTITLES, SpeechStandIn, recordedWordTimes } from "./lib/speech";
import { WHISPER_LANGUAGES } from "../../../src/tools/whisperLanguages";

const inBrowser = (what: string): string => `captions: ${what} [${test.info().project.name}]`;

/** Every caption begins within `slack` frames of the first word it shows, as the engine timed that
 *  word on the clip's own clock, mapped to the timeline through the clip's position and trim. */
function expectCaptionsOnTheVoice(
  captions: PlacedClip[],
  clip: { timeline_in: number; sourceIn: number },
  fps: number,
  slack = 2,
): void {
  const times = recordedWordTimes();
  let at = 0;
  for (const c of captions) {
    const words = wordsOf(captionText(c));
    const first = times.findIndex((w, i) => i >= at && w.word === words[0]);
    expect(first, `"${words[0]}" is not a word the engine heard`).toBeGreaterThanOrEqual(0);
    const expected = Math.round((times[first].start - clip.sourceIn) * fps) + clip.timeline_in;
    expect(
      Math.abs(c.timeline_in - expected),
      `"${captionText(c)}" starts at frame ${c.timeline_in}; its first word is said at frame ${expected}`,
    ).toBeLessThanOrEqual(slack);
    at = first + words.length;
  }
}

test.describe("captions from the assistant", () => {
  test.setTimeout(180_000);

  test("a spoken clip gets captions of exactly its words, on the voice, on a captions track; one Undo takes the set away", async ({
    qa,
  }) => {
    const speech = await SpeechStandIn.install(qa);
    await qa.openProject("sweep_qa_captions");
    const ref = await attachSpoken(qa);
    const { audio, fps } = await placeSpoken(qa, ref);
    const before = await qa.savedTimeline();

    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "add_captions", arguments: {} }], "I'll add captions."),
      (round: Round) => {
        told = resultOf(round, "add_captions");
        return say("Captions are on.");
      },
    );
    const wait = startTimer(
      inBrowser("Send to captions on the timeline, 12 s clip, speech stand-in"),
    );
    await qa.send("Add captions");
    await expect(qa.reply("Captions are on.")).toBeVisible({ timeout: 90_000 });
    await qa.idle();
    wait.stop();

    // The engine was asked once, for the stretch the clip plays (the whole 12 s here), with no
    // language named: it detects it.
    expect(speech.launches).toHaveLength(1);
    const [launch] = speech.launches;
    expect(launch.window.start).toBe(0);
    expect(launch.window.end).toBeGreaterThanOrEqual(11.5);
    expect(launch.args[launch.args.indexOf("-l") + 1]).toBe("auto");

    // The model was told what was made.
    expect(told.ok, JSON.stringify(told)).not.toBe(false);
    const saved = await qa.savedTimeline();
    const captions = captionsOf(saved);
    expect(told.count).toBe(captions.length);
    expect(captions.length).toBeGreaterThanOrEqual(3);

    // One set, on one text track, and every word that was said, in order, nothing else.
    expect(new Set(captions.map((c) => c.caption_group))).toEqual(new Set([told.caption_group]));
    expect(new Set(captions.map((c) => c.trackKind))).toEqual(new Set(["text"]));
    expect(new Set(captions.map((c) => c.track)).size).toBe(1);
    expect(wordsOf(captions.map(captionText).join(" "))).toEqual(RECORDED_WORDS);

    // On the voice, never overlapping, never past the sound.
    expectCaptionsOnTheVoice(captions, { timeline_in: audio.timeline_in, sourceIn: 0 }, fps);
    for (let i = 1; i < captions.length; i++)
      expect(captions[i].timeline_in).toBeGreaterThanOrEqual(captions[i - 1].timeline_out);
    expect(captions[captions.length - 1].timeline_out).toBeLessThanOrEqual(audio.timeline_out);

    // The person sees them on the timeline.
    for (const c of captions) await expect(qa.timelineClip(c.id)).toBeVisible();

    // One Undo takes the whole set away, and the project is as it was before.
    await qa.pane.getByRole("button", { name: "Undo", exact: true }).click();
    for (const c of captions) await expect(qa.timelineClip(c.id)).toHaveCount(0);
    await expect
      .poll(async () => captionsOf(await qa.savedTimeline()).length, { timeout: 10_000 })
      .toBe(0);
    expect(clipsOf(await qa.savedTimeline())).toEqual(clipsOf(before));
  });

  test("captions asked for in the language the background transcription already heard use its words: no second run of the engine", async ({
    qa,
  }) => {
    knownBug(
      "Captions asked for in a named language transcribe the clip again although the background already transcribed it",
      /the engine ran again/,
    );
    const speech = await SpeechStandIn.install(qa);
    chromiumCovers();
    await qa.openProject("sweep_qa_captions_reuse");
    const ref = await attachSpoken(qa);
    // The app transcribes the imported clip in the background, whole: it hears English.
    await expect
      .poll(
        () =>
          speech.launches.filter((l) => l.meta.purpose === "index" && l.state === "exited").length,
        {
          timeout: 90_000,
        },
      )
      .toBeGreaterThan(0);
    await placeSpoken(qa, ref);
    const before = speech.launches.length;

    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "add_captions", arguments: { language: "en" } }]),
      (round: Round) => {
        told = resultOf(round, "add_captions");
        return say("English captions are on.");
      },
    );
    const wait = startTimer(
      inBrowser("Send to captions, clip already transcribed in the background"),
    );
    await qa.send("Add English captions");
    await expect(qa.reply("English captions are on.")).toBeVisible({ timeout: 90_000 });
    await qa.idle();
    wait.stop();
    expect(told.ok, JSON.stringify(told)).not.toBe(false);
    const again = speech.launches
      .slice(before)
      .map((l) => `${l.meta.purpose} -l ${l.args[l.args.indexOf("-l") + 1]}`);
    const heard = speech.launches
      .slice(0, before)
      .map((l) => `${l.meta.purpose} -l ${l.args[l.args.indexOf("-l") + 1]}`);
    expect(
      again,
      `the engine ran again (${again.join("; ")}) after the background run (${heard.join("; ")})`,
    ).toEqual([]);
  });

  test("a trimmed clip placed later: only the stretch it plays is transcribed, and its captions sit on the voice inside the clip", async ({
    qa,
  }) => {
    const speech = await SpeechStandIn.install(qa);
    chromiumCovers();
    await qa.openProject("sweep_qa_captions_trim");
    const ref = await attachSpoken(qa);
    // The clip plays source 4.2 s to 10 s (the second sentence and most of the third) from frame 60.
    const { audio, fps } = await placeSpoken(qa, ref, { timeline_in: 60, source_span: [4.2, 10] });
    expect(audio.timeline_in).toBe(60);

    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "add_captions", arguments: { language: "en" } }]),
      (round: Round) => {
        told = resultOf(round, "add_captions");
        return say("Captions are on.");
      },
    );
    await qa.send("Caption it");
    await expect(qa.reply("Captions are on.")).toBeVisible({ timeout: 90_000 });
    await qa.idle();
    expect(told.ok, JSON.stringify(told)).not.toBe(false);

    // No run was handed more than the used stretch and a second either side (S2-10).
    const requested = speech.launches.filter((l) => l.meta.purpose !== "index");
    expect(requested.length).toBeGreaterThanOrEqual(1);
    for (const l of requested) {
      expect(l.window.start).toBeGreaterThanOrEqual(3.2 - 0.05);
      expect(l.window.end).toBeLessThanOrEqual(11 + 0.05);
    }

    const captions = captionsOf(await qa.savedTimeline());
    const said = wordsOf(captions.map(captionText).join(" "));
    // The first sentence is cut away: none of its words is captioned.
    for (const w of ["captions", "should", "follow", "voice"]) expect(said).not.toContain(w);
    expect(said).toContain("every");
    expect(said).toContain("picture");
    // Every captioned word is one that was said, in order.
    expect(RECORDED_WORDS.join(" ")).toContain(said.join(" "));
    // Inside the clip, on the voice through the trim and the position.
    for (const c of captions) {
      expect(c.timeline_in).toBeGreaterThanOrEqual(audio.timeline_in);
      expect(c.timeline_out).toBeLessThanOrEqual(audio.timeline_out);
    }
    expectCaptionsOnTheVoice(captions, { timeline_in: 60, sourceIn: 4.2 }, fps);
  });

  test("a language the engine does not know is never passed to it: it detects the language instead, and a known code is passed as it is", async ({
    qa,
  }) => {
    const speech = await SpeechStandIn.install(qa);
    chromiumCovers();
    await qa.openProject("sweep_qa_captions_lang");
    const ref = await attachSpoken(qa);
    await placeSpoken(qa, ref);

    const results: Array<Record<string, unknown>> = [];
    qa.server.script(
      // "fil" made the engine print its usage and exit for one user, 19 times (whisperLanguages.ts).
      callTools([{ name: "add_captions", arguments: { language: "fil" } }]),
      (round: Round) => {
        results.push(resultOf(round, "add_captions"));
        return say("Done.");
      },
    );
    await qa.send("Captions please, the speaker is Filipino");
    await expect(qa.reply("Done.")).toBeVisible({ timeout: 90_000 });
    await qa.idle();
    const asked = speech.launches.map((l) => l.args[l.args.indexOf("-l") + 1]);
    expect(asked, `languages the engine was handed: ${asked.join(", ")}`).not.toContain("fil");
    // Every language the engine was handed is one it knows (Filipino is filed under Tagalog), or "auto".
    for (const l of asked)
      expect(l === "auto" || l in WHISPER_LANGUAGES, `"${l}" is not a code the engine knows`).toBe(
        true,
      );
    expect(results[0].ok, JSON.stringify(results[0])).not.toBe(false);

    const before = speech.launches.length;
    qa.server.script(
      callTools([
        { name: "add_captions", arguments: { language: "es", text_track_id: "subs_es" } },
      ]),
      (round: Round) => {
        results.push(resultOf(round, "add_captions"));
        return say("Spanish done.");
      },
    );
    await qa.send("Now the Spanish captions");
    await expect(qa.reply("Spanish done.")).toBeVisible({ timeout: 90_000 });
    await qa.idle();
    const later = speech.launches.slice(before).map((l) => l.args[l.args.indexOf("-l") + 1]);
    expect(later).toContain("es");
  });

  test("captions from a subtitle file land at the file's own times, with its own words, and the speech engine is not run", async ({
    qa,
  }) => {
    const speech = await SpeechStandIn.install(qa);
    chromiumCovers();
    await qa.openProject("sweep_qa_captions_srt");
    const ref = await attachSpoken(qa);
    const { fps } = await placeSpoken(qa, ref);
    const ranBefore = speech.launches.length;
    const srt = await qa.shell.addMedia(SUBTITLES);

    let imported: Record<string, unknown> = {};
    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "import_media", arguments: { source: { path: srt } } }]),
      (round: Round) => {
        imported = resultOf(round, "import_media");
        return callTools([
          { name: "add_captions", arguments: { subtitle_media_ref: String(imported.media_ref) } },
        ]);
      },
      (round: Round) => {
        told = resultOf(round, "add_captions");
        return say("Your subtitles are on.");
      },
    );
    await qa.send("Use my subtitle file for the captions");
    await expect(qa.reply("Your subtitles are on.")).toBeVisible({ timeout: 60_000 });
    await qa.idle();
    expect(
      told.ok,
      `import: ${JSON.stringify(imported)} captions: ${JSON.stringify(told)}`,
    ).not.toBe(false);

    const captions = captionsOf(await qa.savedTimeline());
    expect(captions.map(captionText)).toEqual([
      "First authored line",
      "Second authored line",
      "Third authored line",
    ]);
    expect(captions.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [Math.round(1 * fps), Math.round(3 * fps)],
      [Math.round(5 * fps), Math.round(7.5 * fps)],
      [Math.round(9 * fps), Math.round(11 * fps)],
    ]);
    // Placing an authored file transcribes nothing.
    expect(speech.launches.slice(ranBefore).filter((l) => l.meta.purpose !== "index")).toHaveLength(
      0,
    );
  });

  test("when the speech engine fails, the assistant is told it failed (not that nobody speaks), and no caption is placed", async ({
    qa,
  }) => {
    const speech = await SpeechStandIn.install(qa);
    chromiumCovers();
    await qa.openProject("sweep_qa_captions_fail");
    const ref = await attachSpoken(qa);
    await placeSpoken(qa, ref);
    // Every launch from now on fails, the way a broken engine does.
    speech.answer(
      ...Array.from({ length: 6 }, () => ({
        kind: "fail" as const,
        code: 3221225781,
        stderr: "whisper-cli: failed to initialize whisper context",
      })),
    );
    const before = await qa.savedTimeline();
    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "add_captions", arguments: { language: "en" } }]),
      (round: Round) => {
        told = resultOf(round, "add_captions");
        return say("The captions could not be made.");
      },
    );
    await qa.send("Add captions");
    await expect(qa.reply("The captions could not be made.")).toBeVisible({ timeout: 120_000 });
    await qa.idle();

    expect(told.ok).toBe(false);
    expect(String(told.error)).toMatch(/NOT an absence of speech/);
    expect(String(told.error)).not.toMatch(/no speech detected/);
    expect(captionsOf(await qa.savedTimeline())).toHaveLength(0);
    expect(clipsOf(await qa.savedTimeline())).toEqual(clipsOf(before));
    // The person sees that it failed, in the chat.
    await expect(qa.pane.getByText(/caption/i).first()).toBeVisible();
  });
});
