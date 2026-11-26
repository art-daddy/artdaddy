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
// One command runs it on the committed recording (art-daddy/backlog#83):
//   npm run smoke:speech
// It speaks src/tools/__fixtures__/speech/spoken.ogg (Windows' own voice reading a known script,
// scripts/genSpeechFixture.ps1) through the shipped whisper-cli and the speech model already on the
// PC, and holds the captions to spoken.words.json: the words, in order, each on screen while it is
// spoken. It never downloads a model and refuses the network; with no engine or model it FAILS.
//
// Or with ARTDADDY_SPEECH_WAV set to any spoken-audio file (a <name>.words.json beside it adds the
// word checks):
//   Add-Type -AssemblyName System.Speech
//   $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
//   $s.SetOutputToWaveFile("$env:TEMP\artdaddy_speech.wav"); $s.Speak("..."); $s.Dispose()
import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { addCaptionsTool } from "./captions";
import type { ClientToolContext } from "./context";
import { ensureTranscript, getTranscriptTool, whisperModelPath } from "./transcribe";
import {
  have,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  openE2EDoc,
  resetE2EDocuments,
} from "./__e2e";
import { shippedSidecar } from "../test/sidecars";
import { addClipsTool } from "../timeline/placement";
import { ensureTimeline, loadTimeline } from "../timeline/engine";
import type { Clip } from "../timeline/model";
import { clipText } from "../timeline/shape";

type Rec = Record<string, unknown>;

const SPEECH = process.env.ARTDADDY_SPEECH_WAV ?? "";
const enabled = Boolean(SPEECH) && existsSync(SPEECH);

/** What the speaker said, word by word, and when each word starts (seconds into the file). */
interface Spoken {
  voice: string;
  text: string;
  words: Array<{ word: string; start: number }>;
}
const SPOKEN_FILE = SPEECH.replace(/\.[^./\\]+$/, ".words.json");
const spoken: Spoken | null =
  enabled && existsSync(SPOKEN_FILE)
    ? (JSON.parse(readFileSync(SPOKEN_FILE, "utf8")) as Spoken)
    : null;

const dirs: string[] = [];
// Nothing here may reach a network: the model is already on the PC, or the lane fails.
beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("no network in the speech lane");
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await resetE2EDocuments();
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const textOf = (c: Clip): string =>
  Array.isArray(c.content)
    ? c.content.map((r) => String(r.text)).join(" ")
    : String(c.content ?? "");

describe.skipIf(!enabled)(
  "the speech lane has what it needs (it fails, never skips, without)",
  () => {
    it("the shipped ffmpeg and whisper-cli, and the speech model already on this PC", async () => {
      expect(await have("ffmpeg"), "the shipped ffmpeg (npm run fetch:sidecars)").toBe(true);
      expect(
        shippedSidecar("whisper-cli"),
        "the shipped whisper-cli (npm run fetch:sidecars)",
      ).toBeTruthy();
      // Where the app looks for it from a project the tests make in the temp folder.
      const model = whisperModelPath(path.join(os.tmpdir(), "artdaddy-speech-probe"), "small");
      expect(
        existsSync(model),
        `the speech model is not at ${model}; this lane never downloads it`,
      ).toBe(true);
    });
  },
);

