// Transcription as a person meets it: the assistant reads a clip's words, a long transcription
// shows in the status bar and can be cancelled, a background transcription that fails says so and
// can be retried. Scripted replies for the assistant; the speech stand-in (lib/speech.ts) for the
// engine. Judged on what the app told the model, what it asked the engine, and the screen.
import { expect, test } from "../agent-and-models/lib/qa";
import { callTools, say, type Round } from "../agent-and-models/lib/reply";
import { startTimer } from "../../lib/timing";
import { attachSpoken, captionsOf, chromiumCovers, placeSpoken, resultOf } from "./lib/rig";
import { SpeechStandIn, recordedWordTimes } from "./lib/speech";

const inBrowser = (what: string): string => `captions: ${what} [${test.info().project.name}]`;

type Row = [number, string, number, number];

test.describe("transcription", () => {
  test.setTimeout(180_000);

  test("get_transcript of a trimmed clip placed later answers in project frames, through the trim, only the words the clip plays", async ({
    qa,
  }) => {
    await SpeechStandIn.install(qa);
    chromiumCovers();
    await qa.openProject("sweep_qa_transcript");
    const ref = await attachSpoken(qa);
    const { audio, fps } = await placeSpoken(qa, ref, { timeline_in: 90, source_span: [4.2, 10] });

    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "get_transcript", arguments: { clip_id: audio.id } }]),
      (round: Round) => {
        told = resultOf(round, "get_transcript");
        return say("I have read the words.");
      },
    );
    await qa.send("What is said in this clip?");
    await expect(qa.reply("I have read the words.")).toBeVisible({ timeout: 90_000 });
    await qa.idle();

    expect(told.ok, JSON.stringify(told).slice(0, 600)).toBe(true);
    expect(told.timing).toBe("project_frames");
    const rows = ((told.clips as Array<{ words: Row[] }>) ?? []).flatMap((c) => c.words);
    expect(rows.length).toBeGreaterThan(5);
    const clipEnd = audio.timeline_out;
    const times = recordedWordTimes();
    for (const [, text, start, end] of rows) {
      // Never before the clip starts or after it ends on the timeline.
      expect(start).toBeGreaterThanOrEqual(90);
      expect(end).toBeLessThanOrEqual(clipEnd);
      // The frame is the word's own time, through the trim (4.2 s) and the position (frame 90).
      const word = text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
      const heard = times.find(
        (w) => w.word === word && Math.abs(90 + Math.round((w.start - 4.2) * fps) - start) <= 2,
      );
      expect(heard, `"${text}" at frame ${start} is not where it is said`).toBeTruthy();
    }
    const words = rows.map((r) => r[1].toLowerCase().replace(/[^\p{L}\p{N}']/gu, ""));
    expect(words).not.toContain("captions");
    expect(words).toContain("every");
  });

  test("a transcription that takes a while shows in the status bar after 15 s; Cancel there stops it, and the assistant is told it was stopped", async ({
    qa,
  }) => {
    const speech = await SpeechStandIn.install(qa);
    // The background transcription of the imported clip does not get in the way (it fails at once);
    // the captions' own run keeps going until it is cancelled.
    speech.answerFor("index", {
      kind: "fail",
      code: 1,
      stderr: "whisper-cli: stand-in, not this test",
    });
    speech.answerFor("captions", { kind: "hold" });
    await qa.openProject("sweep_qa_chip");
    const ref = await attachSpoken(qa);
    await placeSpoken(qa, ref);

    let told: Record<string, unknown> = {};
    qa.server.script(
      callTools([{ name: "add_captions", arguments: { language: "en" } }]),
      (round: Round) => {
        told = resultOf(round, "add_captions");
        return say("Stopped, as you asked.");
      },
    );
    await qa.send("Add captions");
    await expect
      .poll(() => speech.running().filter((l) => l.meta.purpose === "captions").length, {
        timeout: 60_000,
      })
      .toBe(1);
    const shown = startTimer(inBrowser("speech chip appears for a long transcription"));
    const chip = qa.page.getByTestId("speech-chip");
    await expect(chip).toBeVisible({ timeout: 40_000 });
    shown.stop();
    await expect(chip).toContainText(/Transcrib/);

    await chip.click();
    const popover = qa.page.getByTestId("speech-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Captions:");
    await expect(popover).toContainText("spoken_scenes.mp4");
    const cancelled = startTimer(inBrowser("Cancel on the speech chip to the assistant's answer"));
    await popover.getByRole("button", { name: "Cancel" }).click();
    await expect(qa.reply("Stopped, as you asked.")).toBeVisible({ timeout: 60_000 });
    cancelled.stop();
    await qa.idle();

    // The captions run was really stopped, and the assistant was told so, in words that say it was the person.
    expect(speech.launches.filter((l) => l.meta.purpose === "captions" && l.killed)).toHaveLength(
      1,
    );
    expect(told.ok, JSON.stringify(told)).toBe(false);
    expect(told.reason, JSON.stringify(told)).toBe("cancelled");
    expect(String(told.error)).toMatch(/NOT added/);
    expect(captionsOf(await qa.savedTimeline())).toHaveLength(0);
    await expect(chip).toContainText(/stopped/i, { timeout: 10_000 });
  });

  test("a background transcription that fails says so in the status bar, with the reason; Retry runs it again and the failure goes", async ({
    qa,
  }) => {
    const speech = await SpeechStandIn.install(qa);
    speech.answer({ kind: "fail", code: 1, stderr: "whisper-cli: failed to read audio" });
    await qa.openProject("sweep_qa_bgfail");
    // Importing a clip is enough: the app transcribes imported media in the background.
    await attachSpoken(qa);
    await expect
      .poll(() => speech.launches.filter((l) => l.state === "exited").length, { timeout: 90_000 })
      .toBeGreaterThan(0);
    const failure = qa.page.getByTestId("speech-failure");
    await expect(failure).toBeVisible({ timeout: 30_000 });
    await expect(failure).toContainText("Transcription failed: spoken_scenes.mp4");
    await qa.page.getByTestId("speech-failure-headline").click();
    const tip = qa.page.getByTestId("speech-failure-tip");
    await expect(tip).toContainText("The speech engine failed on this file.");
    await expect(tip).toContainText("failed to read audio");

    const runs = speech.launches.length;
    await qa.page.getByRole("button", { name: "Retry transcription" }).click();
    await expect.poll(() => speech.launches.length, { timeout: 60_000 }).toBeGreaterThan(runs);
    await expect(failure).toHaveCount(0, { timeout: 60_000 });
  });
});
