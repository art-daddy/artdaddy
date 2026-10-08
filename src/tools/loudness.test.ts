// The loudness figures are read out of ffmpeg's text. Both fixtures are VERBATIM stderr of the
// shipped ffmpeg (N-127021), captured 2026-10-08 with the pass's own filter chain
// (`ebur128=peak=true:framelog=quiet,volumedetect`): a stereo 1 kHz sine at -23 dBFS (the EBU
// calibration tone, which must read -23.0 LUFS) and digital silence. Each starts at the FIRST
// volumedetect instance, which ffmpeg builds and discards before the run and which prints
// `n_samples: 0`.
import { afterEach, describe, expect, it, vi } from "vitest";

import { CachingMemFs, makeRunner } from "../test/timelineKit";
import type { ClientToolContext } from "./context";
import {
  INLINE_LOUDNESS_MAX_S,
  LOUDNESS_WAIT_MS,
  lookLoudness,
  measureLoudness,
  parseLoudness,
  peekLoudness,
  type Loudness,
} from "./loudness";
import { joinPath, ProjectStoreAccess } from "./store";
import { registerBackgroundTranscriber, type BackgroundLoudness } from "./transcriptQueue";

const TONE = `[Parsed_volumedetect_1 @ 000002c39641e6c0] n_samples: 0
Stream mapping:
  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_s16le (native))
Press [q] to stop, [?] for help
Output #0, null, to 'pipe:':
  Metadata:
    encoder         : Lavf63.7.101
  Stream #0:0: Audio: pcm_s16le, 48000 Hz, stereo, s16, 1536 kb/s
    Metadata:
      encoder         : Lavc63.15.100 pcm_s16le
[Parsed_ebur128_0 @ 000002c396ccfd00] Summary:

  Integrated loudness:
    I:         -23.0 LUFS
    Threshold: -33.0 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -43.0 LUFS
    LRA low:   -23.0 LUFS
    LRA high:  -23.0 LUFS

  True peak:
    Peak:      -23.0 dBFS
[Parsed_volumedetect_1 @ 000002c396cd0080] n_samples: 1920000
[Parsed_volumedetect_1 @ 000002c396cd0080] mean_volume: -26.0 dB
[Parsed_volumedetect_1 @ 000002c396cd0080] max_volume: -23.0 dB
[Parsed_volumedetect_1 @ 000002c396cd0080] histogram_22db: 80000
[out#0/null @ 000002c396372c00] video:0KiB audio:3750KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:00:20.00 bitrate=N/A speed= 379x elapsed=0:00:00.05    
`;

const SILENCE = `[Parsed_volumedetect_1 @ 0000023224ab5dc0] n_samples: 0
Stream mapping:
  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_s16le (native))
Press [q] to stop, [?] for help
[Parsed_ebur128_0 @ 000002322684d180] Summary:

  Integrated loudness:
    I:         -70.0 LUFS
    Threshold:   0.0 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:   0.0 LUFS
    LRA low:     0.0 LUFS
    LRA high:    0.0 LUFS

  True peak:
    Peak:       -inf dBFS
[Parsed_volumedetect_1 @ 000002322684d4c0] n_samples: 1920000
[Parsed_volumedetect_1 @ 000002322684d4c0] mean_volume: -91.0 dB
[Parsed_volumedetect_1 @ 000002322684d4c0] max_volume: -91.0 dB
[Parsed_volumedetect_1 @ 000002322684d4c0] histogram_91db: 1920000
`;

const TONE_FIGURES: Loudness = { integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 };

