// The loudness figures are read out of ffmpeg's text. Both fixtures are VERBATIM output of the
// shipped ffmpeg (N-126655), captured 2026-10-03: a stereo 1 kHz sine at -23 dBFS (the EBU
// calibration tone, which must read -23.0 LUFS) and digital silence (where ffmpeg prints -inf).
import { describe, expect, it } from "vitest";

import { parseLoudness } from "./loudness";

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
