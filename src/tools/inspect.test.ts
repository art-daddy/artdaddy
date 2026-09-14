import { describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import {
  colorGapHints,
  colorScopes,
  evenFrameNums,
  evenTimes,
  inspectColorTool,
  inspectMediaTool,
  inspectTimelineTool,
  isGemini,
  mediaKind,
} from "./inspect";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";

// inspect_media now transcribes audio/video-with-audio via runWhisper; mock it so
// tests don't shell out to whisper-cli / download a model.
vi.mock("./transcribe", () => ({
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
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program === "ffmpeg") {
          fs.touch(args[args.length - 1]); // the output frame path
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: VIDEO_PROBE, stderr: "" };
      }),
    };
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
    expect((runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === "ffmpeg")).toHaveLength(1); // one clip, not N frames
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
    let ff = 0;
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program === "ffmpeg") {
          ff += 1;
          if (ff !== 2) fs.touch(args[args.length - 1]); // second frame "fails" (no output)
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: VIDEO_PROBE, stderr: "" };
      }),
    };
    const r = (await inspectMediaTool(
      { media_ref: "vid.mp4", max_frames: 3, start_seconds: 2, end_seconds: 8 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.frames_attached).toBe(2); // 3 attempted, 1 failed
    // sampled inside [2, 8]: sub-span midpoints 3, 5, 7
    expect((runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === "ffmpeg")).toHaveLength(3);
  });
});

describe("evenFrameNums", () => {
  it("returns evenly-spaced frame numbers in [start,end]", () => {
    expect(evenFrameNums(0, 60, 3)).toEqual([0, 30, 59]);
    expect(evenFrameNums(0, 60, 5)).toEqual([0, 15, 30, 44, 59]);
    expect(evenFrameNums(10, 10, 4)).toEqual([10]); // zero span -> single frame
    expect(evenFrameNums(5, 3, 4)).toEqual([5]); // inverted -> single frame
    expect(evenFrameNums(0, 2, 9)).toEqual([0, 1]); // n clamped to the span
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

/** ffmpeg runner that "renders" by touching its output (the last arg). ff call 1
 *  is the timeline render (mp4); calls 2..N+1 are the per-frame extracts. */
function ffmpegTouchRunner(
  fs: MockFs,
  opts: { failRender?: boolean; failFrame?: number } = {},
): CommandRunner {
  let ff = 0;
  return {
    run: vi.fn(async (program: string, args: string[]) => {
      if (program !== "ffmpeg") return { code: 0, stdout: "", stderr: "" };
      ff += 1;
      if (ff === 1 && opts.failRender) return { code: 1, stdout: "", stderr: "render boom" };
      if (opts.failFrame && ff === opts.failFrame + 1) return { code: 0, stdout: "", stderr: "" }; // no output written
      fs.touch(args[args.length - 1]);
      return { code: 0, stdout: "", stderr: "" };
    }),
  };
}

describe("inspectTimelineTool", () => {
  it("errors without a context", async () => {
    expect(((await inspectTimelineTool({}, null)) as Any).ok).toBe(false);
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
    expect(r.preflight_errors.length).toBeGreaterThan(0);
  });

  it("renders the timeline and attaches sampled frames", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = ffmpegTouchRunner(fs);
    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 3 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.frame_numbers).toEqual([0, 30, 59]);
    expect(r.frames_attached).toBe(3);
    expect(r._attachments).toHaveLength(3);
    expect(
      r._attachments.every((a: Any) => a.kind === "image" && a.path.includes("inspect/tl_")),
    ).toBe(true);
    expect(r.canvas).toMatchObject({ width: 200, height: 100, fps: 30 });
    // one render + three frame extracts
    expect((runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === "ffmpeg")).toHaveLength(4);
  });

  it("samples a single frame when end_frame is omitted", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = ffmpegTouchRunner(fs);
    const r = (await inspectTimelineTool({ start_frame: 12 }, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(true);
    expect(r.frame_numbers).toEqual([12]);
    expect(r.frames_attached).toBe(1);
    // one render + one frame extract
    expect((runner.run as Any).mock.calls.filter((c: Any[]) => c[0] === "ffmpeg")).toHaveLength(2);
  });

  it("fails when the render step fails", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = ffmpegTouchRunner(fs, { failRender: true });
    const r = (await inspectTimelineTool({}, ctxWith(runner, fs))) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("render failed");
    expect(String(r.stderr_tail)).toContain("render boom");
  });

  it("skips frames ffmpeg fails to write but still succeeds", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = ffmpegTouchRunner(fs, { failFrame: 2 }); // 2nd frame extract writes nothing
    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 3 },
      ctxWith(runner, fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.frames_attached).toBe(2); // 3 sampled, 1 missing
    expect(r._attachments).toHaveLength(2);
    expect((r.frames as Any[]).filter((f: Any) => f.ok === false)).toHaveLength(1);
  });

  // `-ss` before `-i` discards by PTS and keeps the first frame at or AFTER the target, so the
  // seek has to land between frame n-1 and frame n. Asking for the frame's own start time is a
  // coin flip on rounding — frame 59 at 30fps starts at 1.9666…s, which prints as "1.967" and
  // returned frame 60. That was invisible while the tests only counted attachments; it turned
  // into a MISSING frame once the render stopped at the last frame requested.
  it("seeks between the previous frame and the one it was asked for", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    const runner = ffmpegTouchRunner(fs);
    await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 3 },
      ctxWith(runner, fs),
    );

    const extracts = (runner.run as Any).mock.calls.filter(
      (c: Any[]) => c[0] === "ffmpeg" && !c[1].includes("-filter_complex"),
    );
    expect(extracts).toHaveLength(3);
    [0, 30, 59].forEach((n, i) => {
      const args = extracts[i][1] as string[];
      const ss = Number(args[args.indexOf("-ss") + 1]);
      expect(ss, `frame ${n}: seek is at or past the frame's start`).toBeLessThanOrEqual(n / 30);
      expect(ss, `frame ${n}: seek falls back into frame ${n - 1}`).toBeGreaterThan(
        (n - 1) / 30 - 1e-9,
      );
    });
  });

  // Frame extraction used to be a serial await, so an 8-frame call paid eight ffmpeg startups end
  // to end. A test that only counts the calls cannot tell serial from concurrent, so this watches
  // how many are IN FLIGHT at once and orders the completions against the request.
  it("extracts frames concurrently rather than one ffmpeg at a time", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    let ff = 0;
    let inFlight = 0;
    let peak = 0;
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program !== "ffmpeg") return { code: 0, stdout: "", stderr: "" };
        ff += 1;
        if (ff > 1) {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
        }
        fs.touch(args[args.length - 1]);
        return { code: 0, stdout: "", stderr: "" };
      }),
    };

    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 6 },
      ctxWith(runner, fs),
    )) as Any;

    expect(r.ok).toBe(true);
    expect(r.frames_attached).toBe(6);
    expect(peak, "extraction ran serially").toBeGreaterThan(1);
  });

  it("reports frames in REQUEST order even when later ones finish first", async () => {
    const fs = new MockFs();
    seedTimeline(fs);
    let ff = 0;
    const runner: CommandRunner = {
      run: vi.fn(async (program: string, args: string[]) => {
        if (program !== "ffmpeg") return { code: 0, stdout: "", stderr: "" };
        ff += 1;
        // Earlier frames dawdle, so completion order is the reverse of request order.
        if (ff > 1) await new Promise((r) => setTimeout(r, Math.max(0, 30 - ff * 5)));
        fs.touch(args[args.length - 1]);
        return { code: 0, stdout: "", stderr: "" };
      }),
    };

    const r = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 4 },
      ctxWith(runner, fs),
    )) as Any;

    const reported = (r.frames as Array<{ frame: number }>).map((f) => f.frame);
    expect(reported).toEqual(r.frame_numbers);
    expect([...reported].sort((a, b) => a - b)).toEqual(reported);
  });
});

