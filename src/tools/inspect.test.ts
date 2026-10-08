import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { laplacianVariance, noiseSigma } from "./frameMeasures";
import {
  colorGapHints,
  colorScopes,
  evenTimes,
  INLINE_TRANSCRIPT_MAX_S,
  inspectColorTool,
  inspectMediaTool,
  inspectTimelineTool,
  isGemini,
  mediaKind,
  midpointFrames,
} from "./inspect";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { makeStoryboard } from "./storyboard";
import { peekTranscript, runWhisper } from "./transcribe";
import { backgroundLoudness, prioritizeTranscript } from "./transcriptQueue";

// inspect_media now transcribes audio/video-with-audio via runWhisper; mock it so
// tests don't shell out to whisper-cli / download a model.
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "C:/res/fonts" }));
vi.mock("./transcriptQueue", () => ({
  prioritizeTranscript: vi.fn(() => true),
  backgroundLoudness: vi.fn(() => null),
}));
vi.mock("./storyboard", () => ({
  makeStoryboard: vi.fn(async () => ({
    path: "C:/proj/internals/cache/inspect/ov_sheet.jpg",
    tile_times: [1.5, 6, 11],
  })),
}));
vi.mock("./transcribe", () => ({
  normLanguage: (l: unknown) => {
    const s = String(l ?? "")
      .trim()
      .toLowerCase();
    return !s || s === "auto" ? "" : s;
  },
  peekTranscript: vi.fn(async () => null),
  runWhisper: vi.fn(async () => ({
    language: "en",
    duration_seconds: 12.5,
    segments: [
      {
        segment_id: 1,
        start_seconds: 0,
        end_seconds: 2,
        start_timestamp: "",
        end_timestamp: "",
        text: "hello world",
        words: [],
      },
    ],
    words: [
      {
        word_id: 1,
        segment_id: 1,
        index_in_segment: 1,
        word: "hello",
        start_seconds: 0,
        end_seconds: 1,
        start_timestamp: "",
        end_timestamp: "",
        probability: 0.9,
      },
      {
        word_id: 2,
        segment_id: 1,
        index_in_segment: 2,
        word: "world",
        start_seconds: 1,
        end_seconds: 2,
        start_timestamp: "",
        end_timestamp: "",
        probability: 0.9,
      },
    ],
  })),
}));

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  touch(p: string): void {
    this.files.set(joinPath(p), "");
  }
  putBytes(p: string, b: Uint8Array): void {
    this.bytes.set(joinPath(p), b);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(joinPath(p));
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
    const v = this.bytes.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/proj";
const VIDEO_PROBE = JSON.stringify({
  format: { format_name: "mov,mp4", duration: "12.5", size: "1048576" },
  streams: [
    { codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30/1", codec_name: "h264" },
    { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
  ],
});
const IMAGE_PROBE = JSON.stringify({
  format: { format_name: "png_pipe", size: "50000" },
  streams: [{ codec_type: "video", width: 800, height: 600, codec_name: "png" }],
});
const AUDIO_PROBE = JSON.stringify({
  format: { format_name: "mp3", duration: "180.0", size: "2000000" },
  streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 }],
});

function ctxWith(runner: CommandRunner, fs: MockFs = new MockFs()): ClientToolContext {
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The summary ffmpeg's ebur128 + volumedetect print for the EBU -23 LUFS calibration tone. */
const TONE_STDERR = `[Parsed_ebur128_0 @ 0] Summary:

  Integrated loudness:
    I:         -23.0 LUFS
    Threshold: -33.0 LUFS

  True peak:
    Peak:      -23.0 dBFS
[Parsed_volumedetect_1 @ 0] n_samples: 1920000
[Parsed_volumedetect_1 @ 0] mean_volume: -26.0 dB
[Parsed_volumedetect_1 @ 0] max_volume: -23.0 dB
`;

interface MediaCall {
  program: string;
  args: string[];
  signal?: AbortSignal;
  cwd?: string;
  /** The grid file staged in the run's working dir WHEN ffmpeg started, if the run draws one. */
  grid?: string;
}

/** A runner for inspect_media. ffprobe answers `probe`. A frame run writes BOTH of its outputs
 *  (the JPEG and the raw grey frame, `grey(w, h)` bytes sized from its scale); a loudness run
 *  prints `loudness`. `failFrame(t)` makes the frame at source time t fail. */
function mediaRunner(
  fs: MockFs,
  o: {
    probe: string;
    grey?: (w: number, h: number) => Uint8Array;
    loudness?: string;
    failFrame?: (t: number) => boolean;
  },
): CommandRunner & { calls: MediaCall[] } {
  const calls: MediaCall[] = [];
  return {
    calls,
    run: vi.fn(async (program: string, args: string[], signal?: AbortSignal, cwd?: string) => {
      const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
      const assName = /ass=f=([^:]+):/.exec(graph)?.[1];
      calls.push({
        program,
        args,
        signal,
        cwd,
        grid: cwd && assName ? fs.files.get(joinPath(cwd, assName)) : undefined,
      });
      if (program === "ffprobe") return { code: 0, stdout: o.probe, stderr: "" };
      if (args.some((a) => a.includes("ebur128")))
        return { code: 0, stdout: "", stderr: o.loudness ?? "" };
      const ss = args.indexOf("-ss");
      if (o.failFrame && ss >= 0 && o.failFrame(Number(args[ss + 1])))
        return { code: 1, stdout: "", stderr: "Invalid data found when processing input" };
      const dims = /scale=(\d+):(\d+),setsar/.exec(graph);
      for (const [i, a] of args.entries()) {
        if (i === 0 || args[i - 1] === "-i") continue;
        if (/\.(jpg|png|mp4|mp3)$/.test(a)) fs.touch(a);
        if (/\.gray/.test(a) && dims) {
          const w = Number(dims[1]);
          const h = Number(dims[2]);
          fs.touch(a);
          fs.putBytes(a, o.grey ? o.grey(w, h) : new Uint8Array(w * h).fill(128));
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
  };
}

/** A deterministic texture, so the measures have something to read. */
const texture = (w: number, h: number): Uint8Array =>
  Uint8Array.from({ length: w * h }, (_, i) => ((i % w) * 7 + Math.floor(i / w) * 13) % 256);

const frameRuns = (calls: MediaCall[]): MediaCall[] =>
  calls.filter((c) => c.program === "ffmpeg" && c.args.includes("rawvideo"));

describe("evenTimes", () => {
  it("returns sub-span midpoints", () => {
    expect(evenTimes(0, 4, 4)).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(evenTimes(0, 10, 1)).toEqual([5]);
    expect(evenTimes(3, 3, 3)).toEqual([3]); // zero span
  });
});

describe("mediaKind", () => {
  it("classifies by extension then streams", () => {
    expect(mediaKind("/a.png", {})).toBe("image");
    expect(mediaKind("/a.mp4", { video: {}, duration_s: 5 })).toBe("video");
    expect(mediaKind("/a.mp3", { audio: {} })).toBe("audio");
    expect(mediaKind("/a.mkv", { video: {}, duration_s: 0 })).toBe("image"); // single still
  });
});

describe("isGemini", () => {
  it("matches gemini-family model ids only", () => {
    expect(isGemini("gemini-2.5-pro")).toBe(true);
    expect(isGemini("GEMINI-flash")).toBe(true);
    expect(isGemini("gpt-5.4")).toBe(false);
    expect(isGemini(undefined)).toBe(false);
  });
});

describe("inspectMediaTool", () => {
  it("errors without a context", async () => {
    expect(((await inspectMediaTool({}, null)) as Any).ok).toBe(false);
  });

  it("errors when the source cannot resolve", async () => {
    const ctx = ctxWith({ run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) });
    const r = (await inspectMediaTool({ media_ref: "missing.mp4" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("media not found");
  });

  it("rejects an absolute-path media_ref even when the file exists (arbitrary-file-read guard)", async () => {
    // The narrow resolver refuses a crafted absolute path so inspect_media can't read + describe an
    // arbitrary file (exfil-to-model). Present on disk, yet still refused.
    const fs = new MockFs();
    fs.touch("C:/secret/passwords.txt");
    const ctx = ctxWith({ run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) }, fs);
    const r = (await inspectMediaTool({ media_ref: "C:/secret/passwords.txt" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("media not found");
  });

  it("attaches an image directly (no frame extraction)", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "pic.png"));
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program === "ffmpeg") {
          fs.touch(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: IMAGE_PROBE, stderr: "" };
      }),
    };
    const r = (await inspectMediaTool({ media_ref: "pic.png" }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("image");
    expect(r.width).toBe(800);
    expect(r._attachments).toHaveLength(1);
    expect(r._attachments[0].kind).toBe("image");
    // the still is downscaled client-side for the model (ffmpeg), then attached
    expect((runner.run as Any).mock.calls.some((c: Any[]) => c[0] === "ffmpeg")).toBe(true);
  });

  it("samples N video frames and declares them as image attachments", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "vid.mp4"));
    const runner = mediaRunner(fs, { probe: VIDEO_PROBE });
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", max_frames: 3 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("video");
    expect(r.frames_attached).toBe(3);
    expect(r._attachments).toHaveLength(3);
    expect(
      r._attachments.every((a: Any) => a.kind === "image" && a.path.includes("inspect/")),
    ).toBe(true);
  });

  it("returns an on-device transcript for audio (no media attachment on gpt)", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "song.mp3"));
    const runner: CommandRunner = {
      run: vi.fn(async () => ({ code: 0, stdout: AUDIO_PROBE, stderr: "" })),
    };
    const r = (await inspectMediaTool({ media_ref: "song.mp3" }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("audio");
    expect(r.duration_s).toBe(180);
    expect(r._attachments).toBeUndefined();
    expect(r.transcript.segments[0][0]).toBe("hello world");
    expect(r.transcript.words).toBeUndefined(); // sentence-level unless word_timestamps
  });

  it("returns word-level tuples when word_timestamps is set", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "song.mp3"));
    const runner: CommandRunner = {
      run: vi.fn(async () => ({ code: 0, stdout: AUDIO_PROBE, stderr: "" })),
    };
    const r = (await inspectMediaTool(
      { media_ref: "song.mp3", word_timestamps: true },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.transcript.words_format).toBe("[text, start_s, end_s]");
    expect(r.transcript.words).toEqual([
      ["hello", 0, 1],
      ["world", 1, 2],
    ]);
    expect(r.transcript.words_truncated).toBe(false);
  });

  it("attaches the video clip for a Gemini model instead of frames", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "vid.mp4"));
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program === "ffmpeg") {
          fs.touch(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: VIDEO_PROBE, stderr: "" };
      }),
    };
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", _model_id: "gemini-2.5-pro", sample_fps: 2 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.video_attached).toBe(true);
    expect(r._attachments).toHaveLength(1);
    expect(r._attachments[0]).toMatchObject({ kind: "video", fps: 2 });
    expect(String(r._attachments[0].path)).toContain("gem_vid_");
    const encodes = (runner.run as Any).mock.calls.filter(
      (c: Any[]) => c[0] === "ffmpeg" && !(c[1] as string[]).some((a) => a.includes("ebur128")),
    );
    expect(encodes).toHaveLength(1); // one clip, not N frames (loudness is measured beside it)
  });

  it("attaches the audio clip for a Gemini model", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "song.mp3"));
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program === "ffmpeg") {
          fs.touch(args[args.length - 1]);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: AUDIO_PROBE, stderr: "" };
      }),
    };
    const r = (await inspectMediaTool(
      { media_ref: "song.mp3", _model_id: "gemini-2.5-flash" },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.audio_attached).toBe(true);
    expect(r._attachments[0]).toMatchObject({ kind: "audio" });
    expect(String(r._attachments[0].path)).toContain("gem_aud_");
  });

  it("reports attach_error (no attachment) when a Gemini clip fails", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "vid.mp4"));
    const runner: CommandRunner = {
      run: vi.fn(async (program: string) =>
        program === "ffmpeg"
          ? { code: 1, stdout: "", stderr: "boom" }
          : { code: 0, stdout: VIDEO_PROBE, stderr: "" },
      ),
    };
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", _model_id: "gemini-2.5-pro" },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.video_attached).toBe(false);
    expect(String(r.attach_error)).toContain("encode for gemini failed");
    expect(r._attachments).toBeUndefined();
  });

  it("honours an explicit start_seconds/end_seconds window and skips frames ffmpeg fails to write", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "vid.mp4"));
    const runner = mediaRunner(fs, {
      probe: VIDEO_PROBE,
      failFrame: (t) => Math.abs(t - 5) < 0.01,
    });
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", max_frames: 3, start_seconds: 2, end_seconds: 8 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.frames_attached).toBe(2); // 3 attempted, 1 failed
    // sampled inside [2, 8]: sub-span midpoints 3, 5, 7
    expect(
      frameRuns(runner.calls)
        .map((c) => Number(c.args[c.args.indexOf("-ss") + 1]))
        .sort((a, b) => a - b),
    ).toEqual([3, 5, 7]);
    expect(r.frames).toEqual([
      { t: 3 },
      { t: 5, error: expect.stringContaining("5.00s") },
      { t: 7 },
    ]);
  });
});

