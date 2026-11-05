// The rungs of the exporter's plan (exportPlan.ts) change how many threads an export uses, never what it
// makes. Two things are pinned here:
//   1. FROZEN: the full command of the normal rung is exactly what it was before rungs existed (hashes taken
//      from the code before the change; never regenerate them to make a test pass).
//   2. What each gentler rung changes in a command, input by input.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildRenderCommand } from "./render";
import type { Timeline } from "./model";
import type { Rung } from "./exportPlan";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function tl(clips: Any[], canvas = { width: 1920, height: 1080, fps: 30 }): Timeline {
  const tracks: Any[] = [];
  clips.forEach((c, i) =>
    tracks.push({
      id: c.kind === "audio" ? `a${i}` : `v${i}`,
      kind: c.kind ?? "video",
      z: i,
      clips: [c],
    }),
  );
  return { canvas, tracks } as Timeline;
}

const video = (index: number, extra: Partial<Any> = {}): Any => ({
  media_ref: `/v${index}.mp4`,
  kind: "video",
  source_in: 0,
  source_out: 4,
  timeline_in: 0,
  timeline_out: 4,
  ...extra,
});
const sound: Any = {
  media_ref: "/a.mp3",
  kind: "audio",
  source_in: 0,
  source_out: 4,
  timeline_in: 0,
  timeline_out: 4,
};

/** The projects whose commands are frozen: one-pass with few, several and many video inputs, with sound,
 *  the streamed engine on a 4K canvas, and the presets. The Fast mode is below. */
const PROJECTS: Record<string, { timeline: () => Timeline; options: Any }> = {
  one: { timeline: () => tl([video(0)]), options: {} },
  one_with_sound: { timeline: () => tl([video(0), sound]), options: {} },
  three: { timeline: () => tl([video(0), video(1), video(2)]), options: {} },
  thirteen: {
    timeline: () => tl(Array.from({ length: 13 }, (_, index) => video(index))),
    options: {},
  },
  streamed_4k: {
    timeline: () => tl([video(0), video(1)], { width: 3840, height: 2160, fps: 30 }),
    options: { engine: "partition-pipes-v1" },
  },
  streamed_1080: {
    timeline: () => tl([video(0), video(1)]),
    options: { engine: "partition-pipes-v1" },
  },
  // RETIRED GOLDEN (Phase 3, S4). This case used to be `{ mode: "fast" }` with the hash 7e102996…fa14: the
  // developer-only Fast (h264_amf at a fixed qp 18) that only a debug build on one AMD chip could reach. That code path
  // is gone: Fast now names the chip it runs on, so `mode: "fast"` with no chip is the processor's own command, exactly
  // as Full is. The case stays so that this stays true, and its frozen value is the one of `one` below, not a new number.
  fast_without_a_chip: { timeline: () => tl([video(0)]), options: { mode: "fast" } },
  presets: { timeline: () => tl([video(0)]), options: { resolution: "720p", quality: "low" } },
  // The chip's and the faster setting's commands: new in S4, so there is no earlier command to freeze. They are pinned
  // by hand-written expectations below (the arguments themselves), and these hashes only keep them from drifting after.
  chip_amd_medium: {
    timeline: () => tl([video(0)]),
    options: { mode: "fast", chip: "amd", quality: "medium" },
  },
  chip_amd_high: {
    timeline: () => tl([video(0)]),
    options: { mode: "fast", chip: "amd", quality: "high" },
  },
  chip_amd_low: {
    timeline: () => tl([video(0)]),
    options: { mode: "fast", chip: "amd", quality: "low" },
  },
  chip_nvidia_medium: {
    timeline: () => tl([video(0)]),
    options: { mode: "fast", chip: "nvidia", quality: "medium" },
  },
  chip_intel_medium: {
    timeline: () => tl([video(0)]),
    options: { mode: "fast", chip: "intel", quality: "medium" },
  },
  faster_x264: {
    timeline: () => tl([video(0)]),
    options: { faster: true, quality: "medium" },
  },
};

const sha = (args: string[]): string =>
  createHash("sha256").update(JSON.stringify(args)).digest("hex");

const FROZEN: Record<string, string> = {
  one: "93fb5e32c2232778598288575a18b31d2bc70f1ab0c8ceb581f9140569e76365",
  one_with_sound: "2e6cb11abc8042a5d628e0e7387f695112e9680170fe8d6ac23de263cbef452a",
  three: "bbaefd66894dd5b8bbf734e52d4d49b9c6b0b06639edf66f73be888a0808d491",
  thirteen: "23bb9c47cd9031b2d73c6138e66b1855426c5d090e51887f6740d1b012a5baaf",
  streamed_4k: "dc06c44f369ccec20c734639cddbc4faea50bb669301b384750bb4d7e30ef17c",
  streamed_1080: "fc12ef575a26b5f26037dbfa909e9023edf536fad57af475470c9eba9f957449",
  // The same literal as `one`: Fast with no chip IS the processor's command.
  fast_without_a_chip: "93fb5e32c2232778598288575a18b31d2bc70f1ab0c8ceb581f9140569e76365",
  presets: "09afe6cf424a82066cb7861744be4bd70c2329509578c71a1e871974c3e6ea8f",
};

