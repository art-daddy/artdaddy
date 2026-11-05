// The encoder an export uses: which maker's graphics chip and what it is told, the processor's faster setting, and the
// one rule that decides between them. Pure: nothing here reads the PC, builds a command or starts anything, so every
// rule is testable without an export. The same table feeds the export's command AND the chip's own test, so the test
// can never prove one set of arguments while the export runs another (exporter document 19.7, I-S4-1).
//
// The graphics chip is the FINAL ENCODER only: the picture is still decoded and composed on the processor.

export const CHIP_MAKERS = ["amd", "nvidia", "intel"] as const;
export type ChipMaker = (typeof CHIP_MAKERS)[number];

/** Which maker's chip is tried first when a PC has more than one (a laptop with an Intel chip and an NVIDIA card). */
export const CHIP_PREFERENCE: readonly ChipMaker[] = ["nvidia", "amd", "intel"];

export type Tier = "high" | "medium" | "low";

/** Every way an export can be encoded, and the key its history (time, memory, size) is kept under: a measurement
 *  made with one encoder never speaks for another. */
export const ENCODER_IDS = [
  "x264-crf",
  "x264-crf-threads2",
  "x264-fast",
  "x264-fast-threads2",
  "chip-amd",
  "chip-nvidia",
  "chip-intel",
] as const;
export type ExportEncoder = (typeof ENCODER_IDS)[number];

export type EncoderKind = "x264" | "x264_fast" | ChipMaker;

export function encoderIdFor(input: { kind: EncoderKind; twoThreads: boolean }): ExportEncoder {
  if (input.kind === "x264") return input.twoThreads ? "x264-crf-threads2" : "x264-crf";
  if (input.kind === "x264_fast") return input.twoThreads ? "x264-fast-threads2" : "x264-fast";
  return `chip-${input.kind}`;
}

/** What each tier stands for on each maker's chip. AMD was measured against x264 CRF 18, 23 and 28 on real footage
 *  (VMAF within one point, files 40 to 46% larger; exporter document 19.7). The other makers could not be measured
 *  here: their numbers err towards higher quality, and the chip's own test refuses a chip that is worse than the
 *  processor by more than a small margin. */
const AMD_QP: Record<Tier, number> = { high: 18, medium: 24, low: 30 };
const NVENC_CQ: Record<Tier, number> = { high: 17, medium: 21, low: 26 };
const QSV_QUALITY: Record<Tier, number> = { high: 17, medium: 21, low: 26 };

interface ChipSpec {
  readonly codec: string;
  /** The layout the encoder takes from ffmpeg's filter graph; the file is 4:2:0 8-bit whichever it is. */
  readonly pixFmt: "yuv420p" | "nv12";
  readonly rate: (tier: Tier) => string[];
}

const CHIPS: Record<ChipMaker, ChipSpec> = {
  amd: {
    codec: "h264_amf",
    pixFmt: "yuv420p",
    rate: (tier) => {
      const qp = String(AMD_QP[tier]);
      return [
        "-usage",
        "transcoding",
        "-quality",
        "quality",
        "-rc",
        "cqp",
        "-qp_i",
        qp,
        "-qp_p",
        qp,
        "-qp_b",
        qp,
      ];
    },
  },
  nvidia: {
    codec: "h264_nvenc",
    pixFmt: "yuv420p",
    rate: (tier) => [
      "-preset",
      "p5",
      "-tune",
      "hq",
      "-rc",
      "vbr",
      "-cq",
      String(NVENC_CQ[tier]),
      "-b:v",
      "0",
    ],
  },
  intel: {
    codec: "h264_qsv",
    pixFmt: "nv12",
    rate: (tier) => ["-global_quality", String(QSV_QUALITY[tier])],
  },
};

/** The video arguments of the chip's final encode: its encoder, its pixel layout and its rate control, as fresh lists. */
export function chipVideoArgs(
  maker: ChipMaker,
  tier: Tier,
): { codec: string; pixFmt: string; rate: string[] } {
  const spec = CHIPS[maker];
  return { codec: spec.codec, pixFmt: spec.pixFmt, rate: spec.rate(tier) };
}

export type SizeClass = "hd" | "uhd";

/** What each size class stands for: the picture and the frame rate the chip's test is run at, and the most a picture may
 *  have to be served by a chip that proved itself there. Every maker's encoder has limits (a longest side, a macroblock
 *  rate, a level) that only a real encode proves; the test runs a 1080 by 1920 picture (class "hd") at 60 frames a second
 *  and a 3840 by 2160 one (class "uhd") at 30 (`chipTest.ts` reads the rate from here, and a test pins them equal), so a
 *  picture beyond those bounds is served by the processor, not by a chip nobody asked about it. 1080p at 60 is within what
 *  every H.264 hardware encoder does (level 4.2); 4K at 60 is not (it needs more than level 5.2), and neither is 1080p at
 *  120. */
export const SIZE_CLASS_LIMITS: Record<
  SizeClass,
  { readonly longSide: number; readonly pixels: number; readonly fps: number }