describe("inspectMediaTool looks at what it returns (UJ-012)", () => {
  const LONG_PROBE = JSON.stringify({
    format: { format_name: "matroska", duration: "1800.0", size: "900000000" },
    streams: [
      { codec_type: "video", width: 1920, height: 1080, r_frame_rate: "60/1", codec_name: "h264" },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
    ],
  });
  /** A project holding `vid.mp4`; each test hands its own runner the probe it needs. */
  const setup = (): { fs: MockFs } => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "vid.mp4"));
    return { fs };
  };

  it("takes 6 frames by default, at the midpoints of the span, each with the grid", async () => {
    const { fs } = setup();
    fs.putBytes("C:/res/fonts/Poppins-Regular.ttf", new Uint8Array([1]));
    const runner = mediaRunner(fs, { probe: VIDEO_PROBE });
    const r = (await inspectMediaTool({ media_ref: "vid.mp4" }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.frames.map((f: Any) => f.t)).toEqual(
      evenTimes(0, 12.5, 6).map((t) => Math.round(t * 1000) / 1000),
    );
    expect(r.frames_attached).toBe(6);
    expect(r.timing).toBe("source_seconds");
    expect(r.coordinate_grid).toBe("0-1, origin top-left");
    const runs = frameRuns(runner.calls);
    expect(runs).toHaveLength(6);
    for (const c of runs) {
      // 1080x1920 portrait fits 512 as 288x512; the grid is drawn at exactly that size.
      expect(c.args[c.args.indexOf("-filter_complex") + 1]).toContain(
        "scale=288:512,setsar=1,split=2[s][m];[s]ass=f=grid_288x512.ass:fontsdir=fonts[g];[m]format=gray[k]",
      );
      expect(c.grid, "the grid was not staged before ffmpeg ran").toContain("PlayResX: 288");
    }
  });

  it("measures sharpness and noise on the grey copy of exactly the pixels shown", async () => {
    const { fs } = setup();
    const runner = mediaRunner(fs, { probe: VIDEO_PROBE, grey: texture });
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", max_frames: 2 },
      ctxWith(runner, fs),
    )) as Any;
    const px = texture(288, 512);
    expect(r.sharpness).toBe(Math.round(laplacianVariance(px, 288, 512) * 10) / 10);
    expect(r.noise_sigma).toBe(Math.round(noiseSigma(px, 288, 512) * 10) / 10);
    // ...and a flat picture reads as neither sharp nor noisy: the numbers come from the pixels.
    const flat = setup();
    const r2 = (await inspectMediaTool(
      { media_ref: "vid.mp4", max_frames: 2 },
      ctxWith(mediaRunner(flat.fs, { probe: VIDEO_PROBE }), flat.fs),
    )) as Any;
    expect([r2.sharpness, r2.noise_sigma]).toEqual([0, 0]);
  });

  it("hands every ffmpeg it starts the call's Stop signal", async () => {
    const { fs } = setup();
    const runner = mediaRunner(fs, { probe: VIDEO_PROBE, loudness: TONE_STDERR });
    const stop = new AbortController();
    await inspectMediaTool(
      { media_ref: "vid.mp4", max_frames: 3 },
      { ...ctxWith(runner, fs), signal: stop.signal },
    );
    const ff = runner.calls.filter((c) => c.program === "ffmpeg");
    expect(ff.length).toBe(4); // three frames and the loudness pass
    for (const c of ff) expect(c.signal).toBe(stop.signal);
  });

  it("shows a source with non-square pixels in the shape it is watched in", async () => {
    const { fs } = setup();
    const dv = JSON.stringify({
      format: { format_name: "dv", duration: "10", size: "1000" },
      streams: [
        {
          codec_type: "video",
          width: 720,
          height: 480,
          sample_aspect_ratio: "8:9",
          codec_name: "dvvideo",
        },
      ],
    });
    const runner = mediaRunner(fs, { probe: dv });
    await inspectMediaTool({ media_ref: "vid.mp4", max_frames: 1 }, ctxWith(runner, fs));
    // 720x480 at 8:9 is watched as 640x480 (4:3), so it fits 512 as 512x384, not 512x341.
    expect(frameRuns(runner.calls)[0].args.join(" ")).toContain("scale=512:384,setsar=1");
  });

  it("measures loudness over the span looked at", async () => {
    const { fs } = setup();
    const runner = mediaRunner(fs, { probe: VIDEO_PROBE, loudness: TONE_STDERR });
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", start_seconds: 2, end_seconds: 8 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.loudness).toEqual({ integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 });
    const pass = runner.calls.find((c) => c.args.some((a) => a.includes("ebur128")))!.args;
    expect(pass.slice(pass.indexOf("-ss"), pass.indexOf("-ss") + 4)).toEqual([
      "-ss",
      "2.000",
      "-to",
      "8.000",
    ]);
  });

  it("reports no loudness for a video with no sound, and never runs the pass", async () => {
    const { fs } = setup();
    const silent = JSON.stringify({
      format: { format_name: "mov", duration: "10", size: "1000" },
      streams: [{ codec_type: "video", width: 640, height: 360, codec_name: "h264" }],
    });
    const runner = mediaRunner(fs, { probe: silent });
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", max_frames: 1 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.loudness).toBeNull();
    expect(r.transcript).toBeNull();
    expect(runner.calls.some((c) => c.args.some((a) => a.includes("ebur128")))).toBe(false);
  });

  // Owner decision 2026-10-04 (4g): a look never waits for more than 10 minutes of audio to be
  // measured. Every file is measured whole in the background, so a whole-file look finds it kept.
  describe("loudness of a long span", () => {
    const never = new Promise<never>(() => undefined);
    const passes = (runner: { calls: MediaCall[] }): MediaCall[] =>
      runner.calls.filter((c) => c.args.some((a) => a.includes("ebur128")));

    it("is measured in the background, not while the model waits", async () => {
      const { fs } = setup();
      vi.mocked(backgroundLoudness).mockReturnValue({ first: true, result: never });
      const runner = mediaRunner(fs, { probe: LONG_PROBE, loudness: TONE_STDERR });
      const r = (await inspectMediaTool(
        { media_ref: "vid.mp4", max_frames: 1 },
        ctxWith(runner, fs),
      )) as Any;
      expect(r.ok).toBe(true);
      expect(r.loudness.status).toBe("in_progress");
      expect(passes(runner)).toHaveLength(0);
      // The whole file, named as the indexer names it, so the indexer's measurement is the one found.
      expect(vi.mocked(backgroundLoudness)).toHaveBeenCalledWith(
        DIR,
        joinPath(DIR, "vid.mp4"),
        null,
        null,
      );
    });

    it("measures a window of up to 10 minutes of it now", async () => {
      const { fs } = setup();
      const runner = mediaRunner(fs, { probe: LONG_PROBE, loudness: TONE_STDERR });
      const r = (await inspectMediaTool(
        { media_ref: "vid.mp4", max_frames: 1, start_seconds: 600, end_seconds: 1200 },
        ctxWith(runner, fs),
      )) as Any;
      expect(r.loudness).toEqual({ integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 });
      expect(passes(runner)).toHaveLength(1);
      expect(vi.mocked(backgroundLoudness)).not.toHaveBeenCalled();
    });

    it("a window covering the whole file measures the whole file", async () => {
      const { fs } = setup();
      const runner = mediaRunner(fs, { probe: VIDEO_PROBE, loudness: TONE_STDERR });
      // Within 50 ms of both ends is the whole file.
      await inspectMediaTool(
        { media_ref: "vid.mp4", max_frames: 1, start_seconds: 0.05, end_seconds: 12.45 },
        ctxWith(runner, fs),
      );
      const [pass] = passes(runner);
      expect(pass.args).not.toContain("-ss");
      expect(pass.args).not.toContain("-to");
    });

    it("a long window that ends where the file ends is still a window", async () => {
      const { fs } = setup();
      vi.mocked(backgroundLoudness).mockReturnValue({ first: true, result: never });
      await inspectMediaTool(
        { media_ref: "vid.mp4", max_frames: 1, start_seconds: 600, end_seconds: 1800 },
        ctxWith(mediaRunner(fs, { probe: LONG_PROBE }), fs),
      );
      expect(vi.mocked(backgroundLoudness)).toHaveBeenCalledWith(
        DIR,
        joinPath(DIR, "vid.mp4"),
        600,
        1800,
      );
    });

    // A file ffprobe gives no duration for: its length is unknown, so the whole of it is not
    // measured while the model waits; a window of it, whose length IS known, is.
    it("a file of unknown length is measured whole in the background, and a window of it now", async () => {
      const fs = new MockFs();
      fs.touch(joinPath(DIR, "song.mp3"));
      const noDuration = JSON.stringify({
        format: { format_name: "mp3", size: "2000000" },
        streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 }],
      });
      vi.mocked(backgroundLoudness).mockReturnValue({ first: true, result: never });
      const runner = mediaRunner(fs, { probe: noDuration, loudness: TONE_STDERR });
      const r = (await inspectMediaTool({ media_ref: "song.mp3" }, ctxWith(runner, fs))) as Any;
      expect(r.loudness.status).toBe("in_progress");
      expect(vi.mocked(backgroundLoudness)).toHaveBeenCalledWith(
        DIR,
        joinPath(DIR, "song.mp3"),
        null,
        null,
      );
      expect(passes(runner)).toHaveLength(0);
      const w = (await inspectMediaTool(
        { media_ref: "song.mp3", start_seconds: 0, end_seconds: 300 },
        ctxWith(runner, fs),
      )) as Any;
      expect(w.loudness).toEqual({ integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 });
      const [pass] = passes(runner);
      expect(pass.args.slice(pass.args.indexOf("-to"), pass.args.indexOf("-to") + 2)).toEqual([
        "-to",
        "300.000",
      ]);
    });

    it("for a clip, a measurement that lands while the look waits carries the clip's volume", async () => {
      const { fs } = setup();
      // 20 minutes of the 30-minute file, its sound on the linked audio clip at volume 0.5.
      const clip = {
        media_ref: "vid.mp4",
        source_in: 0,
        source_out: 36000,
        timeline_in: 0,
        timeline_out: 36000,
        link_group: "L",
      };
      fs.files.set(
        joinPath(DIR, "internals/timeline.json"),
        JSON.stringify({
          units: "frames",
          canvas: { width: 1920, height: 1080, fps: 30 },
          tracks: [
            { id: "v1", kind: "video", z: 0, clips: [{ id: "v", kind: "video", ...clip }] },
            {
              id: "a1",
              kind: "audio",
              z: 0,
              clips: [{ id: "a", kind: "audio", ...clip, volume: 0.5 }],
            },
          ],
          failures: [],
        }),
      );
      const figures = { integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 };
      vi.mocked(backgroundLoudness).mockReturnValue({
        first: false,
        result: Promise.resolve(figures),
      });
      const runner = mediaRunner(fs, { probe: LONG_PROBE, loudness: TONE_STDERR });
      const r = (await inspectMediaTool(
        { clip_id: "v", max_frames: 1 },
        ctxWith(runner, fs),
      )) as Any;
      expect(r.loudness.integrated_lufs).toBe(-23);
      expect(r.loudness.after_clip_volume.integrated_lufs).toBe(-29);
      expect(passes(runner)).toHaveLength(0);
      expect(vi.mocked(backgroundLoudness)).toHaveBeenCalledWith(
        DIR,
        joinPath(DIR, "vid.mp4"),
        0,
        1200,
      );
    });
  });

  /** A timeline holding video clip `v` (200 frames from source frame 30, placed at 100) and its
   *  linked audio clip at `volume`. */
  function linked(fs: MockFs, volume: unknown): void {
    const clip = {
      media_ref: "vid.mp4",
      source_in: 30,
      source_out: 90,
      timeline_in: 100,
      timeline_out: 160,
      link_group: "L",
    };
    fs.files.set(
      joinPath(DIR, "internals/timeline.json"),
      JSON.stringify({
        units: "frames",
        canvas: { width: 1080, height: 1920, fps: 30 },
        tracks: [
          { id: "v1", kind: "video", z: 0, clips: [{ id: "v", kind: "video", ...clip }] },
          { id: "a1", kind: "audio", z: 0, clips: [{ id: "a", kind: "audio", ...clip, volume }] },
        ],
        failures: [],
      }),
    );
  }

  it("for a clip, gives its volume and the loudness after it", async () => {
    const { fs } = setup();
    linked(fs, 0.5);
    const runner = mediaRunner(fs, { probe: VIDEO_PROBE, loudness: TONE_STDERR });
    const r = (await inspectMediaTool({ clip_id: "v", max_frames: 1 }, ctxWith(runner, fs))) as Any;
    expect(r.loudness.clip_volume).toBe(0.5);
    // Half the amplitude is 6.02 dB down, on every figure.
    expect(r.loudness.after_clip_volume).toEqual({
      integrated_lufs: -29,
      true_peak_dbtp: -29,
      rms_dbfs: -32,
    });
    // A keyframed volume is reported, not applied.
    linked(fs, [
      { t: 0, v: 1 },
      { t: 30, v: 0 },
    ]);
    const k = (await inspectMediaTool({ clip_id: "v", max_frames: 1 }, ctxWith(runner, fs))) as Any;
    expect(k.loudness.clip_volume).toBe("keyframed");
    expect(k.loudness.after_clip_volume).toBeUndefined();
  });

  it("for a clip, reports frames in PROJECT frames, inside the clip", async () => {
    const { fs } = setup();
    linked(fs, 1);
    const runner = mediaRunner(fs, { probe: VIDEO_PROBE });
    const r = (await inspectMediaTool({ clip_id: "v", max_frames: 3 }, ctxWith(runner, fs))) as Any;
    expect(r.timing).toBe("project_frames");
    // Source seconds 1-3 (frames 30-90) sit at timeline frames 100-160: midpoints 110, 130, 150.
    expect(r.frames).toEqual([{ frame: 110 }, { frame: 130 }, { frame: 150 }]);
  });

  it("with overview, returns ONE storyboard of the span and takes no frames", async () => {
    const { fs } = setup();
    const runner = mediaRunner(fs, { probe: VIDEO_PROBE });
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", overview: true },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.overview).toEqual({ tile_times: [1.5, 6, 11] });
    expect(r._attachments).toHaveLength(1);
    expect(r._attachments[0].path).toContain("ov_sheet.jpg");
    expect(frameRuns(runner.calls)).toHaveLength(0);
    expect(vi.mocked(makeStoryboard).mock.calls[0].slice(2)).toEqual([
      0,
      12.5,
      { w: 1080, h: 1920 },
    ]);
    // For a clip, the tiles' times come back as project frames (none for a time the clip skips).
    linked(fs, 1);
    const c = (await inspectMediaTool(
      { clip_id: "v", overview: true },
      ctxWith(runner, fs),
    )) as Any;
    expect(c.overview).toEqual({ tile_frames: [115, null, null] });
  });

  describe("transcript", () => {
    it("transcribes a short file inline, as the whole-file transcript", async () => {
      const { fs } = setup();
      await inspectMediaTool(
        { media_ref: "vid.mp4", max_frames: 1 },
        ctxWith(mediaRunner(fs, { probe: VIDEO_PROBE }), fs),
      );
      expect(vi.mocked(runWhisper)).toHaveBeenCalledTimes(1);
      const [, , , language, window] = vi.mocked(runWhisper).mock.calls[0];
      expect(window).toBeNull(); // the whole file, which every later window can reuse
      expect(language).toBe("");
    });

    it("never waits on a long file: the whole file goes to the front of the background queue", async () => {
      const { fs } = setup();
      const runner = mediaRunner(fs, { probe: LONG_PROBE });
      const r = (await inspectMediaTool(
        { media_ref: "vid.mp4", max_frames: 1, language: "es" },
        ctxWith(runner, fs),
      )) as Any;
      expect(r.ok).toBe(true);
      expect(r.frames_attached).toBe(1); // the look itself still returns
      expect(r.transcript.status).toBe("in_progress");
      expect(r.transcript.note).toMatch(/start_seconds\/end_seconds/);
      expect(vi.mocked(runWhisper)).not.toHaveBeenCalled();
      expect(vi.mocked(prioritizeTranscript)).toHaveBeenCalledWith(
        DIR,
        joinPath(DIR, "vid.mp4"),
        "es",
      );
    });

    it("transcribes a window of a long file now, in the language asked for", async () => {
      const { fs } = setup();
      await inspectMediaTool(
        {
          media_ref: "vid.mp4",
          max_frames: 1,
          start_seconds: 600,
          end_seconds: 660,
          language: "es",
        },
        ctxWith(mediaRunner(fs, { probe: LONG_PROBE }), fs),
      );
      const [, , , language, window] = vi.mocked(runWhisper).mock.calls[0];
      expect(language).toBe("es");
      expect(window).toEqual({ start: 600, end: 660 });
      expect(vi.mocked(prioritizeTranscript)).not.toHaveBeenCalled();
    });

    it("sends a long window to the background too: the limit is the span, not the call", async () => {
      const { fs } = setup();
      const r = (await inspectMediaTool(
        {
          media_ref: "vid.mp4",
          max_frames: 1,
          start_seconds: 0,
          end_seconds: INLINE_TRANSCRIPT_MAX_S + 1,
        },
        ctxWith(mediaRunner(fs, { probe: LONG_PROBE }), fs),
      )) as Any;
      expect(r.transcript.status).toBe("in_progress");
      expect(vi.mocked(runWhisper)).not.toHaveBeenCalled();
    });

    it("answers a long file from its cached transcript at once", async () => {
      const { fs } = setup();
      vi.mocked(peekTranscript).mockResolvedValueOnce({
        language: "en",
        duration_seconds: 1800,
        segments: [
          {
            segment_id: 1,
            start_seconds: 5,
            end_seconds: 6,
            start_timestamp: "",
            end_timestamp: "",
            text: "cached",
            words: [],
          },
        ],
        words: [],
      });
      const r = (await inspectMediaTool(
        { media_ref: "vid.mp4", max_frames: 1 },
        ctxWith(mediaRunner(fs, { probe: LONG_PROBE }), fs),
      )) as Any;
      expect(r.transcript.segments).toEqual([["cached", 5, 6]]);
      expect(vi.mocked(runWhisper)).not.toHaveBeenCalled();
      expect(vi.mocked(prioritizeTranscript)).not.toHaveBeenCalled();
    });

    it("says so when nothing will transcribe it in the background", async () => {
      const { fs } = setup();
      vi.mocked(prioritizeTranscript).mockReturnValueOnce(false);
      const r = (await inspectMediaTool(
        { media_ref: "vid.mp4", max_frames: 1 },
        ctxWith(mediaRunner(fs, { probe: LONG_PROBE }), fs),
      )) as Any;
      expect(r.transcript.status).toBe("unavailable");
      expect(vi.mocked(runWhisper)).not.toHaveBeenCalled();
    });
  });
});