describe("parseLoudness", () => {
  it("reads the calibration tone as the standard says it must read", () => {
    expect(parseLoudness(TONE)).toEqual(TONE_FIGURES);
  });

  it("reads the Summary, never a running per-frame I: printed before it", () => {
    // Without framelog=quiet ebur128 prints a running I: per 100 ms; it must never win.
    const running =
      "[Parsed_ebur128_0 @ 0] t: 19.9 TARGET:-23 LUFS    M: -41.2 S: -41.2     I: -41.2 LUFS       LRA:   0.0 LU  TPK: -41.2 -41.2 dBFS\n";
    expect(parseLoudness(running + TONE).integrated_lufs).toBe(-23);
  });

  it("reads the RMS of the volumedetect that saw the samples, the last one printed", () => {
    const earlier = TONE.replace(
      "n_samples: 0\n",
      "n_samples: 0\n[Parsed_volumedetect_1 @ 0] mean_volume: -50.0 dB\n",
    );
    expect(parseLoudness(earlier).rms_dbfs).toBe(-26);
  });

  it("reports silence as ffmpeg's -70 floor and no peak or RMS, not as zero", () => {
    expect(parseLoudness(SILENCE)).toEqual({
      integrated_lufs: -70,
      true_peak_dbtp: null,
      rms_dbfs: null,
    });
  });

  // A master driven past full scale reads ABOVE zero, which ffmpeg prints without a sign. Verbatim,
  // a full-scale 12 kHz tone whose samples miss its peaks (shipped ffmpeg, 2026-10-08).
  it("reads loudness and a true peak above full scale, which carry no sign", () => {
    const HOT = `[Parsed_ebur128_0 @ 0000021d1080ed00] Summary:

  Integrated loudness:
    I:           6.4 LUFS
    Threshold:  -3.6 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -13.6 LUFS
    LRA low:     6.4 LUFS
    LRA high:    6.4 LUFS

  True peak:
    Peak:        3.6 dBFS
[Parsed_volumedetect_1 @ 0000021d1080f080] n_samples: 480000
[Parsed_volumedetect_1 @ 0000021d1080f080] mean_volume: -0.0 dB
[Parsed_volumedetect_1 @ 0000021d1080f080] max_volume: 0.0 dB
[Parsed_volumedetect_1 @ 0000021d1080f080] histogram_0db: 480000
`;
    const hot = parseLoudness(HOT);
    expect(hot).toEqual({ integrated_lufs: 6.4, true_peak_dbtp: 3.6, rms_dbfs: 0 });
    expect(parseLoudness(HOT.replace("mean_volume: -0.0 dB", "mean_volume: 0.0 dB")).rms_dbfs).toBe(
      0,
    );
  });

  // volumedetect measures in 16 bits: -91.0 is its floor, printed for silence and for anything
  // under about -90 dBFS. Just above the floor is a real, very quiet level.
  it("reads -91.0 dB as silent, and anything above it as a level", () => {
    const at = (db: string): number | null =>
      parseLoudness(TONE.replace("mean_volume: -26.0 dB", `mean_volume: ${db} dB`)).rms_dbfs;
    expect(at("-91.0")).toBeNull();
    expect(at("-90.9")).toBe(-90.9);
    expect(at("-inf")).toBeNull();
  });

  it("returns nulls, never invented figures, when the text has none", () => {
    expect(parseLoudness("Output file is empty, nothing was encoded")).toEqual({
      integrated_lufs: null,
      true_peak_dbtp: null,
      rms_dbfs: null,
    });
  });
});

