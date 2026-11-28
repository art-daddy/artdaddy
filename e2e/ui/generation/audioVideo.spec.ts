// A video, a voice-over and a music bed, each from the approval bar to the file in the library.
// Each tool has its own answer shape (an MP4 with its index; raw PCM the app wraps as WAV; a WAV the
// app re-muxes with ffmpeg), so each is checked on the bytes it saved. Nothing reaches a vendor.
import { readFileSync } from "node:fs";
import path from "node:path";

import { musicAnswer, videoAnswer, voiceAnswer } from "./lib/genDesk";
import {
  askMusic,
  askVideo,
  askVoiceover,
  MUSIC_PROMPT,
  VIDEO_PROMPT,
  VOICE_TEXT,
} from "./fixtures/replies/generate";
import { plainText } from "../agent-and-models/fixtures/replies/plainText";
import { startTimer } from "../../lib/timing";
import { expect, test, waitName } from "./lib/gen";

/** A real four-second H.264 + AAC MP4, with its index first, as a finished render is. */
const FOUR_SECONDS = readFileSync(
  path.resolve("e2e/ui/generation/fixtures/media/four_seconds.mp4"),
);

test.describe("generating video and audio", () => {
  test.setTimeout(120_000);

  test("a video: the price is for the clip asked for, and the finished MP4 lands as it came", async ({
    qa,
    gen,
  }) => {
    gen.desk.quote.generate_video = 60;
    gen.desk.next("generate_video", { kind: "order", answer: videoAnswer(FOUR_SECONDS) });
    qa.server.script(askVideo(), plainText("The clip is being made."));
    const id = await qa.openProject("sweep_qa_gen_video");
    await qa.send("Make a four second establishing shot of a lighthouse");
    await expect(qa.pane.getByText("Generate a video")).toBeVisible({ timeout: 15_000 });
    await expect(gen.priceLine).toHaveText("Up to 60 credits · you have 488 left", {
      timeout: 10_000,
    });
    // Priced as sent: the default model, four seconds, sound on (the default), and no resolution
    // (none was asked for, so none is sent and the server prices the model's first).
    expect(gen.desk.quotes.map((q) => q.args)).toEqual([
      { backend_id: "veo-3.1-fast-generate-001", duration: 4, generate_audio: true },
    ]);
    await gen.allowButton.click();
    await expect(qa.reply("The clip is being made.")).toBeVisible({ timeout: 20_000 });
    await qa.idle();
    const [call] = gen.desk.calls("generate_video");
    expect((call.body as { args?: unknown }).args).toMatchObject({
      prompt: VIDEO_PROMPT,
      duration: 4,
      aspect_ratio: "16:9",
      generate_audio: true,
      backend_id: "veo-3.1-fast-generate-001",
    });
    const pending = await gen.placeholder(id);
    expect(pending).toMatchObject({ kind: "video", status: "generating", duration_s: 4 });

    qa.server.script(plainText("The establishing shot is in the library."));
    gen.desk.finish();
    const landed = startTimer(waitName("generation", "a finished video into the library"));
    const row = await gen.settled(String(pending.id), id);
    landed.stop();
    expect(row.status).toBeUndefined();
    expect(await gen.fileOf(row)).toEqual(FOUR_SECONDS);
    await expect(qa.reply("The establishing shot is in the library.")).toBeVisible({
      timeout: 20_000,
    });
    await expect(qa.pane.getByText("a 4s video ready", { exact: true })).toBeVisible();
    await expect.poll(() => gen.desk.order().acks, { timeout: 10_000 }).toBe(1);
    expect(gen.desk.calls()).toHaveLength(1);
  });

  test("a voice-over: the price never carries the script, and the audio lands as a WAV of the right length", async ({
    qa,
    gen,
  }) => {
    gen.desk.quote.voiceover = 3;
    gen.desk.next("voiceover", { kind: "inline", answer: voiceAnswer(1.5, 24_000) });
    qa.server.script(askVoiceover(), plainText("Recording the narration."));
    const id = await qa.openProject("sweep_qa_gen_voice");
    await qa.send("Record a short welcome narration");
    await expect(qa.pane.getByText("Generate a voiceover")).toBeVisible({ timeout: 15_000 });
    await expect(gen.priceLine).toHaveText("Up to 3 credits · you have 488 left", {
      timeout: 10_000,
    });
    // The price depends on the script's length only, so only a stand-in of that length is sent.
    const [quote] = gen.desk.quotes;
    expect(quote.args.model).toBe("gemini-3.1-flash-tts-preview");
    expect(String(quote.args.text)).toMatch(/^x+$/);
    expect(String(quote.args.text).length).toBeGreaterThanOrEqual(VOICE_TEXT.length);
    expect(JSON.stringify(gen.desk.quotes)).not.toContain("paper");

    qa.server.script(plainText("The narration is ready."));
    const landed = startTimer(waitName("generation", "Allow to a voice-over in the library"));
    await gen.allowButton.click();
    await expect(qa.reply("Recording the narration.")).toBeVisible({ timeout: 20_000 });
    const row = await gen.settled(String((await gen.placeholder(id)).id), id);
    landed.stop();
    expect(row.status).toBeUndefined();
    expect(row).toMatchObject({
      kind: "audio",
      source: { origin: "generated", duration_s: 1.5, sample_rate: 24_000, channels: 1 },
    });
    const wav = (await gen.fileOf(row))!;
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("latin1")).toBe("WAVE");
    expect(wav.length).toBe(44 + 1.5 * 24_000 * 2);
    expect((gen.desk.calls("voiceover")[0].body as { args?: unknown }).args).toMatchObject({
      model: "gemini-3.1-flash-tts-preview",
      voice: "Charon",
    });
    await expect(qa.reply("The narration is ready.")).toBeVisible({ timeout: 20_000 });
  });

  test("a music bed: the app re-muxes what came back with ffmpeg and measures it", async ({
    qa,
    gen,
  }) => {
    gen.desk.quote.music = 6;
    gen.desk.next("music", { kind: "order", answer: musicAnswer(2), ready: true });
    qa.server.script(
      askMusic(),
      plainText("Making a music bed."),
      plainText("The music is ready."),
    );
    const id = await qa.openProject("sweep_qa_gen_music");
    await qa.send("Add some calm guitar music");
    await expect(qa.pane.getByText("Generate music")).toBeVisible({ timeout: 15_000 });
    await expect(gen.priceLine).toHaveText("Up to 6 credits · you have 488 left", {
      timeout: 10_000,
    });
    expect(gen.desk.quotes.map((q) => q.args)).toEqual([{ backend_id: "lyria-002" }]);
    const landed = startTimer(waitName("generation", "Allow to a music bed in the library"));
    await gen.allowButton.click();
    const row = await gen.settled(String((await gen.placeholder(id)).id), id);
    landed.stop();
    expect(row.status).toBeUndefined();
    // Measured by ffprobe on the re-muxed file: two seconds of 48 kHz mono, as sent.
    expect(row).toMatchObject({
      kind: "audio",
      source: { origin: "generated", sample_rate: 48_000, channels: 1 },
    });
    expect(Number((row.source as { duration_s?: number }).duration_s)).toBeCloseTo(2, 1);
    expect((row.source as { prompt?: string }).prompt).toContain(MUSIC_PROMPT);
    const wav = (await gen.fileOf(row))!;
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(qa.shell.sidecarRuns.some((r) => /ffmpeg/.test(r.program) && r.ended?.code === 0)).toBe(
      true,
    );
    await expect(qa.reply("The music is ready.")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => gen.desk.order().acks, { timeout: 10_000 }).toBe(1);
  });
});
