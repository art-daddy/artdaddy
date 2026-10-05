import { describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import {
  parseFraction,
  parseProbe,
  probeMediaTool,
  probePath,
  runFfmpegTool,
  clipVideoTool,
  cropImageTool,
} from "./media";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  touch(p: string): void {
    this.files.set(joinPath(p), "");
  }
  set(p: string, c: string): void {
    this.files.set(joinPath(p), c);
  }
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.files.has(n) || this.bytes.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const n = joinPath(p);
    const b = this.bytes.get(n);
    if (b !== undefined) return b;
    const t = this.files.get(n);
    if (t !== undefined) return new TextEncoder().encode(t);
    throw new Error("ENOENT");
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/proj";
const PROBE_JSON = JSON.stringify({
  format: { format_name: "mov,mp4,m4a", duration: "12.5", size: "1048576" },
  streams: [
    {
      codec_type: "video",
      width: 1080,
      height: 1920,
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      codec_name: "h264",
      pix_fmt: "yuv420p",
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      sample_rate: "48000",
      channels: 2,
      channel_layout: "stereo",
    },
  ],
});

function mockRunner(impl: (program: string, args: string[]) => CommandResult): CommandRunner {
  return { run: vi.fn(async (program: string, args: string[]) => impl(program, args)) };
}
function ctxWith(runner: CommandRunner, fs: MockFs = new MockFs()): ClientToolContext {
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("parseFraction", () => {
  it("parses fractions and rejects junk", () => {
    expect(parseFraction("30/1")).toBe(30);
    expect(parseFraction("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFraction("30/0")).toBeNull();
    expect(parseFraction("bad")).toBeNull();
    expect(parseFraction(5)).toBeNull();
  });
});

describe("parseProbe", () => {
  it("maps the ffprobe contract", () => {
    const r = parseProbe("/x.mp4", PROBE_JSON) as Any;
    expect(r.ok).toBe(true);
    expect(r.duration_s).toBe(12.5);
    expect(r.size_bytes).toBe(1048576);
    expect(r.has_audio).toBe(true);
    expect(r.n_streams).toBe(2);
    expect(r.video.width).toBe(1080);
    expect(r.video.fps).toBe(30);
    expect(r.audio.codec).toBe("aac");
  });
  it("handles audio-only and bad json", () => {
    const a = parseProbe(
      "/a.wav",
      JSON.stringify({ format: {}, streams: [{ codec_type: "audio", codec_name: "pcm" }] }),
    ) as Any;
    expect(a.video).toBeNull();
    expect(a.has_audio).toBe(true);
    expect((parseProbe("/x", "{bad") as Any).ok).toBe(false);
  });

  // ── adversarial / real-world media: the metadata shapes real user files throw at
  // parseProbe (VFR, rotated, no audio, odd rates, corrupt payloads). Guards the
  // defensive parse so a nasty file yields a trimmed contract, never a throw or NaN. ──
  it("reads VFR: r_frame_rate and avg_frame_rate diverge, both parse", () => {
    const r = parseProbe(
      "/vfr.mp4",
      JSON.stringify({
        format: { duration: "1.0" },
        streams: [
          {
            codec_type: "video",
            width: 64,
            height: 48,
            r_frame_rate: "24000/1001",
            avg_frame_rate: "12000/1001",
          },
        ],
      }),
    ) as Any;
    expect(r.ok).toBe(true);
    expect(r.video.fps).toBeCloseTo(23.976, 2);
    expect(r.video.avg_fps).toBeCloseTo(11.988, 2);
    expect(r.video.fps).not.toBe(r.video.avg_fps);
  });
  it("reads rotation from a Display Matrix side-data entry", () => {
    const r = parseProbe(
      "/rot.mp4",
      JSON.stringify({
        format: {},
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
            side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
          },
        ],
      }),
    ) as Any;
    expect(r.video.rotation).toBe(-90);
  });
  // A phone records portrait as a landscape frame plus a 90° display matrix. Every decoder
  // honours it — ffmpeg auto-rotates, so does a <video> — so 1920x1080 is not what anything
  // actually shows. Reporting the coded size told the model a portrait clip was landscape; on a
  // 9:16 canvas it "corrected" a video that was already upright and the export came out sideways.
  it("reports DISPLAY dimensions for a quarter-turned stream, not coded ones", () => {
    const probe = (rot: number): Any =>
      parseProbe(
        "/rot.mp4",
        JSON.stringify({
          format: {},
          streams: [
            {
              codec_type: "video",
              width: 1920,
              height: 1080,
              side_data_list: [{ side_data_type: "Display Matrix", rotation: rot }],
            },
          ],
        }),
      ) as Any;
    for (const rot of [-90, 90, 270, -270]) {
      const r = probe(rot);
      expect([r.video.width, r.video.height], `rotation ${rot}`).toEqual([1080, 1920]);
      // The raw value stays available; it is the DIMENSIONS that were the lie.
      expect(r.video.rotation).toBe(rot);
    }
  });
  it("leaves dimensions alone for half-turns and for no rotation", () => {
    const probe = (rot: number | null): Any =>
      parseProbe(
        "/r.mp4",
        JSON.stringify({
          format: {},
          streams: [
            {
              codec_type: "video",
              width: 1920,
              height: 1080,
              ...(rot === null
                ? {}
                : { side_data_list: [{ side_data_type: "Display Matrix", rotation: rot }] }),
            },
          ],
        }),
      ) as Any;
    // 180° is still landscape; only quarter turns swap the axes.
    for (const rot of [null, 0, 180, -180]) {
      const r = probe(rot);
      expect([r.video.width, r.video.height], `rotation ${rot}`).toEqual([1920, 1080]);
    }
  });
  it("falls back to tags.rotate when there is no side-data rotation", () => {
    const r = parseProbe(
      "/rot2.mov",
      JSON.stringify({
        format: {},
        streams: [{ codec_type: "video", width: 720, height: 1280, tags: { rotate: "90" } }],
      }),
    ) as Any;
    expect(r.video.rotation).toBe(90);
  });
  it("reports no audio without inventing an audio block", () => {
    const r = parseProbe(
      "/silent.mp4",
      JSON.stringify({
        format: { duration: "2" },
        streams: [{ codec_type: "video", width: 64, height: 48, r_frame_rate: "30/1" }],
      }),
    ) as Any;
    expect(r.has_audio).toBe(false);
    expect(r.audio).toBeNull();
    expect(r.n_streams).toBe(1);
  });
  it("preserves an odd (44.1k) sample rate as reported", () => {
    const r = parseProbe(
      "/odd.wav",
      JSON.stringify({
        format: {},
        streams: [
          { codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "44100", channels: 1 },
        ],
      }),
    ) as Any;
    expect(r.audio.sample_rate).toBe("44100");
    expect(r.audio.channels).toBe(1);
  });
  it("treats a corrupt payload (non-object / non-array streams / null entries) as empty, never throwing", () => {
    // parses to a non-object -> no usable metadata, still ok.
    const n = parseProbe("/x", "123") as Any;
    expect(n.ok).toBe(true);
    expect(n.video).toBeNull();
    expect(n.has_audio).toBe(false);
    // streams present but not an array -> treated as [].
    const s = parseProbe("/x", JSON.stringify({ streams: "oops" })) as Any;
    expect(s.ok).toBe(true);
    expect(s.n_streams).toBe(0);
    // a null stream entry mixed in with a real one -> skipped, real one still read.
    const m = parseProbe(
      "/x",
      JSON.stringify({ streams: [null, { codec_type: "video", width: 10, height: 10 }] }),
    ) as Any;
    expect(m.ok).toBe(true);
    expect(m.video.width).toBe(10);
  });
  it("tolerates missing duration/size and a 1-frame clip", () => {
    const r = parseProbe(
      "/one.mp4",
      JSON.stringify({
        format: { format_name: "mov,mp4" },
        streams: [
          { codec_type: "video", width: 64, height: 48, r_frame_rate: "30/1", nb_frames: "1" },
        ],
      }),
    ) as Any;
    expect(r.ok).toBe(true);
    expect(r.duration_s).toBeNull(); // no NaN
    expect(r.size_bytes).toBeNull();
    expect(r.video.nb_frames).toBe("1");
  });
});

/** ffprobe as the shipped build answers for one file, both questions probePath can ask: its streams
 *  (the STORED size, and a display matrix only when the stream itself carries one, as a phone video
 *  does) and its first frame's side data (where a JPEG or PNG keeps its EXIF orientation). Measured
 *  for all 8 EXIF orientations: stream 640x320 with no rotation, frame displaymatrix -90/90/-180/0,
 *  and ffmpeg decodes the turned size. `frame` = null: the frame carries no rotation. */
function ffprobeOf(file: {
  format: string;
  w: number;
  h: number;
  stream?: number;
  frame?: number | null;
  frameAnswer?: CommandResult;
}): CommandRunner {
  return mockRunner((program, args) => {
    if (program !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
    if (args.some((a) => a.includes("frame_side_data"))) {
      if (file.frameAnswer) return file.frameAnswer;
      const sd =
        file.frame === null || file.frame === undefined ? [{}] : [{ rotation: file.frame }, {}];
      return { code: 0, stdout: JSON.stringify({ frames: [{ side_data_list: sd }] }), stderr: "" };
    }
    const stream: Record<string, unknown> = { codec_type: "video", width: file.w, height: file.h };
    if (file.stream !== undefined)
      stream.side_data_list = [{ side_data_type: "Display Matrix", rotation: file.stream }];
    return {
      code: 0,
      stdout: JSON.stringify({ format: { format_name: file.format }, streams: [stream] }),
      stderr: "",
    };
  });
}

// Every size the app reports or reasons with must be the size of the picture a decoder SHOWS. A
// portrait phone JPEG stores a landscape frame plus EXIF orientation 6; every renderer shows it
// upright, but inspect_media reported it landscape and squashed the frame the model saw into that
// shape, crop_image refused the lower half of the picture, and find_content cut tiles wider than it.
describe("probePath reports the size a decoder shows", () => {
  it("a still turned by its EXIF orientation reports its upright size", async () => {
    const cases: [string, number | null, [number, number]][] = [
      ["jpeg_pipe", -90, [320, 640]],
      ["jpeg_pipe", 90, [320, 640]],
      ["png_pipe", -90, [320, 640]],
      ["jpeg_pipe", -180, [640, 320]],
      ["jpeg_pipe", 0, [640, 320]],
      ["jpeg_pipe", null, [640, 320]],
    ];
    for (const [format, frame, want] of cases) {
      const r = (await probePath(ffprobeOf({ format, w: 640, h: 320, frame }), "/p.jpg")) as Any;
      expect(r.ok, `${format} ${frame}`).toBe(true);
      expect([r.video.width, r.video.height], `${format} frame rotation ${frame}`).toEqual(want);
    }
  });

  it("a turn the stream already carries (a phone video) is applied once, never again from a frame", async () => {
    // Both places saying 90 is what a real file looks like; turning for each would undo the turn.
    for (const format of ["mov,mp4,m4a,3gp,3g2,mj2", "jpeg_pipe"]) {
      const r = (await probePath(
        ffprobeOf({ format, w: 1920, h: 1080, stream: -90, frame: -90 }),
        "/v",
      )) as Any;
      expect([r.video.width, r.video.height], format).toEqual([1080, 1920]);
    }
  });

  it("a frame probe that fails or says nothing leaves the stored size, never something worse", async () => {
    const answers: CommandResult[] = [
      { code: 1, stdout: "", stderr: "boom" },
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "{not json", stderr: "" },
      { code: 0, stdout: JSON.stringify({ frames: [] }), stderr: "" }, // what a broken JPEG gives
      { code: 0, stdout: JSON.stringify({ frames: [{ side_data_list: "x" }] }), stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify({ frames: [{ side_data_list: [{ rotation: "?" }] }] }),
        stderr: "",
      },
    ];
    for (const frameAnswer of answers) {
      const r = (await probePath(
        ffprobeOf({ format: "jpeg_pipe", w: 640, h: 320, frameAnswer }),
        "/p.jpg",
      )) as Any;
      expect(r.ok, JSON.stringify(frameAnswer)).toBe(true);
      expect([r.video.width, r.video.height], JSON.stringify(frameAnswer)).toEqual([640, 320]);
    }
  });

  it("only a single-picture container is asked about its first frame", async () => {
    // A frame probe decodes; doing it for every video and audio file would double every probe.
    for (const format of ["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "wav", "gif"]) {
      const runner = ffprobeOf({ format, w: 64, h: 48, frame: -90 });
      const r = (await probePath(runner, "/m")) as Any;
      expect([r.video.width, r.video.height], format).toEqual([64, 48]);
      expect(vi.mocked(runner.run).mock.calls.length, format).toBe(1);
    }
  });
});

describe("probeMediaTool", () => {
  it("errors without a context", async () => {
    expect(((await probeMediaTool({ media_ref: "x" }, null)) as Any).ok).toBe(false);
  });
  it("errors when the source cannot be resolved", async () => {
    const ctx = ctxWith(mockRunner(() => ({ code: 0, stdout: "", stderr: "" })));
    expect(((await probeMediaTool({ media_ref: "nope" }, ctx)) as Any).ok).toBe(false);
  });
  it("resolves a clip id then probes", async () => {
    const fs = new MockFs();
    fs.set(
      joinPath(DIR, "internals/library.json"),
      JSON.stringify({ clips: [{ id: "media_a", path: "library/a.mp4", filename: "a.mp4" }] }),
    );
    fs.touch(joinPath(DIR, "library/a.mp4"));
    const ctx = ctxWith(
      mockRunner(() => ({ code: 0, stdout: PROBE_JSON, stderr: "" })),
      fs,
    );
    const r = (await probeMediaTool({ media_ref: "media_a" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.video.height).toBe(1920);
  });
  it("surfaces an ffprobe failure", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "x.mp4"));
    const ctx = ctxWith(
      mockRunner(() => ({ code: 1, stdout: "", stderr: "boom" })),
      fs,
    );
    const r = (await probeMediaTool({ media_ref: "x.mp4" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("boom");
  });
});

describe("runFfmpegTool", () => {
  it("errors without a context", async () => {
    expect(((await runFfmpegTool({}, null)) as Any).ok).toBe(false);
  });
  it("validates shapes", async () => {
    const ctx = ctxWith(mockRunner(() => ({ code: 0, stdout: "", stderr: "" })));
    for (const bad of [
      { inputs: "x", args: ["{out}"], output_name: "o.mp4" },
      { inputs: [], args: [], output_name: "o.mp4" },
      { inputs: [], args: ["{out}"], output_name: "" },
      { inputs: [], args: ["{out}"], output_name: "../evil" },
    ]) {
      expect(((await runFfmpegTool(bad, ctx)) as Any).ok).toBe(false);
    }
  });
  it("rejects an unknown placeholder and a missing {out}", async () => {
    const ctx = ctxWith(mockRunner(() => ({ code: 0, stdout: "", stderr: "" })));
    const a = (await runFfmpegTool(
      { inputs: [], args: ["-i", "{in5}", "{out}"], output_name: "o.mp4" },
      ctx,
    )) as Any;
    expect(a.ok).toBe(false);
    expect(String(a.error)).toContain("placeholder");
    const b = (await runFfmpegTool(
      { inputs: [], args: ["-i", "x"], output_name: "o.mp4" },
      ctx,
    )) as Any;
    expect(b.ok).toBe(false);
    expect(String(b.error)).toContain("{out}");
  });
  it("errors when an input cannot resolve", async () => {
    const ctx = ctxWith(mockRunner(() => ({ code: 0, stdout: "", stderr: "" })));
    const r = (await runFfmpegTool(
      { inputs: ["missing.mp4"], args: ["-i", "{in0}", "{out}"], output_name: "o.mp4" },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("input 0 not found");
  });
  it("runs ffmpeg with substituted paths and probes the output", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "in.mp4"));
    const outPath = joinPath(DIR, "internals/cache/ffmpeg/o.mp4");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (program === "ffmpeg") {
          fs.touch(outPath);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: PROBE_JSON, stderr: "" };
      }),
    };
    const ctx = ctxWith(runner, fs);
    const r = (await runFfmpegTool(
      { inputs: ["in.mp4"], args: ["-i", "{in0}", "{out}"], output_name: "o.mp4" },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(String(r.media_ref)).toMatch(/^media_[0-9a-f]{12}$/); // registered as a library refid, not a system path
    expect(r.filename).toBe("o.mp4");
    expect(r.kind).toBe("video");
    const ffmpegCall = calls.find((c) => c[0] === "ffmpeg") as string[];
    expect(ffmpegCall).toContain(joinPath(DIR, "in.mp4"));
    expect(ffmpegCall).toContain(outPath);
  });
  it("errors when ffmpeg fails or produces no output", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "in.mp4"));
    const runner = mockRunner((p) =>
      p === "ffmpeg"
        ? { code: 1, stdout: "", stderr: "bad args here" }
        : { code: 0, stdout: PROBE_JSON, stderr: "" },
    );
    const ctx = ctxWith(runner, fs);
    const r = (await runFfmpegTool(
      { inputs: ["in.mp4"], args: ["-i", "{in0}", "{out}"], output_name: "o.mp4" },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.stderr_tail)).toContain("bad args");
  });

  // QA, slice 3d: asked for 16 kHz AAC, the agent got 48 kHz back with no reason given and spent
  // eleven more calls (4.5 minutes) on other spellings. The reply now SAYS the rate was replaced.
  async function runOne(args: string[], name: string, code = 0): Promise<Any> {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "in.wav"));
    const runner = mockRunner((program) => {
      if (program !== "ffmpeg") return { code: 0, stdout: PROBE_JSON, stderr: "" };
      if (code === 0) fs.touch(joinPath(DIR, `internals/cache/ffmpeg/${name}`));
      return { code, stdout: "", stderr: code ? "Invalid argument" : "" };
    });
    return runFfmpegTool({ inputs: ["in.wav"], args, output_name: name }, ctxWith(runner, fs));
  }

  it("says when an AAC sample rate the command asked for will not apply, and what will", async () => {
    const r = await runOne(["-i", "{in0}", "-c:a", "aac", "-ar", "16000", "{out}"], "o.m4a");
    expect(r.ok).toBe(true);
    const note = String(r.note);
    expect(note).toContain("-ar 16000");
    expect(note).toMatch(/48 kHz/);
    // The way out, so the agent offers it instead of retrying: a format that is not AAC.
    expect(note).toMatch(/WAV/);
  });

  it("adds no note when nothing the command asked for was replaced", async () => {
    for (const [args, name] of [
      [["-i", "{in0}", "-ar", "16000", "{out}"], "o.wav"], // not AAC: the rate applies
      [["-i", "{in0}", "-c:a", "aac", "-ar", "48000", "{out}"], "o.m4a"], // asked for 48 kHz
      [["-i", "{in0}", "-c:a", "aac", "{out}"], "o.m4a"], // asked for no rate
    ] as const) {
      const r = await runOne([...args], name);
      expect(r.ok, name).toBe(true);
      expect(r.note, `${name} ${args.join(" ")}`).toBeUndefined();
    }
  });

  it("keeps the note on a failed run: the replaced rate may be the reason it failed", async () => {
    const r = await runOne(
      ["-i", "{in0}", "-c:a", "aac", "-ar", "16000", "-audio_track_timescale", "16000", "{out}"],
      "o.m4a",
      1,
    );
    expect(r.ok).toBe(false);
    expect(String(r.note)).toContain("-ar 16000");
  });
});

