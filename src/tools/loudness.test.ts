// The loudness figures are read out of ffmpeg's text. Both fixtures are VERBATIM output of the
// shipped ffmpeg (N-126655), captured 2026-10-03: a stereo 1 kHz sine at -23 dBFS (the EBU
// calibration tone, which must read -23.0 LUFS) and digital silence (where ffmpeg prints -inf).
import { describe, expect, it } from "vitest";

import { CachingMemFs, makeRunner } from "../test/timelineKit";
import type { ClientToolContext } from "./context";
import { measureLoudness, parseLoudness } from "./loudness";
import { joinPath, ProjectStoreAccess } from "./store";

const TONE = `[Parsed_ebur128_0 @ 000002271] t: 19.9 TARGET:-23 LUFS    M: -23.0 S: -23.0     I: -23.0 LUFS       LRA:   0.0 LU  TPK: -23.0 -23.0 dBFS
[Parsed_ebur128_0 @ 000002271] t: 20 TARGET:-23 LUFS    M: -23.0 S: -23.0     I: -23.0 LUFS       LRA:   0.0 LU  TPK: -23.0 -23.0 dBFS
[Parsed_astats_1 @ 0000022712f89c80] Overall
[Parsed_astats_1 @ 0000022712f89c80] DC offset: 0.000000
[Parsed_astats_1 @ 0000022712f89c80] Min level: -0.070801
[Parsed_astats_1 @ 0000022712f89c80] Max level: 0.070801
[Parsed_astats_1 @ 0000022712f89c80] Peak level dB: -22.999239
[Parsed_astats_1 @ 0000022712f89c80] RMS level dB: -26.010573
[Parsed_astats_1 @ 0000022712f89c80] RMS peak dB: -26.003704
[Parsed_ebur128_0 @ 000002271] Summary:

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
`;

const SILENCE = `[Parsed_ebur128_0 @ 0000022d9834] Summary:

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
[Parsed_astats_1 @ 0000022d9834d400] Overall
[Parsed_astats_1 @ 0000022d9834d400] DC offset: 0.000000
[Parsed_astats_1 @ 0000022d9834d400] Min level: 0.000000
[Parsed_astats_1 @ 0000022d9834d400] Peak level dB: -inf
[Parsed_astats_1 @ 0000022d9834d400] RMS level dB: -inf
`;

describe("parseLoudness", () => {
  it("reads the calibration tone as the standard says it must read", () => {
    expect(parseLoudness(TONE)).toEqual({
      integrated_lufs: -23,
      true_peak_dbtp: -23,
      rms_dbfs: -26,
    });
  });

  it("reads the Summary, never a running per-frame I: printed before it", () => {
    // A running value that differs from the summary must not win, whichever comes first.
    const early = TONE.replace("I: -23.0 LUFS       LRA", "I: -41.2 LUFS       LRA");
    expect(parseLoudness(early).integrated_lufs).toBe(-23);
  });

  it("reports silence as ffmpeg's -70 floor and no peak or RMS, not as zero", () => {
    expect(parseLoudness(SILENCE)).toEqual({
      integrated_lufs: -70,
      true_peak_dbtp: null,
      rms_dbfs: null,
    });
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
    expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toHaveProperty("error");
    heal();
    expect(await measureLoudness(ctxIn(A), abs, 0, 20)).toHaveProperty("integrated_lufs", -23);
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
});