describe("midpointFrames", () => {
  it("samples the midpoints of n equal parts of [start, end), as Palmier does", () => {
    expect(midpointFrames(0, 60, 3)).toEqual([10, 30, 50]);
    expect(midpointFrames(0, 600, 6)).toEqual([50, 150, 250, 350, 450, 550]);
    expect(midpointFrames(100, 101, 4)).toEqual([100]); // one frame in the span
    expect(midpointFrames(10, 10, 4)).toEqual([10]); // empty span -> the start
    expect(midpointFrames(5, 3, 4)).toEqual([5]); // inverted -> the start
    expect(midpointFrames(0, 2, 9)).toEqual([0, 1]); // fewer frames than asked: each once
  });

  it("never leaves [start, end), never repeats, and gives min(n, span) frames", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 100_000 }),
        fc.integer({ min: 1, max: 50_000 }),
        fc.integer({ min: 1, max: 12 }),
        (start, span, n) => {
          const f = midpointFrames(start, start + span, n);
          expect(f.length).toBe(Math.min(n, span));
          for (let i = 0; i < f.length; i++) {
            expect(f[i]).toBeGreaterThanOrEqual(start);
            expect(f[i]).toBeLessThan(start + span);
            if (i) expect(f[i]).toBeGreaterThan(f[i - 1]);
          }
        },
      ),
    );
  });
});