describe("the normal rung is today's command, byte for byte", () => {
  for (const [name, project] of Object.entries(PROJECTS)) {
    if (!(name in FROZEN)) continue; // the chip's and the faster setting's commands are pinned below
    it(`${name}: with no rung, and with rung 0 spelled out`, () => {
      const plain = buildRenderCommand(project.timeline(), "/out.mp4", project.options);
      const spelled = buildRenderCommand(project.timeline(), "/out.mp4", {
        ...project.options,
        rung: 0 as Rung,
      });
      expect(sha(plain.args)).toBe(FROZEN[name]);
      expect(spelled.args).toEqual(plain.args);
    });
  }
});

/** Everything from the encoder's name to the audio choice: what the encoder is asked to do. */
function encoderSection(args: string[]): string[] {
  const from = args.lastIndexOf("-c:v");
  const to = args.findIndex((arg, index) => index > from && (arg === "-an" || arg === "-c:a"));
  return args.slice(from, to);
}

// Phase 3, S4. The commands of the graphics chip and of the faster setting are NEW, so there is no earlier command to
// freeze: each is written out by hand here, from the lab (AMD qp 18, 24, 30 for High, Medium, Low) and the vendors'
// documented constant-quality modes, and the test proves the encoder is the ONLY thing that moved.
describe("the commands of the graphics chip and the faster setting", () => {
  const SECTIONS: Record<string, string[]> = {
    chip_amd_medium: [
      "-c:v",
      "h264_amf",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-usage",
      "transcoding",
      "-quality",
      "quality",
      "-rc",
      "cqp",
      "-qp_i",
      "24",
      "-qp_p",
      "24",
      "-qp_b",
      "24",
    ],
    chip_amd_high: [
      "-c:v",
      "h264_amf",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-usage",
      "transcoding",
      "-quality",
      "quality",
      "-rc",
      "cqp",
      "-qp_i",
      "18",
      "-qp_p",
      "18",
      "-qp_b",
      "18",
    ],
    chip_amd_low: [
      "-c:v",
      "h264_amf",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-usage",
      "transcoding",
      "-quality",
      "quality",
      "-rc",
      "cqp",
      "-qp_i",
      "30",
      "-qp_p",
      "30",
      "-qp_b",
      "30",
    ],
    chip_nvidia_medium: [
      "-c:v",
      "h264_nvenc",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-preset",
      "p5",
      "-tune",
      "hq",
      "-rc",
      "vbr",
      "-cq",
      "21",
      "-b:v",
      "0",
    ],
    chip_intel_medium: [
      "-c:v",
      "h264_qsv",
      "-pix_fmt",
      "nv12",
      "-r",
      "30",
      "-global_quality",
      "21",
    ],
    faster_x264: [
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-preset",
      "veryfast",
      "-crf",
      "23",
    ],
  };

  for (const [name, section] of Object.entries(SECTIONS)) {
    it(`${name}: asks the encoder for exactly this, and nothing else about the picture moves`, () => {
      const plan = buildRenderCommand(
        PROJECTS[name].timeline(),
        "/out.mp4",
        PROJECTS[name].options,
      );
      expect(encoderSection(plan.args)).toEqual(section);
      const normal = buildRenderCommand(PROJECTS.one.timeline(), "/out.mp4", {});
      const outside = (args: string[]) => {
        const from = args.lastIndexOf("-c:v");
        const to = args.findIndex(
          (arg, index) => index > from && (arg === "-an" || arg === "-c:a"),
        );
        return [...args.slice(0, from), ...args.slice(to)];
      };
      expect(outside(plan.args)).toEqual(outside(normal.args));
      expect(plan.filterComplex).toEqual(normal.filterComplex);
    });
  }

  it("records the encoder each export used under its own id, so a measurement is never mistaken for another's", () => {
    const encoderOf = (name: string) =>
      buildRenderCommand(PROJECTS[name].timeline(), "/out.mp4", PROJECTS[name].options).encoder;
    expect(encoderOf("one")).toBe("x264-crf");
    expect(encoderOf("chip_amd_medium")).toBe("chip-amd");
    expect(encoderOf("chip_nvidia_medium")).toBe("chip-nvidia");
    expect(encoderOf("chip_intel_medium")).toBe("chip-intel");
    expect(encoderOf("faster_x264")).toBe("x264-fast");
    expect(encoderOf("fast_without_a_chip")).toBe("x264-crf");
  });

  it("is never reached by a chip that was not named, whatever else is asked", () => {
    for (const options of [
      { chip: "amd" }, // Full quality asked for: a named chip is not used
      { mode: "quality", chip: "nvidia" },
      { mode: "fast" },
      {},
    ] as Any[]) {
      const plan = buildRenderCommand(PROJECTS.one.timeline(), "/out.mp4", options);
      expect(encoderSection(plan.args)[1], JSON.stringify(options)).toBe("libx264");
    }
  });
});