describe.skipIf(!enabled)("add_captions transcribes real speech", () => {
  it("turns spoken audio into caption clips carrying real words", async () => {
    installE2EDocuments();
    expect(await have("ffmpeg"), "the shipped ffmpeg").toBe(true);

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

  // 4f, end to end with real whisper: the transcript is kept by FILE in the app cache, outside
  // every project, so a second project with the same file reads it and whisper does not run.
  it("transcribes a file once for every project that uses it, and keeps it outside both", async () => {
    installE2EDocuments();
    expect(await have("ffmpeg"), "the shipped ffmpeg").toBe(true);
    let whisperRuns = 0;
    const counted = (dir: string): ClientToolContext => {
      const base = mkCtx(dir);
      return {
        ...base,
        // A whole file's transcript is the background indexer's to make (S2-02).
        background: true,
        runner: {
          run: (program, ...rest) => {
            if (program === "whisper-cli") whisperRuns += 1;
            return base.runner.run(program, ...rest);
          },
        },
      };
    };
    const [a, b] = await Promise.all(
      ["a", "b"].map((n) => fsp.mkdtemp(path.join(os.tmpdir(), `artdaddy-speech-${n}-`))),
    );
    dirs.push(a, b);
    const inA = counted(a);
    const inB = counted(b);
    const refA = await libRef(inA, SPEECH, "audio");
    const refB = await libRef(inB, SPEECH, "audio");
    expect(refB, "the same bytes are the same media in both projects").toBe(refA);

    const first = await ensureTranscript(inA, refA);
    expect(first.parsed.words.length, "whisper produced no words").toBeGreaterThan(3);
    const runs = whisperRuns;
    const second = await ensureTranscript(inB, refB);
    expect(second.existed).toBe(true);
    expect(whisperRuns, "the second project ran whisper again").toBe(runs);
    expect(second.parsed.words.map((w) => w.word)).toEqual(first.parsed.words.map((w) => w.word));

    // The artifact, not the call: whisper's output is in the app cache folder, in neither project.
    const kept = await fsp.readdir(path.join(await nodeFs.cacheDir!(), "transcripts"));
    expect(kept.length).toBeGreaterThan(0);
    for (const dir of [a, b])
      expect(existsSync(path.join(dir, "internals", "cache", "transcripts"))).toBe(false);
  }, 900_000);
});

/** A word as a person reads it: lower case, without the punctuation around it. */
const plain = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** The longest run of words two lists share in order, as index pairs (said, shown). */
function sharedInOrder(said: string[], shown: string[]): Array<[number, number]> {
  const n = said.length;
  const m = shown.length;
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      best[i][j] =
        said[i] === shown[j] ? best[i + 1][j + 1] + 1 : Math.max(best[i + 1][j], best[i][j + 1]);
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (said[i] === shown[j]) pairs.push([i++, j++]);
    else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Words wrong, missing or added, as a share of the words said (the word error rate). */
function wordErrorRate(said: string[], shown: string[]): number {
  let row = Array.from({ length: shown.length + 1 }, (_, j) => j);
  for (let i = 1; i <= said.length; i++) {
    const next = [i];
    for (let j = 1; j <= shown.length; j++)
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + (said[i - 1] === shown[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[shown.length] / said.length;
}

/** How far a word may be said outside its caption's time on screen and still read as on time: a frame
 *  or two of rounding, and a few tenths of a second either way in the engine's word times. */
const ON_TIME_S = 0.5;
/** Outside this, a caption is plainly wrong: it shows a sentence that is over, or one not yet begun. */
const ROUGHLY_S = 2.5;

describe.skipIf(!spoken)("captions say what was spoken, in order and on time", () => {
  interface Shown {
    word: string;
    from: number;
    to: number;
  }
  let cards: Clip[] = [];
  let said: Array<{ word: string; at: number }> = [];
  let shown: Shown[] = [];
  let pairs: Array<[number, number]> = [];
  /** Each word said and matched, with when it was said and when its caption is on screen. */
  const timing = () =>
    pairs.map(([i, j]) => ({
      word: said[i].word,
      said: said[i].at,
      shown: [shown[j].from, shown[j].to],
    }));
  const offBy = (limit: number) =>
    timing().filter((t) => t.said < t.shown[0] - limit || t.said > t.shown[1] + limit);

  beforeAll(async () => {
    installE2EDocuments();
    expect(await have("ffmpeg"), "the shipped ffmpeg").toBe(true);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-speech-"));
    dirs.push(dir);
    const ctx = mkCtx(dir);
    await ensureTimeline(ctx.store);
    await openE2EDoc(dir);
    // The whole recording on the timeline, captioned the way a person asks for captions: defaults.
    const ref = await libRef(ctx, SPEECH, "audio");
    const placed = (await addClipsTool(
      { entries: [{ media_ref: ref, timeline_in: 0 }] },
      ctx,
    )) as Rec;
    expect(placed.ok, JSON.stringify(placed).slice(0, 300)).toBe(true);
    const caps = (await addCaptionsTool({}, ctx)) as Rec;
    expect(caps.ok, JSON.stringify(caps).slice(0, 300)).toBe(true);

    const tl = await loadTimeline(ctx.store);
    const fps = Number(tl.canvas.fps);
    cards = tl.tracks
      .flatMap((t) => t.clips ?? [])
      .filter((c) => c.kind === "text")
      .sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));
    shown = cards.flatMap((c) =>
      textOf(c)
        .split(/\s+/)
        .map(plain)
        .filter(Boolean)
        .map((word) => ({
          word,
          from: Number(c.timeline_in) / fps,
          to: Number(c.timeline_out) / fps,
        })),
    );
    said = spoken!.words.map((w) => ({ word: plain(w.word), at: w.start }));
    pairs = sharedInOrder(
      said.map((w) => w.word),
      shown.map((w) => w.word),
    );
    console.log(`[speech] ${cards.length} captions: ${cards.map(textOf).join(" | ")}`);
    for (const t of timing())
      console.log(
        `[speech] ${t.word.padEnd(10)} said ${t.said.toFixed(2)} s, on screen ${t.shown[0].toFixed(2)}-${t.shown[1].toFixed(2)} s`,
      );
  }, 900_000);

  it("the captions read the words said, closely enough that a viewer reads the script", () => {
    const wer = wordErrorRate(
      said.map((w) => w.word),
      shown.map((w) => w.word),
    );
    console.log(`[speech] word error rate ${(wer * 100).toFixed(1)}% against "${spoken!.text}"`);
    expect(wer).toBeLessThanOrEqual(0.15);
  });

  it("in the order they were said, one caption at a time", () => {
    expect(pairs.length / said.length, "words matched in order").toBeGreaterThanOrEqual(0.85);
    for (let i = 1; i < cards.length; i++)
      expect(Number(cards[i].timeline_in)).toBeGreaterThanOrEqual(
        Number(cards[i - 1].timeline_out),
      );
  });

  it(`each word is said while its caption is on screen, give or take ${ROUGHLY_S} s`, () => {
    expect(offBy(ROUGHLY_S), "words said far from their caption").toEqual([]);
  });

  // Measured 26 Nov 2026 (art-daddy/backlog#83): every word is read right, but a sentence followed by
  // a pause has its words spread over that pause by the engine's word times (its segment runs on into
  // the quiet), so the captions run late, up to 1.7 s by the end of the sentence. The captions hub's
  // known issues "word ends can hide a pause" (IDEA-SPEECH-SILENCE-001) and the first-word alignment,
  // built but off. Goes red the day the captions keep time with the voice; then it becomes a plain it.
  it.fails(`each word is said while its caption is on screen, give or take ${ON_TIME_S} s`, () => {
    expect(offBy(ON_TIME_S), "words said while their caption was not on screen").toEqual([]);
  });
});

// Speech in other languages (UJ-004). The app left whisper's `-l` out, and whisper-cli's default is
// ENGLISH, not detection: German greetings came back as English, a Hindi clip as
// "[NON-ENGLISH SPEECH]". This asks with NO language, through the transcript door every tool uses,
// and judges what came back: the detected language, real words, and no annotation as a word.
//
// Run with ARTDADDY_SPEECH_NON_EN set to `<file>=<language>` pairs separated by `;`, e.g.
//   $env:ARTDADDY_SPEECH_NON_EN = "C:\clips\hindi.mp4=hi;C:\clips\rede.ogg=de"
const NON_EN = (process.env.ARTDADDY_SPEECH_NON_EN ?? "")
  .split(";")
  .map((pair) => {
    const at = pair.lastIndexOf("=");
    return { file: pair.slice(0, at).trim(), lang: pair.slice(at + 1).trim() };
  })
  .filter((c) => c.file && c.lang && existsSync(c.file));

describe.skipIf(NON_EN.length === 0)("transcribes speech in the language spoken (UJ-004)", () => {
  it.each(NON_EN)(
    "$lang: $file",
    async ({ file, lang }) => {
      installE2EDocuments();
      expect(await have("ffmpeg"), "the shipped ffmpeg").toBe(true);
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-speech-"));
      dirs.push(dir);
      const ctx = mkCtx(dir);
      await ensureTimeline(ctx.store);
      await openE2EDoc(dir);

      const ref = await libRef(ctx, file);
      const { parsed } = await ensureTranscript({ ...ctx, background: true }, ref);
      const words = parsed.words.map((w) => w.word);
      console.log(`[speech ${lang}] detected ${parsed.language}:`, words.join(" ").slice(0, 300));

      expect(parsed.language).toBe(lang);
      expect(words.length, "whisper produced no words").toBeGreaterThan(5);
      expect(
        words.filter((w) => /[[\]()]/.test(w)),
        "an annotation became a word",
      ).toEqual([]);

      // The whole path, to what a viewer reads: captions made from it, with no language given.
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0 }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed).slice(0, 300)).toBe(true);
      const caps = (await addCaptionsTool({}, ctx)) as Rec;
      expect(caps.ok, JSON.stringify(caps).slice(0, 300)).toBe(true);
      const shown = (await loadTimeline(ctx.store)).tracks
        .flatMap((t) => t.clips ?? [])
        .filter((c) => c.kind === "text")
        .map(clipText);
      console.log(`[captions ${lang}] ${shown.length}:`, shown.slice(0, 6).join(" | "));
      expect(shown.length, "no captions").toBeGreaterThan(0);
      // Chinese and Japanese are read with no space between words.
      const cj = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]";
      for (const line of shown) expect(line).not.toMatch(new RegExp(`${cj} ${cj}`, "u"));
    },
    900_000,
  );
});