const SEED_TIMELINE = {
  units: "frames",
  canvas: { width: 200, height: 100, fps: 30 },
  tracks: [
    {
      id: "v1",
      kind: "video",
      z: 0,
      clips: [
        {
          id: "c1",
          kind: "video",
          media_ref: "/a.mp4",
          source_in: 0,
          source_out: 60,
          timeline_in: 0,
          timeline_out: 60,
          layout: { x: 0, y: 0, w: 200, h: 100 },
        },
      ],
    },
  ],
  failures: [],
};

function seedTimeline(fs: MockFs, tl: unknown = SEED_TIMELINE): void {
  fs.files.set(joinPath(DIR, "internals/timeline.json"), JSON.stringify(tl));
}

const NOOP_RUNNER: CommandRunner = {
  run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
};

/** The frame a one-frame plan renders, read back from the name of its grid file. */
const frameOf = (args: string[]): number =>
  Number(/grid_f(\d+)\.ass/.exec(args[args.indexOf("-filter_complex") + 1] ?? "")?.[1] ?? NaN);

interface FrameCall {
  frame: number;
  args: string[];
  cwd?: string;
  /** The grid .ass sitting in the run's working dir WHEN ffmpeg started. */
  grid?: string;
  /** Whether the bundled font the grid's labels use was staged beside it. */
  font: boolean;
  /** Whether the run was handed a progress callback (the export's progress bar). */
  progress: boolean;
}