/** MockFs plus the cheap size the preview cache keys on. Without `stat` the store's byteSize
 *  answers null and the cache turns itself off, which is why the cases above still render. */
class StatFs extends MockFs {
  sizes = new Map<string, number>();
  async stat(p: string): Promise<{ isDirectory: boolean; size: number }> {
    const k = joinPath(p);
    if (!this.files.has(k)) throw new Error("ENOENT");
    return { isDirectory: false, size: this.sizes.get(k) ?? 1 };
  }
}

/** A StatFs that can also be listed and pruned — what the cache trim needs. A store without
 *  `readDir` cannot trim at all, which is the deliberate no-op path. */
class DirFs extends StatFs {
  async readDir(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
    const prefix = `${joinPath(dir)}/`;
    return [...this.files.keys()]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map((k) => ({ name: k.slice(prefix.length), isDirectory: false }));
  }
  async remove(p: string): Promise<void> {
    const k = joinPath(p);
    this.files.delete(k);
    this.sizes.delete(k);
  }
}

/** Renders performed, i.e. the expensive call. Everything after the first ffmpeg per invocation
 *  is a per-frame extract, which is cheap and always runs. */
const renders = (runner: CommandRunner): number =>
  (runner.run as Any).mock.calls.filter(
    (c: Any[]) => c[0] === "ffmpeg" && c[1].includes("-filter_complex"),
  ).length;