> = {
  hd: { longSide: 1920, pixels: 1920 * 1080, fps: 60 },
  uhd: { longSide: 3840, pixels: 3840 * 2160, fps: 30 },
};

/** The class a delivered picture is tested, and used, in: the smallest whose bounds hold it, or null (the processor). */
export function sizeClassOf(width: number, height: number, fps: number): SizeClass | null {
  if (![width, height, fps].every((value) => Number.isFinite(value) && value > 0)) return null;
  const longSide = Math.max(width, height);
  const pixels = width * height;
  for (const cls of ["hd", "uhd"] as const) {
    const limit = SIZE_CLASS_LIMITS[cls];
    if (longSide <= limit.longSide && pixels <= limit.pixels && fps <= limit.fps) return cls;
  }
  return null;
}

/** An export whose estimate is over this is one the person is better off with the chip for (the owner's rule). */
export const FAST_DEFAULT_SECONDS = 60;
/** The chip is offered only where it saves at least this share of the time. */
export const FAST_MIN_SAVING = 0.25;
/** What the chip does to an export's time when this PC has no measurement of it yet. Cautious: the lab saw 1.5 on a
 *  source that is hard to decode and 3.7 on an ordinary one. A measured export replaces it after the first run. */
export const CHIP_CAUTIOUS_GAIN = 1.5;
/** What the processor's faster setting does to the time (the lab: 2.1 times quicker, about 2.6 VMAF points less). */
export const FASTER_X264_GAIN = 2.1;

export type ModeRequest = "auto" | "full" | "fast";
export type ModeReason = "over_minute" | "person" | "promise_line" | "none";

export interface ChoiceInput {
  /** What the person chose in the Export dialog; "auto" for everyone else (the app's chat, MCP, no row shown). */
  readonly request: ModeRequest;
  /** A chip that passed its test for this picture size, is switched on and is not under suspicion; else null. */
  readonly chip: ChipMaker | null;
  /** The switch for choosing Fast on the person's behalf. */
  readonly chipDefaultOn: boolean;
  /** The switch for the processor's faster setting. */
  readonly fasterX264On: boolean;
  /** The processor's estimate at the person's quality, and whether it is a measurement made on this PC. */
  readonly fullSeconds: number | null;
  readonly fullMeasured: boolean;
  /** The chip's estimate (measured, or the processor's divided by the cautious gain). */
  readonly fastSeconds: number | null;
  readonly durationSeconds: number;
  /** How many times the video's length the product promises to stay within (2 for ordinary HD, 4 for heavy and 4K). */
  readonly promiseMultiple: number;
}

export interface EncoderChoice {
  readonly encoder: EncoderKind;
  /** The processor's `-preset` for the faster setting; absent leaves x264 on its own default. */
  readonly preset?: "veryfast";
  /** Whether the Export dialog shows the Mode row at all. */
  readonly showRow: boolean;
  /** What the row starts on. */
  readonly defaultMode: "quality" | "fast";
  readonly reason: ModeReason;
}

/** The one rule. The Export dialog, the app's chat and MCP all read it, so an export gets the same encoder wherever
 *  it was asked for (exporter document 19.7, I-S4-3). */
export function chooseEncoder(input: ChoiceInput): EncoderChoice {
  const full = input.fullSeconds;
  const fast = input.fastSeconds;
  const saves =
    input.chip !== null &&
    full !== null &&
    fast !== null &&
    Number.isFinite(full) &&
    Number.isFinite(fast) &&
    full > 0 &&
    fast >= 0 &&
    fast <= full * (1 - FAST_MIN_SAVING);
  const selectedForThem =
    saves && input.chipDefaultOn && full !== null && full > FAST_DEFAULT_SECONDS;
  const row = {
    showRow: saves,
    defaultMode: selectedForThem ? ("fast" as const) : ("quality" as const),
  };
  const chip = input.chip;

  if (input.request === "full") return { encoder: "x264", reason: "person", ...row };
  if (input.request === "fast") {
    return saves && chip !== null
      ? { encoder: chip, reason: "person", ...row }
      : { encoder: "x264", reason: "none", ...row };
  }
  if (selectedForThem && chip !== null) return { encoder: chip, reason: "over_minute", ...row };

  // No usable chip, and the processor would be slower than the product promises: the faster setting, unless that
  // would take the quality down on a mere guess that is not plainly over the line. And only where the time saved
  // matters: an export that takes a minute or less keeps its quality, however short the video (a two-second video is
  // "over the line" at twelve seconds, and nobody gains from the other eight).
  if (
    chip === null &&
    input.fasterX264On &&
    full !== null &&
    Number.isFinite(full) &&
    full > FAST_DEFAULT_SECONDS &&
    input.durationSeconds > 0 &&
    full > input.durationSeconds * input.promiseMultiple &&
    (input.fullMeasured || full > 2 * input.durationSeconds * input.promiseMultiple)
  )
    return { encoder: "x264_fast", preset: "veryfast", reason: "promise_line", ...row };
  return { encoder: "x264", reason: "none", ...row };
}