/** ffmpeg that renders one frame by writing its output (the last arg, content `run<n>`), recording
 *  what each run was handed. `fail(frame)` returns that frame's stderr to fail it with; `partial`
 *  makes the failing run leave a file behind first; `write: false` exits 0 having written nothing. */
function frameRunner(
  fs: MockFs,
  opts: {
    fail?: (frame: number) => string | null;
    partial?: boolean;
    write?: (frame: number) => boolean;
    delay?: (frame: number) => number;
    onRun?: () => void;
  } = {},
): CommandRunner & { calls: FrameCall[] } {
  const calls: FrameCall[] = [];
  return {
    calls,
    run: vi.fn(
      async (
        program: string,
        args: string[],
        _signal?: AbortSignal,
        cwd?: string,
        onStdout?: (chunk: string) => void,
      ) => {
        // A .wav has an audio stream, so an audio clip stays in the render plan rather than
        // being dropped as silent before anything could choose not to show it.
        if (program === "ffprobe")
          return { code: 0, stdout: /\.wav$/.test(args[args.length - 1]) ? "0\n" : "", stderr: "" };
        if (program !== "ffmpeg") return { code: 0, stdout: "", stderr: "" };
        const frame = frameOf(args);
        calls.push({
          frame,
          args,
          cwd,
          grid: cwd ? fs.files.get(joinPath(cwd, `grid_f${frame}.ass`)) : undefined,
          font: !!cwd && fs.bytes.has(joinPath(cwd, "fonts", "Poppins-Regular.ttf")),
          progress: onStdout !== undefined,
        });
        opts.onRun?.();
        const ms = opts.delay?.(frame) ?? 0;
        if (ms) await new Promise((r) => setTimeout(r, ms));
        const out = joinPath(args[args.length - 1]);
        const err = opts.fail?.(frame) ?? null;
        if (err !== null) {
          if (opts.partial) fs.files.set(out, "half a jpeg");
          return { code: 1, stdout: "", stderr: err };
        }
        if (opts.write?.(frame) !== false) fs.files.set(out, `run${calls.length}`);
        return { code: 0, stdout: "", stderr: "" };
      },
    ),
  };
}

/** SEED_TIMELINE's one clip, stretched to `frames` long. */
function longTimeline(frames: number): unknown {
  const clip = { ...SEED_TIMELINE.tracks[0].clips[0], source_out: frames, timeline_out: frames };
  return { ...SEED_TIMELINE, tracks: [{ ...SEED_TIMELINE.tracks[0], clips: [clip] }] };
}