// 4f: a span of a file is measured once, in any project. Asserted by how often ffmpeg is asked.
describe("measureLoudness keeps what it measured, by file and span", () => {
  const A = "C:/data/projects/a";
  const B = "C:/data/projects/b";
  const setup = () => {
    const fs = new CachingMemFs();
    let answer = { code: 0, stdout: "", stderr: TONE };
    const calls: string[][] = [];
    const runner = makeRunner((program, args) => {
      if (program === "ffmpeg") calls.push(args);
      return answer;
    });
    const ctxIn = (dir: string): ClientToolContext => ({
      store: new ProjectStoreAccess(dir, fs),
      runner,
    });
    return {
      fs,
      ctxIn,
      measured: () => calls.length,
      fail: () => (answer = { code: 1, stdout: "", stderr: "boom" }),
      heal: () => (answer = { code: 0, stdout: "", stderr: TONE }),
    };
  };
  /** The same media copied into a project; returns where it lies. */
  const copiedInto = async (fs: CachingMemFs, dir: string, contents = "bytes"): Promise<string> => {
    await fs.writeTextFile(
      joinPath(dir, "internals/library.json"),
      JSON.stringify({ clips: [{ id: "media_abc", path: "library/media_abc.wav" }] }),
    );
    const abs = joinPath(dir, "library/media_abc.wav");
    await fs.writeTextFile(abs, contents);
    return abs;
  };

  it("measures a span of a file once, whichever project asks", async () => {
    const { fs, ctxIn, measured } = setup();
    const inA = await copiedInto(fs, A);
    const inB = await copiedInto(fs, B);
    const first = await measureLoudness(ctxIn(A), inA, 0, 20);
    expect(first).toEqual({ integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 });
    expect(await measureLoudness(ctxIn(B), inB, 0, 20)).toEqual(first);
    expect(measured()).toBe(1);
  });

  it("measures another span, or the same span of other bytes, again", async () => {
    const { fs, ctxIn, measured } = setup();
    const abs = await copiedInto(fs, A);
    await measureLoudness(ctxIn(A), abs, 0, 20);
    await measureLoudness(ctxIn(A), abs, 5, 20);
    await measureLoudness(ctxIn(A), abs, null, null);
    expect(measured()).toBe(3);
    // The whole file, however it is written: from 0 or from nothing, to the end.
    await measureLoudness(ctxIn(A), abs, 0, null);
    expect(measured()).toBe(3);
    await copiedInto(fs, A, "other bytes"); // imported again over it: another size
    await measureLoudness(ctxIn(A), abs, 0, 20);
    expect(measured()).toBe(4);
  });

  it("keeps no failure: the next ask measures again", async () => {
    const { fs, ctxIn, measured, fail, heal } = setup();
    const abs = await copiedInto(fs, A);
    fail();
    expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toEqual({
      error: expect.stringContaining("boom"), // ffmpeg's own reason
    });
    heal();
    expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toHaveProperty("integrated_lufs", -23);
    expect(measured()).toBe(2);
  });

  it("says a stopped run was cancelled, and keeps nothing from it", async () => {
    const { fs, ctxIn, measured, fail, heal } = setup();
    const abs = await copiedInto(fs, A);
    const stop = new AbortController();
    stop.abort();
    fail();
    expect(await measureLoudness({ ...ctxIn(A), signal: stop.signal }, abs, 0, 20)).toEqual({
      error: "cancelled",
    });
    heal();
    expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toEqual(TONE_FIGURES);
    expect(measured()).toBe(2);
  });

  // An error only when NOTHING could be read: silence has no RMS and is still an answer.
  it("answers with what it could read, and is an error only when it read nothing", async () => {
    const { fs, ctxIn } = setup();
    const abs = await copiedInto(fs, A);
    let span = 0; // a span of its own each time, so nothing is answered from the cache
    const answer = async (stderr: string): Promise<unknown> => {
      const runner = makeRunner(() => ({ code: 0, stdout: "", stderr }));
      span += 1;
      return measureLoudness({ ...ctxIn(A), runner }, abs, span, span + 1);
    };
    expect(await answer(SILENCE)).toEqual({
      integrated_lufs: -70,
      true_peak_dbtp: null,
      rms_dbfs: null,
    });
    const rmsOnly = TONE.slice(TONE.indexOf("[Parsed_volumedetect_1 @ 000002c396cd0080]"));
    expect(await answer(rmsOnly)).toEqual({
      integrated_lufs: null,
      true_peak_dbtp: null,
      rms_dbfs: -26,
    });
    expect(await answer("Output file is empty, nothing was encoded")).toEqual({
      error: expect.stringContaining("could not be read"),
    });
  });

  // A file with no identity (no size or time to key it by) shares nothing with another one.
  it("measures every time a file has no identity to keep it under", async () => {
    const { fs, ctxIn, measured } = setup();
    const abs = await copiedInto(fs, A);
    Object.assign(fs, { stat: undefined });
    for (let i = 0; i < 2; i++)
      expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toEqual(TONE_FIGURES);
    expect(measured()).toBe(2);
  });

  it("measures again when what it finds kept is not a loudness", async () => {
    const { fs, ctxIn, measured } = setup();
    const abs = await copiedInto(fs, A);
    await measureLoudness(ctxIn(A), abs, 0, 20);
    const [entry] = [...fs.files.keys()].filter((p) => p.startsWith("C:/cache/app/loudness/"));
    const kept = JSON.parse(fs.files.get(entry)!) as { key: string };
    for (const value of ["-23 LUFS", { lufs: -23 }]) {
      fs.files.set(entry, JSON.stringify({ key: kept.key, value }));
      expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toHaveProperty("integrated_lufs", -23);
    }
    expect(measured()).toBe(3);
  });

  // A disk with no app cache (a test fake, a platform without one) measures every time, and works.
  it("measures every time where there is no cache to keep it in", async () => {
    const { fs, ctxIn, measured } = setup();
    const abs = await copiedInto(fs, A);
    Object.assign(fs, { cacheDir: undefined });
    for (let i = 0; i < 2; i++)
      expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toHaveProperty("integrated_lufs", -23);
    expect(measured()).toBe(2);
  });

  // 4g: the RMS kept by the astats measurement is not the one measured now.
  it("never answers from an entry the previous measurement (v1) kept", async () => {
    const { fs, ctxIn, measured } = setup();
    const abs = await copiedInto(fs, A);
    const store = new ProjectStoreAccess(A, fs);
    const old = { integrated_lufs: -99, true_peak_dbtp: -99, rms_dbfs: -99 };
    await (await store.appCache())!.put(
      "loudness",
      `loudness:v1:${await store.fileIdentity(abs)}:0-20.000`,
      old,
    );
    expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toEqual(TONE_FIGURES);
    expect(measured()).toBe(1);
  });

  it("peekLoudness answers only from what is kept, and never measures", async () => {
    const { fs, ctxIn, measured } = setup();
    const abs = await copiedInto(fs, A);
    const inB = await copiedInto(fs, B);
    expect(await peekLoudness(ctxIn(A), abs, null, null)).toBeNull();
    await measureLoudness(ctxIn(A), abs, null, null);
    expect(await peekLoudness(ctxIn(B), inB, null, null)).toEqual(TONE_FIGURES);
    expect(await peekLoudness(ctxIn(A), abs, 0, 20)).toBeNull(); // another span
    expect(measured()).toBe(1);
  });
});