/** The decoder thread count each video input carries (null: ffmpeg's default), in input order. */
function decoderCounts(args: string[]): Array<number | null> {
  const counts: Array<number | null> = [];
  let start = 0;
  args.forEach((arg, index) => {
    if (arg !== "-i") return;
    if (/^\/v\d+\.mp4$/.test(args[index + 1])) {
      const own = args.slice(start, index);
      const at = own.indexOf("-threads:v");
      counts.push(at >= 0 ? Number(own[at + 1]) : null);
    }
    start = index + 2;
  });
  return counts;
}

/** The encoder's thread count (after `-c:v <codec>`), or null when the command leaves it on the default. */
function encoderThreads(args: string[]): number | null {
  const codec = args.lastIndexOf("-c:v");
  const tail = args.slice(codec);
  const at = tail.indexOf("-threads:v");
  return at >= 0 ? Number(tail[at + 1]) : null;
}

/** Every `-threads:v N` pair removed: what is left is what the export makes. */
function withoutThreads(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "-threads:v") index++;
    else out.push(args[index]);
  }
  return out;
}

const at = (name: string, rung: Rung) =>
  buildRenderCommand(PROJECTS[name].timeline(), "/out.mp4", { ...PROJECTS[name].options, rung });

describe("what a gentler rung changes in a command", () => {
  it("one-pass, few inputs: ffmpeg's default decoder threads become two, then one, and the encoder gets two", () => {
    expect(decoderCounts(at("one", 0).args)).toEqual([null]);
    expect(encoderThreads(at("one", 0).args)).toBeNull();
    expect(decoderCounts(at("one", 1).args)).toEqual([2]);
    expect(encoderThreads(at("one", 1).args)).toBe(2);
    expect(decoderCounts(at("one", 2).args)).toEqual([1]);
    expect(encoderThreads(at("one", 2).args)).toBe(2);
  });

  it("one-pass, several inputs: the shared budget is capped, never raised", () => {
    expect(decoderCounts(at("three", 0).args)).toEqual([8, 8, 8]);
    expect(decoderCounts(at("three", 1).args)).toEqual([2, 2, 2]);
    expect(decoderCounts(at("three", 2).args)).toEqual([1, 1, 1]);
    // Thirteen inputs already run on one thread each: a gentler rung cannot make that more.
    for (const rung of [0, 1, 2] as const)
      expect(decoderCounts(at("thirteen", rung).args)).toEqual(Array(13).fill(1));
  });

  it("changes thread counts and nothing else, for every project and every rung", () => {
    for (const name of Object.keys(PROJECTS))
      for (const rung of [1, 2] as const)
        expect(withoutThreads(at(name, rung).args), `${name} at rung ${rung}`).toEqual(
          withoutThreads(at(name, 0).args),
        );
  });

  it("leaves the streamed engine alone: it already runs at its gentlest thread counts", () => {
    for (const name of ["streamed_4k", "streamed_1080"])
      for (const rung of [1, 2] as const) expect(at(name, rung).args).toEqual(at(name, 0).args);
  });

  it("does not hand the graphics encoder a thread count, which it does not use", () => {
    expect(encoderThreads(at("chip_amd_medium", 1).args)).toBeNull();
    expect(encoderThreads(at("chip_amd_medium", 2).args)).toBeNull();
    expect(decoderCounts(at("chip_amd_medium", 1).args)).toEqual([2]); // the decoder still follows the rung
  });

  it("never makes a gentler rung hungrier: no input gets more threads than at the rung before", () => {
    for (const name of Object.keys(PROJECTS)) {
      const counts = ([0, 1, 2] as const).map((rung) => decoderCounts(at(name, rung).args));
      const cap = (value: number | null) => value ?? Number.POSITIVE_INFINITY;
      counts[0].forEach((_, index) => {
        expect(cap(counts[1][index])).toBeLessThanOrEqual(cap(counts[0][index]));
        expect(cap(counts[2][index])).toBeLessThanOrEqual(cap(counts[1][index]));
      });
    }
  });

  it("treats a rung it does not know as the normal one", () => {
    for (const odd of [undefined, -1, 7, Number.NaN, "2" as unknown as Rung]) {
      const plan = buildRenderCommand(PROJECTS.one.timeline(), "/out.mp4", { rung: odd as Rung });
      expect(sha(plan.args)).toBe(FROZEN.one);
    }
  });
});