describe("inspectTimelineTool", () => {
  it("errors without a context", async () => {
    const r = (await inspectTimelineTool({}, null)) as Any;
    expect(r.ok).toBe(false);
    expect(r.error).toBe("client tool runtime not ready");
  });

  it("errors when timeline.json is missing", async () => {
    const r = (await inspectTimelineTool({}, ctxWith(NOOP_RUNNER))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("timeline.json not found");
  });

  it("errors on an empty timeline", async () => {
    const fs = new MockFs();
    seedTimeline(fs, {
      units: "frames",
      canvas: { width: 200, height: 100, fps: 30 },
      tracks: [],
      failures: [],
    });
    const r = (await inspectTimelineTool({}, ctxWith(NOOP_RUNNER, fs))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("empty");
  });

  it("surfaces preflight errors for an invalid timeline", async () => {
    const fs = new MockFs();
    seedTimeline(fs, {
      units: "frames",
      canvas: { width: 0, height: 100, fps: 30 },
      tracks: [],
      failures: [],
    });
    const r = (await inspectTimelineTool({}, ctxWith(NOOP_RUNNER, fs))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/preflight/);
    expect(r.preflight_errors.length).toBeGreaterThan(0);
  });

  it("renders each sampled frame as its own one-frame window, never the timeline", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = frameRunner(fs);
    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 3 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.frame_numbers).toEqual([10, 30, 50]);
    expect(r.frames_attached).toBe(3);
    // One run per frame asked for and nothing else: no intermediate render of the timeline.
    expect(runner.calls.map((c) => c.frame).sort((a, b) => a - b)).toEqual([10, 30, 50]);
    for (const c of runner.calls) {
      expect(c.args[c.args.indexOf("-frames:v") + 1]).toBe("1");
      expect(c.args[c.args.length - 1]).toMatch(/\.jpg$/);
      expect(c.args.slice(-3, -1), "JPEG quality").toEqual(["-q:v", "4"]);
      expect(c.progress, "a look fed the export's progress bar").toBe(false);
    }
    expect((r.frames as Any[]).map((f) => f.time_s)).toEqual([0.333, 1, 1.667]);
    expect(r._attachments[1].caption).toBe("timeline frame 30 (1.00s)");
    expect(
      r._attachments.every((a: Any) => a.kind === "image" && a.path.includes("inspect/tl_")),
    ).toBe(true);
    expect(r.canvas).toMatchObject({ width: 200, height: 100, fps: 30 });
    expect(r.coordinate_grid).toBe("0-1, origin top-left");
  });

  it("samples 6 frames by default and never more than 12", async () => {
    const fs = new MockFs();
    seedTimeline(fs, longTimeline(900));
    const runner = frameRunner(fs);
    const six = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 600 },
      ctxWith(runner, fs),
    )) as Any;
    expect(six.frame_numbers).toEqual([50, 150, 250, 350, 450, 550]);
    const many = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 900, max_frames: 40 },
      ctxWith(runner, fs),
    )) as Any;
    expect(many.frame_numbers).toHaveLength(12);
    expect(runner.calls).toHaveLength(18);
  });

  it("samples a single frame when end_frame is omitted", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = frameRunner(fs);
    const r = (await inspectTimelineTool({ start_frame: 12 }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.frame_numbers).toEqual([12]);
    expect(r.frames_attached).toBe(1);
    expect(runner.calls.map((c) => c.frame)).toEqual([12]);
  });

  it("looks at frame 0 when no frame is given", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = frameRunner(fs);
    const r = (await inspectTimelineTool({}, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.frame_numbers).toEqual([0]);
    expect(r.out_of_range).toBeUndefined();
    expect(runner.calls.map((c) => c.frame)).toEqual([0]);
  });

  it("reports frames past the end instead of rendering them", async () => {
    const fs = new MockFs();
    seedTimeline(fs); // 60 frames: 0-59
    const runner = frameRunner(fs);
    const r = (await inspectTimelineTool(
      { start_frame: 30, end_frame: 90, max_frames: 3 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.frame_numbers).toEqual([40]);
    expect(r.out_of_range).toEqual([60, 80]);
    expect(r.duration_frames).toBe(60);
    expect(runner.calls.map((c) => c.frame)).toEqual([40]);
  });

  it("refuses when every frame is outside the timeline, and names the range", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = frameRunner(fs);
    for (const start_frame of [60, -5]) {
      const r = (await inspectTimelineTool({ start_frame }, ctxWith(runner, fs))) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/0.*59/);
      expect(r.out_of_range).toEqual([start_frame]);
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("keeps the other frames when one fails, and says why that one failed", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    fs.touch("/a.mp4");
    const runner = frameRunner(fs, {
      fail: (f) => (f === 30 ? "Error while filtering: boom at 30" : null),
    });
    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 3 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.frames_attached).toBe(2);
    const bad = (r.frames as Any[]).find((f) => f.frame === 30);
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("boom at 30");
    expect((r._attachments as Any[]).some((a) => String(a.caption).includes("frame 30"))).toBe(
      false,
    );
  });

  it("fails as a whole when no frame renders", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    fs.touch("/a.mp4");
    const runner = frameRunner(fs, { fail: () => "Invalid argument" });
    const r = (await inspectTimelineTool({ start_frame: 12 }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("Invalid argument");
  });

  it("does not report a frame ffmpeg exited cleanly without writing", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    fs.touch("/a.mp4");
    const runner = frameRunner(fs, { write: (f) => f !== 30 });
    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 3 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.frames_attached).toBe(2);
    const bad = (r.frames as Any[]).find((f) => f.frame === 30);
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toMatch(/wrote no image/);
  });

  it("never hands back what a FAILED run left on disk", async () => {
    const fs = new RenameFs();
    seedTimeline(fs);
    fs.touch("/a.mp4");
    const runner = frameRunner(fs, { fail: () => "killed", partial: true });
    const r = (await inspectTimelineTool({ start_frame: 12 }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(false);
    const left = [...fs.files.keys()].filter((k) => k.includes("/inspect/") && /\.jpg$/.test(k));
    expect(left).toEqual([]); // neither the half-written temp nor a frame under the real name
  });

  // ffmpeg's account of a missing input is "code=-2" and a path; a user whose source sat in iCloud
  // got exactly that, naming neither the clip nor what to do (UJ-012, 2026-10-02).
  it("names the clip whose media is not on disk", async () => {
    const fs = new MockFs(); // /a.mp4 was never written: the file is gone
    seedTimeline(fs);
    const runner = frameRunner(fs, { fail: () => "/a.mp4: No such file or directory" });
    const r = (await inspectTimelineTool({ start_frame: 12 }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/clip c1 uses 'a\.mp4'.*not on disk/);
  });

  it("lists the clips on canvas in each frame, top layer first", async () => {
    const fs = new MockFs();
    const media = (id: string, ref: string, tin: number, tout: number, extra = {}): Any => ({
      id,
      kind: "video",
      media_ref: ref,
      source_in: 0,
      source_out: tout - tin,
      timeline_in: tin,
      timeline_out: tout,
      ...extra,
    });
    seedTimeline(fs, {
      units: "frames",
      canvas: { width: 200, height: 100, fps: 30 },
      tracks: [
        { id: "v1", kind: "video", z: 0, clips: [media("a", "/a.mp4", 0, 90)] },
        {
          id: "v2",
          kind: "video",
          z: 1,
          clips: [media("b", "/b.mp4", 30, 60), media("d", "/d.mp4", 60, 90, { disabled: true })],
        },
        {
          id: "t1",
          kind: "text",
          z: 2,
          clips: [{ id: "t", kind: "text", content: "Title", timeline_in: 0, timeline_out: 20 }],
        },
        { id: "v3", kind: "video", z: 3, hidden: true, clips: [media("h", "/h.mp4", 0, 90)] },
        {
          id: "a1",
          kind: "audio",
          z: 4,
          clips: [{ ...media("m", "/m.wav", 0, 90), kind: "audio" }],
        },
      ],
      failures: [],
    });
    const look = async (args: Record<string, unknown>): Promise<Record<number, string[]>> => {
      const r = (await inspectTimelineTool(args, ctxWith(frameRunner(fs), fs))) as Any;
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return Object.fromEntries((r.frames as Any[]).map((f) => [f.frame, f.visible_clips]));
    };
    expect(await look({ start_frame: 0, end_frame: 90, max_frames: 3 })).toEqual({
      15: ["t", "a"],
      45: ["b", "a"],
      75: ["a"], // d is disabled, h is on a hidden track, m is sound
    });
    // A clip is on canvas from its first frame up to, not including, its out frame.
    expect(await look({ start_frame: 29 })).toEqual({ 29: ["a"] });
    expect(await look({ start_frame: 30 })).toEqual({ 30: ["b", "a"] });
    expect(await look({ start_frame: 59 })).toEqual({ 59: ["b", "a"] });
    expect(await look({ start_frame: 60 })).toEqual({ 60: ["a"] });
  });

  it("lists both clips through a transition: the incoming lead-in and the outgoing hold", async () => {
    const fs = new MockFs();
    const clip = (id: string, tin: number, tout: number, extra = {}): Any => ({
      id,
      kind: "video",
      media_ref: `/${id}.mp4`,
      source_in: 0,
      source_out: tout - tin,
      timeline_in: tin,
      timeline_out: tout,
      ...extra,
    });
    seedTimeline(fs, {
      units: "frames",
      canvas: { width: 200, height: 100, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            clip("x", 0, 60),
            clip("y", 60, 120, { transition_in: { kind: "crossfade", duration: 10 } }),
          ],
        },
      ],
      failures: [],
    });
    const visible = async (frame: number): Promise<string[]> => {
      const r = (await inspectTimelineTool(
        { start_frame: frame },
        ctxWith(frameRunner(fs), fs),
      )) as Any;
      return r.frames[0].visible_clips;
    };
    // A 10-frame crossfade is centred on the cut at 60: y fades in from 55, x holds under it to 65.
    expect(await visible(54)).toEqual(["x"]);
    expect(await visible(55)).toEqual(["y", "x"]);
    expect(await visible(64)).toEqual(["y", "x"]);
    expect(await visible(65)).toEqual(["y"]);
  });

  it("passes on what the renderer warned about", async () => {
    const fs = new MockFs();
    const clip = (id: string, tin: number, tout: number, extra = {}): Any => ({
      id,
      kind: "video",
      media_ref: `/${id}.mp4`,
      source_in: 0,
      source_out: tout - tin,
      timeline_in: tin,
      timeline_out: tout,
      ...extra,
    });
    seedTimeline(fs, {
      units: "frames",
      canvas: { width: 200, height: 100, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: [
            clip("x", 0, 60),
            clip("y", 60, 120, { transition_in: { kind: "custom", duration: 10, expr: "A*P" } }),
          ],
        },
      ],
      failures: [],
    });
    const r = (await inspectTimelineTool({ start_frame: 58 }, ctxWith(frameRunner(fs), fs))) as Any;
    expect(r.ok).toBe(true);
    expect((r.warnings as string[]).some((w) => /custom expr not evaluated/.test(w))).toBe(true);
  });

  it("draws the grid at the size the frame comes out, labelled with its frame number", async () => {
    const fs = new MockFs();
    seedTimeline(fs); // 200x100 canvas -> 768x384 after the fit to 768
    fs.putBytes("C:/res/fonts/Poppins-Regular.ttf", new Uint8Array([1, 2, 3]));
    const runner = frameRunner(fs);
    await inspectTimelineTool({ start_frame: 30 }, ctxWith(runner, fs));
    const [c] = runner.calls;
    const graph = c.args[c.args.indexOf("-filter_complex") + 1];
    expect(graph).toContain(
      "scale=768:768:force_original_aspect_ratio=decrease,ass=f=grid_f30.ass:fontsdir=fonts",
    );
    expect(c.grid, "the grid file was not staged before ffmpeg ran").toBeDefined();
    expect(c.font, "the labels' font was not staged beside it").toBe(true);
    expect(c.grid).toContain("PlayResX: 768");
    expect(c.grid).toContain("PlayResY: 384");
    expect(c.grid).toContain("}f30");
  });

  it("starts no frame once the call is cancelled", async () => {
    const fs = new MockFs();
    seedTimeline(fs, longTimeline(900));
    const stop = new AbortController();
    const runner = frameRunner(fs, { delay: () => 5, onRun: () => stop.abort() });
    const ctx = { ...ctxWith(runner, fs), signal: stop.signal };
    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 900, max_frames: 12 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/cancel/i);
    expect(runner.calls.length).toBeLessThanOrEqual(4); // only what was already in flight
  });

  // Frames used to be extracted one after another, so an 8-frame call paid eight ffmpeg startups end
  // to end. A test that only counts calls cannot tell serial from concurrent, so this watches how
  // many are IN FLIGHT at once.
  it("renders frames concurrently, at most 4 at once", async () => {
    const fs = new MockFs();
    seedTimeline(fs, longTimeline(900));
    let inFlight = 0;
    let peak = 0;
    const inner = frameRunner(fs);
    const runner: CommandRunner = {
      run: async (...a: Parameters<CommandRunner["run"]>) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await inner.run(...a);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 900, max_frames: 12 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.frames_attached).toBe(12);
    expect(peak, "frames rendered one at a time").toBeGreaterThan(1);
    expect(peak, "more renders at once than the machine is promised").toBeLessThanOrEqual(4);
  });

  it("reports frames in REQUEST order even when later ones finish first", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = frameRunner(fs, { delay: (f) => Math.max(0, 40 - f / 2) });
    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 4 },
      ctxWith(runner, fs),
    )) as Any;
    const reported = (r.frames as Array<{ frame: number }>).map((f) => f.frame);
    expect(reported).toEqual(r.frame_numbers);
    expect([...reported].sort((a, b) => a - b)).toEqual(reported);
    const captions = (r._attachments as Any[]).map((a) =>
      Number(/frame (\d+)/.exec(a.caption)?.[1]),
    );
    expect(captions).toEqual(reported);
  });
});

/** MockFs plus the cheap size the frame cache keys on. Without `stat` the store's byteSize
 *  answers null and the cache turns itself off. */
class StatFs extends MockFs {
  sizes = new Map<string, number>();
  async stat(p: string): Promise<{ isDirectory: boolean; size: number }> {
    const k = joinPath(p);
    if (!this.files.has(k)) throw new Error("ENOENT");
    return { isDirectory: false, size: this.sizes.get(k) ?? 1 };
  }
}

/** A StatFs that can delete but not rename (a platform without atomic moves). */
class RemoveFs extends StatFs {
  async remove(p: string): Promise<void> {
    const k = joinPath(p);
    for (const f of [...this.files.keys()])
      if (f === k || f.startsWith(`${k}/`)) this.files.delete(f);
  }
}