// Owner decision 2026-10-04: a span of up to 10 minutes is measured on its first look; a longer one
// is measured in the background and answers "in progress" once.
describe("lookLoudness", () => {
  const DIR = "C:/data/projects/a";
  const unregister: Array<() => void> = [];
  afterEach(() => {
    for (const u of unregister.splice(0)) u();
    vi.useRealTimers();
  });
  const never = new Promise<never>(() => undefined);

  /** A project holding one file; `bg` answers its background measurer, when it has one. */
  async function project(bg?: () => BackgroundLoudness | null) {
    const fs = new CachingMemFs();
    let ffmpeg = 0;
    const runner = makeRunner((program) => {
      if (program === "ffmpeg") ffmpeg++;
      return { code: 0, stdout: "", stderr: TONE };
    });
    const ctx: ClientToolContext = { store: new ProjectStoreAccess(DIR, fs), runner };
    await fs.writeTextFile(
      joinPath(DIR, "internals/library.json"),
      JSON.stringify({ clips: [{ id: "media_abc", path: "library/media_abc.wav" }] }),
    );
    const abs = joinPath(DIR, "library/media_abc.wav");
    await fs.writeTextFile(abs, "bytes");
    const asked: Array<[string, number | null, number | null]> = [];
    if (bg)
      unregister.push(
        registerBackgroundTranscriber(DIR, {
          prioritize: () => true,
          loudness: (source, start, end) => (asked.push([source, start, end]), bg()),
        }),
      );
    return { ctx, abs, asked, measured: () => ffmpeg };
  }

  it("answers a kept span at once, however long it is", async () => {
    const { ctx, abs, asked, measured } = await project(() => ({ first: true, result: never }));
    await measureLoudness(ctx, abs, null, null);
    expect(await lookLoudness(ctx, abs, null, null, 3 * 3600)).toEqual(TONE_FIGURES);
    expect([measured(), asked.length]).toEqual([1, 0]);
  });

  it("measures a span of up to 10 minutes now, and nothing longer", async () => {
    const { ctx, abs, asked, measured } = await project(() => ({ first: true, result: never }));
    expect(await lookLoudness(ctx, abs, 0, INLINE_LOUDNESS_MAX_S, INLINE_LOUDNESS_MAX_S)).toEqual(
      TONE_FIGURES,
    );
    expect([measured(), asked.length]).toEqual([1, 0]);
    const over = INLINE_LOUDNESS_MAX_S + 0.5;
    expect(await lookLoudness(ctx, abs, 5, 5 + over, over)).toHaveProperty("status", "in_progress");
    expect(measured()).toBe(1);
  });

  it("hands a longer span to the background and says so, without measuring", async () => {
    const { ctx, abs, asked, measured } = await project(() => ({ first: true, result: never }));
    const r = (await lookLoudness(ctx, abs, null, null, 1800)) as { status: string; note: string };
    expect(r.status).toBe("in_progress");
    expect(r.note).toMatch(/30 minutes of audio/);
    expect(r.note).toMatch(/again/);
    expect(r.note).toMatch(/10 minutes/);
    expect(asked).toEqual([[abs, null, null]]);
    expect(measured()).toBe(0);
  });

  it("treats a span of unknown length as a long one", async () => {
    const { ctx, abs, measured } = await project(() => ({ first: true, result: never }));
    const r = (await lookLoudness(ctx, abs, null, null, null)) as { status: string; note: string };
    expect(r.status).toBe("in_progress");
    expect(r.note).toMatch(/unknown length/);
    expect(measured()).toBe(0);
  });

  it("says it is unavailable when nothing measures in the background", async () => {
    const { ctx, abs, measured } = await project();
    const r = (await lookLoudness(ctx, abs, null, null, 1800)) as { status: string; note: string };
    expect(r.status).toBe("unavailable");
    expect(r.note).toMatch(/10 minutes/);
    expect(measured()).toBe(0);
  });

  it("a later look waits for the background measurement, and returns it or its error", async () => {
    let result: Promise<Loudness | { error: string }> = Promise.resolve(TONE_FIGURES);
    const { ctx, abs, measured } = await project(() => ({ first: false, result }));
    expect(await lookLoudness(ctx, abs, null, null, 1800)).toEqual(TONE_FIGURES);
    result = Promise.resolve({ error: "loudness could not be measured: boom" });
    expect(await lookLoudness(ctx, abs, null, null, 1800)).toEqual({
      error: "loudness could not be measured: boom",
    });
    expect(measured()).toBe(0);
  });

  it("waits at most LOUDNESS_WAIT_MS, then says in progress again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { ctx, abs, asked } = await project(() => ({ first: false, result: never }));
    let got: unknown = undefined;
    void lookLoudness(ctx, abs, null, null, 1800).then((r) => (got = r));
    while (asked.length === 0) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(LOUDNESS_WAIT_MS - 1);
    expect(got).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toHaveProperty("status", "in_progress");
  });

  it("stops waiting the moment the call is stopped", async () => {
    const { ctx, abs } = await project(() => ({ first: false, result: never }));
    const stop = new AbortController();
    const look = lookLoudness({ ...ctx, signal: stop.signal }, abs, null, null, 1800);
    setTimeout(() => stop.abort(), 5);
    expect(await look).toHaveProperty("status", "in_progress");
    // ...and does not start waiting when the call was stopped before it got there.
    expect(
      await lookLoudness({ ...ctx, signal: stop.signal }, abs, null, null, 1800),
    ).toHaveProperty("status", "in_progress");
  });
});