describe("clipVideoTool", () => {
  it("errors without a context", async () => {
    expect(((await clipVideoTool({}, null)) as Any).ok).toBe(false);
  });
  it("validates shapes", async () => {
    const ctx = ctxWith(mockRunner(() => ({ code: 0, stdout: "", stderr: "" })));
    for (const bad of [
      { start_s: 1, end_s: 2, output_name: "o.mp4" }, // no input
      { media_ref: "x", output_name: "o.mp4" }, // no window
      { media_ref: "x", start_s: 2, end_s: 1, output_name: "o.mp4" }, // inverted
      { media_ref: "x", start_s: 1, end_s: 2, output_name: "" }, // no name
      { media_ref: "x", start_s: 1, end_s: 2, output_name: "../evil" }, // traversal
    ]) {
      expect(((await clipVideoTool(bad, ctx)) as Any).ok).toBe(false);
    }
  });
  it("errors when the input cannot resolve", async () => {
    const ctx = ctxWith(mockRunner(() => ({ code: 0, stdout: "", stderr: "" })));
    const r = (await clipVideoTool(
      { media_ref: "missing.mp4", start_s: 1, end_s: 2, output_name: "o.mp4" },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("input not found");
  });
  it("trims with -c copy and reports size from the probe", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "in.mp4"));
    const outPath = joinPath(DIR, "internals/cache/cuts/o.mp4");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (program === "ffmpeg") {
          fs.touch(outPath);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: PROBE_JSON, stderr: "" };
      }),
    };
    const ctx = ctxWith(runner, fs);
    const r = (await clipVideoTool(
      { media_ref: "in.mp4", start_s: 1, end_s: 3, output_name: "o.mp4" },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(String(r.media_ref)).toMatch(/^media_[0-9a-f]{12}$/); // registered as a library refid, not a system path
    expect(r.filename).toBe("o.mp4");
    expect(r.size_bytes).toBe(1048576);
    const ff = calls.find((c) => c[0] === "ffmpeg") as string[];
    expect(ff).toContain("copy");
    expect(ff).toContain("1.000");
    expect(ff).toContain("3.000");
  });
  it("re-encodes when asked", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "in.mp4"));
    const outPath = joinPath(DIR, "internals/cache/cuts/o.mp4");
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (program === "ffmpeg") {
          fs.touch(outPath);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: PROBE_JSON, stderr: "" };
      }),
    };
    const ctx = ctxWith(runner, fs);
    const r = (await clipVideoTool(
      { media_ref: "in.mp4", start_s: 0, end_s: 2, output_name: "o.mp4", reencode: true },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const ff = calls.find((c) => c[0] === "ffmpeg") as string[];
    expect(ff).toContain("libx264");
  });
  it("errors when ffmpeg fails", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "in.mp4"));
    const ctx = ctxWith(
      mockRunner(() => ({ code: 1, stdout: "", stderr: "nope" })),
      fs,
    );
    const r = (await clipVideoTool(
      { media_ref: "in.mp4", start_s: 1, end_s: 3, output_name: "o.mp4" },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
  });
});