/** A StatFs that can rename and delete, as the desktop fs can. */
class RenameFs extends StatFs {
  renamedOnto = new Map<string, string[]>();
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(joinPath(from));
    if (v === undefined) throw new Error("ENOENT");
    this.files.delete(joinPath(from));
    this.files.set(joinPath(to), v);
    this.renamedOnto.set(joinPath(to), [...(this.renamedOnto.get(joinPath(to)) ?? []), v]);
  }
  async remove(p: string): Promise<void> {
    const k = joinPath(p);
    for (const f of [...this.files.keys()])
      if (f === k || f.startsWith(`${k}/`)) this.files.delete(f);
  }
}

describe("inspectTimelineTool renders a frame again only when it would look different", () => {
  const setup = <T extends StatFs>(fs: T): T => {
    seedTimeline(fs);
    fs.touch("/a.mp4");
    fs.sizes.set(joinPath("/a.mp4"), 1000);
    return fs;
  };
  const look = async (fs: MockFs, runner: CommandRunner): Promise<Any> =>
    (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 2 },
      ctxWith(runner, fs),
    )) as Any;
  const paths = (r: Any): string[] => (r._attachments as Any[]).map((a) => a.path);

  it("answers a repeat from the frames it already rendered", async () => {
    const fs = setup(new StatFs());
    const runner = frameRunner(fs);
    const first = await look(fs, runner);
    const second = await look(fs, runner);
    expect(second.ok).toBe(true);
    // The repeat still RETURNS its frames: a cache that skipped the answer too would pass a count.
    expect(paths(second)).toEqual(paths(first));
    expect(runner.calls).toHaveLength(2);
  });

  it("renders again, under new names, when the timeline or its media changed", async () => {
    const fs = setup(new StatFs());
    const runner = frameRunner(fs);
    const first = await look(fs, runner);
    // A generation landing on its placeholder: same clip, same times, different bytes.
    fs.sizes.set(joinPath("/a.mp4"), 2000);
    const media = await look(fs, runner);
    expect(runner.calls).toHaveLength(4);
    seedTimeline(fs, {
      ...SEED_TIMELINE,
      tracks: [
        {
          ...SEED_TIMELINE.tracks[0],
          clips: [{ ...SEED_TIMELINE.tracks[0].clips[0], opacity: 0.5 }],
        },
      ],
    });
    const edited = await look(fs, runner);
    expect(runner.calls).toHaveLength(6);
    // An earlier round's frame keeps showing what that round saw.
    const all = [...paths(first), ...paths(media), ...paths(edited)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("renders every time, under fresh names, when the platform cannot size a file", async () => {
    const fs = new MockFs(); // no stat
    seedTimeline(fs);
    const runner = frameRunner(fs);
    const a = await look(fs, runner);
    const b = await look(fs, runner);
    // Fail toward a slow answer, never a stale one.
    expect(runner.calls).toHaveLength(4);
    expect(paths(a).some((p) => paths(b).includes(p))).toBe(false);
  });

  it("two identical looks at once never rewrite the frame the first one returned", async () => {
    const fs = setup(new RenameFs());
    const runner = frameRunner(fs, { delay: () => 5 });
    const ctx = ctxWith(runner, fs);
    const [x, y] = (await Promise.all([
      inspectTimelineTool({ start_frame: 12 }, ctx),
      inspectTimelineTool({ start_frame: 12 }, ctx),
    ])) as Any[];
    const [px] = paths(x);
    expect(paths(y)).toEqual([px]);
    // Each run wrote a .jpg of its own, never the final name, and only a rename put one there.
    for (const c of runner.calls) {
      expect(c.args[c.args.length - 1]).toMatch(/\.jpg$/);
      expect(joinPath(c.args[c.args.length - 1])).not.toBe(joinPath(px));
    }
    // Written once, by a rename (never half-written in place), and never replaced afterwards.
    expect(fs.renamedOnto.get(joinPath(px))).toHaveLength(1);
    expect(fs.files.get(joinPath(px))).toBe(fs.renamedOnto.get(joinPath(px))![0]);
    expect([...fs.files.keys()].filter((k) => k.includes(".tmp"))).toEqual([]);
  });

  it("keeps the frame on a platform that can delete but not rename", async () => {
    const fs = setup(new RemoveFs());
    const r = await look(fs, frameRunner(fs));
    expect(r.frames_attached).toBe(2);
    for (const p of paths(r)) expect(fs.files.has(joinPath(p)), p).toBe(true);
  });
});

const PROBE_2x2 = JSON.stringify({
  format: { format_name: "png_pipe", size: "100" },
  streams: [{ codec_type: "video", width: 2, height: 2, codec_name: "png" }],
});

/** ffprobe -> 2x2 dims; ffmpeg rawvideo -> writes `buf` bytes to the .raw output
 *  (null = decode produced nothing); any other ffmpeg -> touches its output. */
function colorRunner(
  fs: MockFs,
  buf: Uint8Array | null = new Uint8Array(12).fill(128),
): CommandRunner {
  return {
    run: vi.fn(async (program: string, args: string[]) => {
      if (program === "ffprobe") return { code: 0, stdout: PROBE_2x2, stderr: "" };
      const out = args[args.length - 1];
      if (args.includes("rawvideo")) {
        if (buf) fs.putBytes(out, buf);
        return { code: 0, stdout: "", stderr: "" };
      }
      fs.touch(out);
      return { code: 0, stdout: "", stderr: "" };
    }),
  };
}

describe("colorScopes", () => {
  it("measures a uniform mid-gray field", () => {
    const s = colorScopes(new Uint8Array(12).fill(128), 4) as Any;
    expect(s.mean).toEqual([0.502, 0.502, 0.502]);
    expect(s.mean_luma).toBe(0.502);
    expect(s.black_point).toBe(0.502);
    expect(s.white_point).toBe(0.502);
    expect(s.saturation).toBe(0);
    expect(s.warm_cool).toBe(0);
    expect(s.green_magenta).toBe(0);
    expect(s.clip_low_pct).toBe(0);
    expect(s.clip_high_pct).toBe(0);
    expect(s.hue_histogram).toEqual(new Array(12).fill(0));
  });

  it("measures pure red (saturated, warm, hue bin 0)", () => {
    const s = colorScopes(new Uint8Array([255, 0, 0]), 1) as Any;
    expect(s.mean).toEqual([1, 0, 0]);
    expect(s.mean_luma).toBe(0.299);
    expect(s.saturation).toBe(1);
    expect(s.warm_cool).toBe(1);
    expect(s.green_magenta).toBe(-0.5);
    expect(s.hue_histogram[0]).toBe(1);
    expect(s.hue_histogram.slice(1)).toEqual(new Array(11).fill(0));
  });

  it("computes percentiles + clip percentages on a luma ramp", () => {
    // grayscale 0, 85, 170, 255 -> luma 0, .333, .667, 1
    const buf = new Uint8Array([0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255]);
    const s = colorScopes(buf, 4) as Any;
    expect(s.mean_luma).toBe(0.5);
    expect(s.black_point).toBe(0.01);
    expect(s.white_point).toBe(0.99);
    expect(s.clip_low_pct).toBe(25);
    expect(s.clip_high_pct).toBe(25);
    expect(s.saturation).toBe(0);
  });
});

describe("colorGapHints", () => {
  it("reports directional exposure/saturation/temperature gaps", () => {
    const subj = { mean_luma: 0.4, saturation: 0.3, warm_cool: -0.1 } as Any;
    const ref = { mean_luma: 0.5, saturation: 0.2, warm_cool: 0.1 } as Any;
    const g = colorGapHints(subj, ref) as Any;
    expect(g.d_luma).toBe(0.1);
    expect(g.d_saturation).toBe(-0.1);
    expect(g.d_warm_cool).toBeCloseTo(0.2, 5);
    expect(g.hints.some((h: string) => h.includes("exposure +0.10") && h.includes("darker"))).toBe(
      true,
    );
    expect(g.hints.some((h: string) => h.includes("saturation -0.10"))).toBe(true);
    expect(g.hints.some((h: string) => h.includes("warmer") && h.includes("+0.20"))).toBe(true);
  });

  it("emits no hints when within tolerance", () => {
    const s = { mean_luma: 0.4, saturation: 0.3, warm_cool: 0.1 } as Any;
    const g = colorGapHints(s, {
      mean_luma: 0.41,
      saturation: 0.32,
      warm_cool: 0.12,
    } as Any) as Any;
    expect(g.hints).toEqual([]);
  });
});

describe("inspectColorTool", () => {
  it("errors without a context", async () => {
    expect(((await inspectColorTool({}, null)) as Any).ok).toBe(false);
  });

  it("errors when neither clip_id nor media_ref is given", async () => {
    const fs = new MockFs();
    const r = (await inspectColorTool({}, ctxWith(colorRunner(fs), fs))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("provide clip_id or media_ref");
  });

  it("errors when the media_ref does not resolve", async () => {
    const fs = new MockFs();
    const r = (await inspectColorTool(
      { media_ref: "missing.mp4" },
      ctxWith(colorRunner(fs), fs),
    )) as Any;
    expect(r.ok).toBe(false);
    // Names the asset it could not sample, rather than a generic "could not render".
    expect(String(r.error)).toContain("missing.mp4");
  });

  it("measures an image media_ref directly and attaches the frame", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "shot.png"));
    const r = (await inspectColorTool(
      { media_ref: "shot.png" },
      ctxWith(colorRunner(fs), fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.subject).toBe("media");
    expect(r.frame_attached).toBe(1);
    expect(r._attachments).toHaveLength(1);
    expect(r._attachments[0].kind).toBe("image");
    expect(r.scopes).toHaveProperty("mean_luma");
    expect(r.scopes.hue_histogram as number[]).toHaveLength(12);
  });

  it("extracts a frame from a video media_ref before measuring", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "clip.mp4"));
    const runner = colorRunner(fs);
    const r = (await inspectColorTool({ media_ref: "clip.mp4" }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.subject).toBe("media");
    // a frame extract (ffmpeg) happened before the rawvideo decode
    expect(
      (runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === "ffmpeg").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("renders a graded clip frame for a clip_id", async () => {
    const fs = new MockFs();
    seedTimeline(fs); // SEED_TIMELINE places clip 'c1'
    const r = (await inspectColorTool({ clip_id: "c1" }, ctxWith(colorRunner(fs), fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.subject).toBe("clip");
    expect(r._attachments).toHaveLength(1);
    expect(r.scopes).toHaveProperty("saturation");
  });

  // UJ-012: measuring a clip rendered ALL of it at deliverable quality to look at one frame (44 s
  // median in production). Now it renders that frame, graded, and nothing else.
  it("renders ONE frame of the graded clip, never the clip", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = colorRunner(fs);
    const r = (await inspectColorTool({ clip_id: "c1", at_frame: 40 }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    const calls = ((runner.run as Any).mock.calls as Any[][]).filter((c) => c[0] === "ffmpeg");
    const renders = calls.filter((c) => (c[1] as string[]).includes("-filter_complex"));
    expect(renders).toHaveLength(1);
    const args = renders[0][1] as string[];
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(args.at(-1)).toMatch(/\.png$/);
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("scale=1024:1024:force_original_aspect_ratio=decrease");
    expect(graph).not.toContain("ass="); // scopes measure the picture, never a grid drawn on it
    expect(calls.some((c) => String((c[1] as string[]).at(-1)).endsWith(".mp4"))).toBe(false);
  });

  it("measures a clip whose source is a LIBRARY REF, not a path", async () => {
    // The regression. The fixture above stores "/a.mp4" — already a path, so it never exercised
    // resolution and stayed green while measuring a real clip failed for everyone: a timeline
    // stores `media_<id>`, and ffmpeg cannot open that.
    const fs = new MockFs();
    const abs = joinPath(DIR, "media/shot.mp4");
    fs.touch(abs);
    fs.files.set(
      joinPath(DIR, "internals/library.json"),
      JSON.stringify({
        version: 1,
        clips: [
          { id: "media_abc123", filename: "shot.mp4", path: abs, kind: "video", external: true },
        ],
      }),
    );
    seedTimeline(fs, {
      ...SEED_TIMELINE,
      tracks: [
        {
          ...SEED_TIMELINE.tracks[0],
          clips: [{ ...SEED_TIMELINE.tracks[0].clips[0], media_ref: "media_abc123" }],
        },
      ],
    });
    const r = (await inspectColorTool({ clip_id: "c1" }, ctxWith(colorRunner(fs), fs))) as Any;
    expect(r.ok, `expected a measurement, got: ${JSON.stringify(r)}`).toBe(true);
    expect(r.subject).toBe("clip");
  });

  it("names the reason a clip could not be measured", async () => {
    // "could not render/sample a frame" told the model nothing, so it burned four calls guessing.
    const fs = new MockFs();
    seedTimeline(fs);
    const r = (await inspectColorTool({ clip_id: "nope" }, ctxWith(colorRunner(fs), fs))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("nope");
  });

  // Reads OVERLAP, and this tool wrote its scratch to two FIXED paths (`inspect/color_clip.mp4`
  // and `.png`), so one call's ffmpeg was writing the file another call was decoding. Six failures
  // in one session, surfaced as `Invalid data found when processing input` and a raw decoder abort
  // code, on clips that were perfectly fine — a wall of red for something the user never did wrong.
  it("two concurrent calls never write the same scratch file", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = colorRunner(fs);
    const ctx = ctxWith(runner, fs);
    const [a, b] = await Promise.all([
      inspectColorTool({ clip_id: "c1" }, ctx) as Promise<Any>,
      inspectColorTool({ clip_id: "c1", at_frame: 5 }, ctx) as Promise<Any>,
    ]);
    expect(a.ok && b.ok).toBe(true);
    // Every path ffmpeg was told to WRITE, across both calls. The rule is about the outcome — no
    // two calls share an output — not about how the name is built.
    const outs = ((runner.run as Any).mock.calls as Any[][])
      .filter((c) => c[0] === "ffmpeg")
      .map((c) => (c[1] as string[]).at(-1) as string)
      .filter((p) => p.includes("inspect/"));
    expect(outs.length).toBeGreaterThan(1);
    expect(new Set(outs).size).toBe(outs.length);
  });

  it("adds reference_scopes + gap hints when a reference is supplied", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "shot.png"));
    fs.touch(joinPath(DIR, "ref.png"));
    const r = (await inspectColorTool(
      { media_ref: "shot.png", reference: "ref.png" },
      ctxWith(colorRunner(fs), fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.reference_scopes).toBeDefined();
    expect(r.gap).toBeDefined();
    expect(r._attachments).toHaveLength(2);
  });

  it("errors when the frame cannot be decoded", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "shot.png"));
    const r = (await inspectColorTool(
      { media_ref: "shot.png" },
      ctxWith(colorRunner(fs, null), fs),
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("decode failed");
  });

  // Both media arguments are typed by the MODEL. They went through the TRUSTED resolver, which
  // accepts any absolute path that exists — so one call measured an arbitrary file on the disk and
  // attached it to the model, exactly what resolveMediaRef exists to stop (inspect_media and
  // video_ask already used it). A local file enters by import_media, which returns a ref.
  /** Every path ffmpeg was handed, from any argument. */
  const touched = (runner: CommandRunner): string[] =>
    ((runner.run as Any).mock.calls as Any[][]).flatMap((c) => c[1] as string[]);

  it.each([
    ["an absolute path", "C:/private/photo.png"],
    ["a path escaping the project", "../private/photo.png"],
  ])("never reads %s given as media_ref", async (_what, ref) => {
    const fs = new MockFs();
    fs.touch("C:/private/photo.png");
    fs.touch(joinPath(DIR, "../private/photo.png"));
    const runner = colorRunner(fs);
    const r = (await inspectColorTool({ media_ref: ref }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(false);
    expect(r._attachments).toBeUndefined();
    expect(touched(runner).some((a) => a.includes("private/photo"))).toBe(false);
  });

  it("never reads an absolute path given as reference, and says so instead of dropping the gap", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "shot.png"));
    fs.touch("C:/private/look.png");
    const runner = colorRunner(fs);
    const r = (await inspectColorTool(
      { media_ref: "shot.png", reference: "C:/private/look.png" },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true); // the subject is still measured
    expect(r.reference_scopes).toBeUndefined();
    expect(r._attachments).toHaveLength(1);
    expect(touched(runner).some((a) => a.includes("private/look"))).toBe(false);
    expect(String(r.reference_error)).toContain("C:/private/look.png");
  });

  it("still measures linked media outside the project by its library id", async () => {
    // The capability the narrow resolver keeps: a file the user IMPORTED is reachable by its ref,
    // wherever it lives.
    const fs = new MockFs();
    fs.touch("D:/footage/look.png");
    fs.touch("D:/footage/shot.png");
    fs.files.set(
      joinPath(DIR, "internals/library.json"),
      JSON.stringify({
        version: 1,
        clips: [
          {
            id: "media_shot",
            filename: "shot.png",
            path: "D:/footage/shot.png",
            kind: "image",
            external: true,
          },
          {
            id: "media_look",
            filename: "look.png",
            path: "D:/footage/look.png",
            kind: "image",
            external: true,
          },
        ],
      }),
    );
    const r = (await inspectColorTool(
      { media_ref: "media_shot", reference: "media_look" },
      ctxWith(colorRunner(fs), fs),
    )) as Any;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.reference_scopes).toBeDefined();
    expect(r._attachments).toHaveLength(2);
  });
});
