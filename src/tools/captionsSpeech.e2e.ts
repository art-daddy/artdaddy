// The DEFAULT add_captions path: real speech -> real whisper -> real caption clips.
//
// Everything else in the caption suite seeds the transcript cache or imports an SRT, so the one
// thing never exercised is whisper actually producing words.
//
// Windows note: whisper.cpp's Windows build is DYNAMIC and ggml resolves its CPU backend by
// scanning the process's own directory, so the DLL dir on PATH is NOT enough (the exe loads,
// then dies on GGML_ASSERT(device)). `TauriCommandRunner` handles this by running whisper-cli
// with `resources/whisper` as its CWD, and `nodeRunner` mirrors that. A harness that diverges
// here reports a product failure that does not exist — this test spent a day looking like a
// bundling bug because of exactly that.
//
// Run with ARTDADDY_SPEECH_WAV set to a spoken-audio file:
//   Add-Type -AssemblyName System.Speech
//   $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
//   $s.SetOutputToWaveFile("$env:TEMP\artdaddy_speech.wav"); $s.Speak("..."); $s.Dispose()
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { addCaptionsTool } from "./captions";
import { getTranscriptTool } from "./transcribe";
import { have, installE2EDocuments, libRef, mkCtx, openE2EDoc, resetE2EDocuments } from "./__e2e";
import { addClipsTool } from "../timeline/placement";
import { ensureTimeline, loadTimeline } from "../timeline/engine";
import type { Clip } from "../timeline/model";

type Rec = Record<string, unknown>;

const SPEECH = process.env.ARTDADDY_SPEECH_WAV ?? "";
const enabled = Boolean(SPEECH) && existsSync(SPEECH);

const dirs: string[] = [];
afterAll(async () => {
  await resetE2EDocuments();
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const textOf = (c: Clip): string =>
  Array.isArray(c.content)
    ? c.content.map((r) => String(r.text)).join(" ")
    : String(c.content ?? "");

describe.skipIf(!enabled)("add_captions transcribes real speech", () => {
  it("turns spoken audio into caption clips carrying real words", async () => {
    installE2EDocuments();
    if (!(await have("ffmpeg"))) return;

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-speech-"));
    dirs.push(dir);
    const ctx = mkCtx(dir);
    await ensureTimeline(ctx.store);
    await openE2EDoc(dir);

    const ref = await libRef(ctx, SPEECH, "audio");
    const placed = (await addClipsTool(
      { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 225 }] },
      ctx,
    )) as Rec;
    expect(placed.ok, JSON.stringify(placed)).toBe(true);

    // get_transcript first: if whisper returns nothing, the caption failure below would be
    // indistinguishable from "the audio was silent".
    const tr = (await getTranscriptTool({}, ctx)) as Rec;
    expect(tr.ok, JSON.stringify(tr).slice(0, 300)).toBe(true);
    expect(Number(tr.word_count), "whisper produced no words").toBeGreaterThan(3);

    const caps = (await addCaptionsTool({ max_words: 4 }, ctx)) as Rec;
    expect(caps.ok, JSON.stringify(caps).slice(0, 300)).toBe(true);
    expect(Number(caps.count)).toBeGreaterThan(0);

    const tl = await loadTimeline(ctx.store);
    const clips = tl.tracks
      .flatMap((t) => t.clips ?? [])
      .filter((c) => c.kind === "text")
      .sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));

    expect(clips.length).toBe(Number(caps.count));
    for (const c of clips) {
      expect(textOf(c).trim().length, "an empty caption reached the timeline").toBeGreaterThan(0);
      expect(textOf(c).split(/\s+/).length, "max_words was not applied").toBeLessThanOrEqual(4);
      expect(Number(c.timeline_out)).toBeGreaterThan(Number(c.timeline_in));
    }
    // Non-overlapping, or the timeline would refuse them.
    for (let i = 1; i < clips.length; i++) {
      expect(Number(clips[i].timeline_in)).toBeGreaterThanOrEqual(
        Number(clips[i - 1].timeline_out),
      );
    }
    // The words spoken were "Hello there. This is a test of the caption system…" — whatever
    // whisper heard, the captions must contain recognisable speech rather than punctuation.
    const all = clips.map(textOf).join(" ").toLowerCase();
    expect(all).toMatch(/[a-z]{3,}/);
    console.log(`[speech] ${clips.length} captions:`, clips.map(textOf).join(" | ").slice(0, 300));
  }, 900_000);
});