describe("cropImageTool", () => {
  const IMG_PROBE = JSON.stringify({
    format: { format_name: "png_pipe", size: "2048" },
    streams: [{ codec_type: "video", width: 1080, height: 1920, codec_name: "png" }],
  });
  it("errors without a context", async () => {
    expect(((await cropImageTool({}, null)) as Any).ok).toBe(false);
  });
  it("requires a source and a positive bbox", async () => {
    const ctx = ctxWith(mockRunner(() => ({ code: 0, stdout: IMG_PROBE, stderr: "" })));
    expect(((await cropImageTool({ bbox: { w: 1, h: 1 } }, ctx)) as Any).ok).toBe(false);
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "img.png"));
    const ctx2 = ctxWith(
      mockRunner(() => ({ code: 0, stdout: IMG_PROBE, stderr: "" })),
      fs,
    );
    expect(
      ((await cropImageTool({ media_ref: "img.png", bbox: { w: 0, h: 5 } }, ctx2)) as Any).ok,
    ).toBe(false);
  });
  it("errors when the source cannot resolve", async () => {
    const ctx = ctxWith(mockRunner(() => ({ code: 0, stdout: IMG_PROBE, stderr: "" })));
    const r = (await cropImageTool(
      { media_ref: "nope.png", bbox: { x: 0, y: 0, w: 10, h: 10 } },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("image not found");
  });
  it("errors when dimensions are unreadable", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "img.png"));
    const audioOnly = JSON.stringify({ format: {}, streams: [{ codec_type: "audio" }] });
    const ctx = ctxWith(
      mockRunner(() => ({ code: 0, stdout: audioOnly, stderr: "" })),
      fs,
    );
    const r = (await cropImageTool(
      { media_ref: "img.png", bbox: { x: 0, y: 0, w: 10, h: 10 } },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("dimensions");
  });
  it("clamps the bbox, crops, and returns the crop geometry", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "img.png"));
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        calls.push([program, ...args]);
        if (program === "ffmpeg") {
          // out path is the last arg
          fs.touch(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: IMG_PROBE, stderr: "" };
      }),
    };
    const ctx = ctxWith(runner, fs);
    const r = (await cropImageTool(
      { media_ref: "img.png", bbox: { x: 100, y: 200, width: 3000, height: 400 } },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(String(r.media_ref)).toMatch(/^media_[0-9a-f]{12}$/);
    expect(r.source_size).toEqual({ w: 1080, h: 1920 });
    // x1 clamped to 1080 -> width 980; height 400 within bounds
    expect(r.size).toEqual({ w: 980, h: 400 });
    expect(r.bbox).toEqual({ x: 100, y: 200, w: 980, h: 400 });
    const ff = calls.find((c) => c[0] === "ffmpeg") as string[];
    expect(ff.some((a) => a === "crop=980:400:100:200")).toBe(true);
  });
});