describe("inspectTimelineTool re-renders only when the answer would differ", () => {
  // The tool encoded the WHOLE timeline at deliverable quality on EVERY call, and the doc comment
  // claimed a cache that was never written. One production session asked for the identical window
  // seven times, five of them consecutively (report d03ab792).
  const setup = (): { fs: StatFs; runner: CommandRunner } => {
    const fs = new StatFs();
    seedTimeline(fs);
    fs.touch("/a.mp4");
    fs.sizes.set(joinPath("/a.mp4"), 1000);
    return { fs, runner: ffmpegTouchRunner(fs) };
  };
  const call = async (fs: StatFs, runner: CommandRunner): Promise<Any> =>
    (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 2 },
      ctxWith(runner, fs),
    )) as Any;

  it("answers an identical repeat without rendering again", async () => {
    const { fs, runner } = setup();
    const first = await call(fs, runner);
    const second = await call(fs, runner);
    expect(first.ok && second.ok).toBe(true);
    // The SECOND call must still return its frames — a cache that skips the work and the answer
    // would pass a naive render count.
    expect(second.frames_attached).toBe(first.frames_attached);
    expect(second.frame_numbers).toEqual(first.frame_numbers);
    expect(renders(runner)).toBe(1);
  });

  it("re-renders when the TIMELINE changed", async () => {
    const { fs, runner } = setup();
    await call(fs, runner);
    seedTimeline(fs, {
      ...SEED_TIMELINE,
      tracks: [
        {
          ...SEED_TIMELINE.tracks[0],
          clips: [{ ...SEED_TIMELINE.tracks[0].clips[0], source_out: 45, timeline_out: 45 }],
        },
      ],
    });
    const after = await call(fs, runner);
    expect(after.ok, JSON.stringify(after)).toBe(true);
    expect(renders(runner)).toBe(2);
  });

  it("re-renders when the MEDIA changed under an untouched timeline", async () => {
    const { fs, runner } = setup();
    await call(fs, runner);
    // Exactly what a generation landing on its placeholder does: same clip, same times, different
    // bytes. Keying on the timeline alone would serve the model a frame of the OLD media forever.
    fs.sizes.set(joinPath("/a.mp4"), 2000);
    await call(fs, runner);
    expect(renders(runner)).toBe(2);
  });

  it("re-renders when a DIFFERENT window is asked for", async () => {
    const { fs, runner } = setup();
    await call(fs, runner);
    await inspectTimelineTool(
      { start_frame: 0, end_frame: 20, max_frames: 2 },
      ctxWith(runner, fs),
    );
    // The cap is part of the key: a window that stops earlier is a different encode.
    expect(renders(runner)).toBe(2);
  });

  it("renders every time when the platform cannot size a file", async () => {
    const fs = new MockFs(); // no stat
    seedTimeline(fs);
    const runner = ffmpegTouchRunner(fs);
    await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 2 },
      ctxWith(runner, fs),
    );
    await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 2 },
      ctxWith(runner, fs),
    );
    // Fail toward a slow answer, never a stale one.
    expect(renders(runner)).toBe(2);
  });

  it("stops the encode at the last frame it was asked for", async () => {
    const { fs, runner } = setup();
    await inspectTimelineTool(
      { start_frame: 0, end_frame: 15, max_frames: 2 },
      ctxWith(runner, fs),
    );
    const args = (runner.run as Any).mock.calls.find((c: Any[]) =>
      c[1].includes("-filter_complex"),
    )[1];
    // 15 frames at 30fps, not the timeline's 60.
    expect(Number(args[args.indexOf("-t") + 1])).toBeLessThan(1);
  });

  // Each call writes an intermediate sized by how DEEP the frame is, and the only sweep runs at
  // project close — so a long session of iterative work grew this directory without bound.
  it("holds the intermediate cache under a ceiling, keeping the render it needs", async () => {
    const fs = new DirFs();
    seedTimeline(fs);
    fs.touch("/a.mp4");
    fs.sizes.set(joinPath("/a.mp4"), 1000);
    const runner = ffmpegTouchRunner(fs);
    const dir = joinPath(DIR, "internals/cache/inspect");
    // Two stale renders that together blow the budget.
    for (const name of ["tl_old_a.mp4", "tl_old_b.mp4"]) {
      fs.touch(joinPath(dir, name));
      fs.sizes.set(joinPath(dir, name), 400 * 1024 * 1024);
    }
    await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 2 },
      ctxWith(runner, fs),
    );

    const left = (await fs.readDir(dir)).filter((e) => e.name.endsWith(".mp4"));
    const total = left.reduce((n, e) => n + (fs.sizes.get(joinPath(dir, e.name)) ?? 1), 0);
    expect(total).toBeLessThanOrEqual(512 * 1024 * 1024); // back under the ceiling
    expect(left.some((e) => e.name.startsWith("tl_old_"))).toBe(true); // only the minimum evicted
    expect(left.some((e) => !e.name.startsWith("tl_old_"))).toBe(true); // this call's render kept
  });

  it("leaves the cache alone while it is under the ceiling", async () => {
    const fs = new DirFs();
    seedTimeline(fs);
    fs.touch("/a.mp4");
    fs.sizes.set(joinPath("/a.mp4"), 1000);
    const runner = ffmpegTouchRunner(fs);
    const dir = joinPath(DIR, "internals/cache/inspect");
    fs.touch(joinPath(dir, "tl_small.mp4"));
    fs.sizes.set(joinPath(dir, "tl_small.mp4"), 1024);
    await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 2 },
      ctxWith(runner, fs),
    );

    const names = (await fs.readDir(dir)).map((e) => e.name);
    expect(names).toContain("tl_small.mp4"); // a cheap cache hit must survive
    expect(names.filter((n) => n.endsWith(".mp4")).length).toBe(2); // and this call's render joined it
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
});
