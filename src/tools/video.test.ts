import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { ClientToolRegistry } from "./registry";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { registerVideoTools } from "./video";

// The ONE hosted video-understanding call + the local pre-encode are the two
// side-effects video.ts owns; mock both so no network / ffmpeg runs. toB64 is
// kept as a stub so the (mocked-away) encoded bytes never have to be real.
vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(),
  toB64: () => "b64data",
}));
vi.mock("./geminiEncode", () => ({
  encodeVideoForGemini: vi.fn(),
}));

import { callAiProxy } from "../api/ai";
import { encodeVideoForGemini } from "./geminiEncode";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  touch(p: string): void {
    this.files.set(joinPath(p), "");
  }
  set(p: string, c: string): void {
    this.files.set(joinPath(p), c);
  }
  putBytes(p: string, b: Uint8Array): void {
    this.bytes.set(joinPath(p), b);
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
// The path the mocked encodeVideoForGemini "returns"; ctxWith seeds its bytes so
// the real ProjectStoreAccess.readBytes call in the tools never throws ENOENT.
const ENCODED = joinPath(DIR, "internals/cache/gemini/enc.mp4");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const probeJson = (dur: number | null): string =>
  JSON.stringify({
    format:
      dur != null
        ? { format_name: "mp4", duration: String(dur), size: "1000" }
        : { format_name: "mp4", size: "1000" },
    streams: [
      { codec_type: "video", width: 1280, height: 720, r_frame_rate: "30/1", codec_name: "h264" },
    ],
  });

function mockRunner(impl: (program: string, args: string[]) => CommandResult): CommandRunner {
  return { run: vi.fn(async (program: string, args: string[]) => impl(program, args)) };
}
// ffprobe returns a probe with the given duration (null => no duration field).
function probeRunner(dur: number | null = 12.5): CommandRunner {
  return mockRunner((program) =>
    program === "ffprobe"
      ? { code: 0, stdout: probeJson(dur), stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
  );
}

interface FsSpec {
  clips?: Any[];
  timeline?: Any;
  touch?: string[];
}
function fsWith(spec: FsSpec = {}): MockFs {
  const fs = new MockFs();
  if (spec.clips)
    fs.set(joinPath(DIR, "internals/library.json"), JSON.stringify({ clips: spec.clips }));
  if (spec.timeline)
    fs.set(joinPath(DIR, "internals/timeline.json"), JSON.stringify(spec.timeline));
  for (const t of spec.touch ?? []) fs.touch(joinPath(DIR, t));
  return fs;
}
// A library with one placed asset (media_a -> library/a.mp4) that resolves.
function libFs(): MockFs {
  return fsWith({
    clips: [{ id: "media_a", path: "library/a.mp4", filename: "a.mp4" }],
    touch: ["library/a.mp4"],
  });
}

function ctxWith(runner: CommandRunner, fs: MockFs = libFs()): ClientToolContext {
  fs.putBytes(ENCODED, new Uint8Array([1, 2, 3]));
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Any> {
  const reg = new ClientToolRegistry();
  registerVideoTools(reg, () => ctx);
  return (await reg.run(name, args)) as Any;
}

const proxy = vi.mocked(callAiProxy);
const encode = vi.mocked(encodeVideoForGemini);

// Convenience: resolve the proxy with a `text` payload (the model's answer).
function proxyText(text: string): void {
  proxy.mockResolvedValue({ result: { ok: true, text } } as Any);
}
// The (name, body) of the most recent proxy call.
function lastProxyCall(): { name: string; body: Any } {
  const c = proxy.mock.calls[proxy.mock.calls.length - 1];
  return { name: c[0] as string, body: c[1] as Any };
}

beforeEach(() => {
  encode.mockReset().mockResolvedValue(ENCODED);
  proxy.mockReset();
  proxyText("");
});

describe("registerVideoTools", () => {
  it("registers exactly video_ask + video_find_moment", () => {
    const reg = new ClientToolRegistry();
    registerVideoTools(reg, () => null);
    expect(reg.has("video_ask")).toBe(true);
    expect(reg.has("video_find_moment")).toBe(true);
    expect(reg.names().sort()).toEqual(["video_ask", "video_find_moment"]);
  });
});

describe("video_ask — guards & source resolution", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("video_ask", { media_ref: "media_a" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("rejects a youtube URL media_ref (local-file-only)", async () => {
    const r = await runTool(
      "video_ask",
      { media_ref: "https://youtu.be/abc123" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("LOCAL FILE PATHS ONLY");
    expect(String(r.error)).toContain("download_video");
  });

  it("rejects a plain http(s) URL media_ref", async () => {
    const r = await runTool(
      "video_ask",
      { media_ref: "http://example.com/clip.mp4" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("LOCAL FILE PATHS ONLY");
  });

  it("errors when neither media_ref nor clip_id is provided", async () => {
    const r = await runTool("video_ask", { prompt: "hi" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("provide media_ref");
  });

  it("errors when media_ref does not resolve to a local file", async () => {
    const r = await runTool("video_ask", { media_ref: "missing.mp4" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("local file not found");
  });

  it("rejects an absolute-path media_ref even when the file exists (arbitrary-file-read guard)", async () => {
    // A crafted absolute path must NOT be readable through a media tool: no arbitrary-file read +
    // exfil-to-model. The narrow resolver refuses it even though the file is present on disk.
    const fs = libFs();
    fs.touch("C:/secret/passwords.txt");
    const r = await runTool(
      "video_ask",
      { media_ref: "C:/secret/passwords.txt", prompt: "hi" },
      ctxWith(probeRunner(), fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("local file not found");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("errors when clip_id is given but the timeline cannot be read", async () => {
    const r = await runTool("video_ask", { clip_id: "clip1" }, ctxWith(probeRunner(), libFs()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("timeline could not be read");
  });

  it("errors when clip_id is not on the timeline", async () => {
    const fs = fsWith({
      timeline: { tracks: [{ id: "v1", clips: [{ id: "other", media_ref: "media_a" }] }] },
    });
    const r = await runTool("video_ask", { clip_id: "clip1" }, ctxWith(probeRunner(), fs));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("clip not found");
  });

  it("errors when the clip has no source media (e.g. a text clip)", async () => {
    const fs = fsWith({ timeline: { tracks: [{ id: "captions", clips: [{ id: "clip1" }] }] } });
    const r = await runTool("video_ask", { clip_id: "clip1" }, ctxWith(probeRunner(), fs));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("has no source media");
  });

  it("errors when clip_id and media_ref reference different assets", async () => {
    const fs = fsWith({
      clips: [
        { id: "media_a", path: "library/a.mp4", filename: "a.mp4" },
        { id: "media_b", path: "library/b.mp4", filename: "b.mp4" },
      ],
      timeline: { tracks: [{ id: "v1", clips: [{ id: "clip1", media_ref: "media_a" }] }] },
      touch: ["library/a.mp4", "library/b.mp4"],
    });
    const r = await runTool(
      "video_ask",
      { clip_id: "clip1", media_ref: "media_b" },
      ctxWith(probeRunner(), fs),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("does not match media_ref");
  });

  it("resolves a clip_id to its placed source and answers", async () => {
    const fs = fsWith({
      clips: [{ id: "media_a", path: "library/a.mp4", filename: "a.mp4" }],
      timeline: { tracks: [{ id: "v1", clips: [{ id: "clip1", media_ref: "media_a" }] }] },
      touch: ["library/a.mp4"],
    });
    proxyText("clip answer");
    const r = await runTool(
      "video_ask",
      { clip_id: "clip1", prompt: "what?" },
      ctxWith(probeRunner(), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.response).toBe("clip answer");
  });

  it("still resolves a clip_id whose source is an EXTERNAL (absolute) ref — clip-derived paths aren't narrowed", async () => {
    // An external (referenced-in-place) clip legitimately carries an ABSOLUTE media_ref; inspecting
    // it by clip_id must keep working. Only the untrusted agent `media_ref` ARGUMENT is narrowed —
    // a trusted clip source stays on resolveRef, so this absolute source still resolves.
    const fs = new MockFs();
    fs.set(
      joinPath(DIR, "internals/library.json"),
      JSON.stringify({
        clips: [{ id: "media_ext", path: "D:/ext/hero.mp4", external: true, filename: "hero.mp4" }],
      }),
    );
    fs.set(
      joinPath(DIR, "internals/timeline.json"),
      JSON.stringify({
        tracks: [{ id: "v1", clips: [{ id: "clip1", media_ref: "D:/ext/hero.mp4" }] }],
      }),
    );
    fs.touch("D:/ext/hero.mp4");
    proxyText("ext answer");
    const r = await runTool(
      "video_ask",
      { clip_id: "clip1", prompt: "what?" },
      ctxWith(probeRunner(), fs),
    );
    expect(r.ok).toBe(true);
    expect(r.response).toBe("ext answer");
  });

  it("accepts a matching clip_id + media_ref pair", async () => {
    const fs = fsWith({
      clips: [{ id: "media_a", path: "library/a.mp4", filename: "a.mp4" }],
      timeline: { tracks: [{ id: "v1", clips: [{ id: "clip1", media_ref: "media_a" }] }] },
      touch: ["library/a.mp4"],
    });
    const r = await runTool(
      "video_ask",
      { clip_id: "clip1", media_ref: "media_a" },
      ctxWith(probeRunner(), fs),
    );
    expect(r.ok).toBe(true);
  });

  it("falls back to the clip source when the extra media_ref does not resolve", async () => {
    const fs = fsWith({
      clips: [{ id: "media_a", path: "library/a.mp4", filename: "a.mp4" }],
      timeline: { tracks: [{ id: "v1", clips: [{ id: "clip1", media_ref: "media_a" }] }] },
      touch: ["library/a.mp4"],
    });
    const r = await runTool(
      "video_ask",
      { clip_id: "clip1", media_ref: "ghost.mp4" },
      ctxWith(probeRunner(), fs),
    );
    expect(r.ok).toBe(true);
  });
});

describe("video_ask — window handling", () => {
  it("rejects a video longer than the 30-minute cap", async () => {
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(probeRunner(2000)));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("too long for video_ask");
    expect(r.video_duration_s).toBe(2000);
    expect(encode).not.toHaveBeenCalled();
  });

  it("rejects a window whose end is <= its start", async () => {
    const r = await runTool(
      "video_ask",
      { media_ref: "media_a", start_seconds: 10, end_seconds: 5 },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("invalid window");
  });

  it("clamps a negative start to 0 and reports the window", async () => {
    proxyText("ok");
    const r = await runTool(
      "video_ask",
      { media_ref: "media_a", start_seconds: -5, end_seconds: 6 },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.window_s).toEqual([0, 6]);
  });

  it("passes an explicit start/end window through to the encoder", async () => {
    proxyText("ok");
    const r = await runTool(
      "video_ask",
      { media_ref: "media_a", start_seconds: 2, end_seconds: 8 },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.window_s).toEqual([2, 8]);
    const opts = encode.mock.calls[0][2] as Any;
    expect(opts.start).toBe(2);
    expect(opts.end).toBe(8);
    expect(opts.fps).toBe(4);
    expect(opts.keepAudio).toBe(false);
  });

  it("defaults the window end to the probed duration when only start is given", async () => {
    proxyText("ok");
    const r = await runTool(
      "video_ask",
      { media_ref: "media_a", start_seconds: 3 },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.window_s).toEqual([3, 12.5]);
  });

  it("keeps a start-only window open-ended when the duration is unknown", async () => {
    proxyText("ok");
    // ffprobe throws => duration null; end stays null, so window_s = [start, null].
    const throwRunner = mockRunner((program) => {
      if (program === "ffprobe") throw new Error("probe boom");
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await runTool(
      "video_ask",
      { media_ref: "media_a", start_seconds: 5 },
      ctxWith(throwRunner),
    );
    expect(r.ok).toBe(true);
    expect(r.window_s).toEqual([5, null]);
    expect(r.video_duration_s).toBeNull();
  });

  it("reports a null duration when ffprobe exits non-zero", async () => {
    proxyText("ok");
    const errRunner = mockRunner((program) =>
      program === "ffprobe"
        ? { code: 1, stdout: "", stderr: "bad" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(errRunner));
    expect(r.ok).toBe(true);
    expect(r.video_duration_s).toBeNull();
    expect(r.window_s).toBeNull();
  });

  it("reports a null duration when the probe has no duration field", async () => {
    proxyText("ok");
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(probeRunner(null)));
    expect(r.ok).toBe(true);
    expect(r.video_duration_s).toBeNull();
  });
});

describe("video_ask — prompt, encode/proxy & response parsing", () => {
  it("appends the visual-only suffix by default and extracts timestamps", async () => {
    proxyText("Launch at 00:03.480, recap at 1:02:04.250, and the 12:08 mark.");
    const r = await runTool(
      "video_ask",
      { media_ref: "media_a", prompt: "describe" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.response).toContain("Launch");
    expect(r.video_duration_s).toBe(12.5);
    expect(r.window_s).toBeNull();
    const secs = (r.timestamps_found as Any[]).map((t) => t.seconds);
    expect(secs).toEqual([3.48, 3724.25, 728]);
    const { name, body } = lastProxyCall();
    expect(name).toBe("vision_video");
    expect(body.args.tool_name).toBe("video_ask");
    expect(body.args.prompt).toContain("TIMESTAMP FORMAT");
    expect(body.args.prompt).toContain("VISUAL-ONLY MODE");
    expect(body.args.reasoning_mode).toBe("off");
  });

  it("omits the visual-only suffix when visual_only is false and passes reasoning_mode", async () => {
    proxyText("no timestamps here");
    const r = await runTool(
      "video_ask",
      { media_ref: "media_a", prompt: "hi", visual_only: false, reasoning_mode: "deep" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.timestamps_found).toEqual([]);
    const { body } = lastProxyCall();
    expect(body.args.prompt).toContain("TIMESTAMP FORMAT");
    expect(body.args.prompt).not.toContain("VISUAL-ONLY MODE");
    expect(body.args.reasoning_mode).toBe("deep");
  });

  it("surfaces a model-side failure with its error", async () => {
    proxy.mockResolvedValue({ result: { ok: false, error: "model boom" } } as Any);
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("model boom");
  });

  it("surfaces a bare model-side failure with a default message", async () => {
    proxy.mockResolvedValue({ result: { ok: false } } as Any);
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("video model failed");
  });

  it("catches an encoder failure (Error)", async () => {
    encode.mockRejectedValueOnce(new Error("ffmpeg boom"));
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ffmpeg boom");
  });

  it("catches an encoder failure (non-Error)", async () => {
    encode.mockRejectedValueOnce("enc string fail");
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("enc string fail");
  });

  it("catches a proxy transport failure (Error)", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("net down");
  });

  it("catches a proxy transport failure (non-Error, e.g. rate_limited)", async () => {
    proxy.mockRejectedValue("rate_limited");
    const r = await runTool("video_ask", { media_ref: "media_a" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("rate_limited");
  });
});

// ── video_find_moment ──────────────────────────────────────────────────────

const MOMENT_2_SHOTS = [
  "## Moment 1  00:02.000 - 00:08.000",
  "**Why:** The subject is clearly centered and well lit.",
  "",
  "**Shot 1**",
  "*   **Timestamp:** 00:02.000 - 00:05.000",
  "*   **What is in frame:** A rocket on the pad",
  "*   **On-screen text:** LIVE",
  "*   **Tone/mood:** tense anticipation",
  "",
  "**Shot 2**",
  "*   **Timestamp:** 00:05.000 - 00:08.000",
  "*   **What is in frame:** The rocket ignites",
  "*   **On-screen text:** none",
  "*   **Tone/mood:** explosive energy",
  "",
].join("\n");

// A placed clip: media_a windowed to source frames [60, 360) at 1x, sitting at
// timeline frames [100, 400). So a source-second s maps to project frame 40 + 30*s
// (fps 30): 2->100, 5->190, 8->280, 3.48->144. Mirrors clipSpanToFrames.
const FRAMES_CLIP = {
  id: "clip1",
  media_ref: "media_a",
  timeline_in: 100,
  timeline_out: 400,
  source_in: 60,
  source_out: 360,
  speed: 1,
};
function clipFs(): MockFs {
  return fsWith({
    clips: [{ id: "media_a", path: "library/a.mp4", filename: "a.mp4" }],
    timeline: { tracks: [{ id: "v1", clips: [FRAMES_CLIP] }] },
    touch: ["library/a.mp4"],
  });
}

describe("perception tools — clip_id -> PROJECT FRAMES (media_ref stays seconds)", () => {
  it("video_ask maps timestamps to project frames for a placed clip, dropping out-of-span ones", async () => {
    proxyText("Launch at 00:03.480, recap at 1:02:04.250, and the 12:08 mark.");
    const r = await runTool(
      "video_ask",
      { clip_id: "clip1", prompt: "describe" },
      ctxWith(probeRunner(), clipFs()),
    );
    expect(r.ok).toBe(true);
    expect(r.timing).toBe("project_frames");
    // 3.48s -> frame 144 (inside [100,400]); the 1:02:04 and 12:08 marks map far
    // past timeline_out and are dropped.
    expect(r.timestamps_found).toEqual([{ text: "00:03.480", frame: 144 }]);
  });

  it("video_ask keeps source seconds for a raw media_ref", async () => {
    proxyText("Launch at 00:03.480.");
    const r = await runTool(
      "video_ask",
      { media_ref: "media_a", prompt: "describe" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.timing).toBe("source_seconds");
    expect(r.timestamps_found).toEqual([{ text: "00:03.480", seconds: 3.48 }]);
  });

  it("video_find_moment maps moment + shot times to project frames for a placed clip", async () => {
    proxy.mockResolvedValue({ result: { ok: true, text: MOMENT_2_SHOTS } } as Any);
    const r = await runTool(
      "video_find_moment",
      { clip_id: "clip1", query: "rocket" },
      ctxWith(probeRunner(), clipFs()),
    );
    expect(r.ok).toBe(true);
    expect(r.timing).toBe("project_frames");
    const m = (r.moments as Any[])[0];
    expect([m.start_frame, m.end_frame, m.peak_frame]).toEqual([100, 280, 190]);
    expect(m.start_s).toBeUndefined();
    expect((m.shots as Any[]).map((s) => [s.in_frame, s.out_frame])).toEqual([
      [100, 190],
      [190, 280],
    ]);
  });

  it("video_find_moment keeps source seconds for a raw media_ref", async () => {
    proxy.mockResolvedValue({ result: { ok: true, text: MOMENT_2_SHOTS } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "rocket" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.timing).toBe("source_seconds");
    const m = (r.moments as Any[])[0];
    expect([m.start_s, m.end_s, m.peak_s]).toEqual([2, 8, 5]);
    expect(m.start_frame).toBeUndefined();
  });
});

describe("video_find_moment — guards & duration cap", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("video_find_moment", { media_ref: "media_a" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
  });

  it("rejects a URL media_ref", async () => {
    const r = await runTool(
      "video_find_moment",
      { media_ref: "https://youtube.com/watch?v=x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("LOCAL FILE PATHS ONLY");
  });

  it("propagates a source-resolution error", async () => {
    const r = await runTool("video_find_moment", { query: "rocket" }, ctxWith(probeRunner()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("provide media_ref");
  });

  it("rejects a video longer than the 30-minute cap", async () => {
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a" },
      ctxWith(probeRunner(2000)),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("too long for video_find_moment");
    expect(r.video_duration_s).toBe(2000);
  });

  it("treats an unreadable probe as an unknown duration", async () => {
    proxy.mockResolvedValue({ result: { ok: true, text: MOMENT_2_SHOTS } } as Any);
    const throwRunner = mockRunner((program) => {
      if (program === "ffprobe") throw new Error("probe boom");
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "rocket" },
      ctxWith(throwRunner),
    );
    expect(r.ok).toBe(true);
    expect(r.video_duration_s).toBeNull();
    expect((r.moments as Any[])[0].start_s).toBe(2);
  });
});

describe("video_find_moment — prompt construction", () => {
  it("includes the duration bounds line and visual-only block by default", async () => {
    proxy.mockResolvedValue({ result: { ok: true, text: MOMENT_2_SHOTS } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "rocket" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    const { name, body } = lastProxyCall();
    expect(name).toBe("vision_video");
    expect(body.args.tool_name).toBe("video_find_moment");
    expect(body.args.prompt).toContain("INTENT: rocket");
    expect(body.args.prompt).toContain("00:12.500"); // secondsToMmss(12.5) bounds
    expect(body.args.prompt).toContain("VISUAL-ONLY MODE");
  });

  it("omits the bounds line and visual block when duration is unknown and visual_only is false", async () => {
    proxy.mockResolvedValue({ result: { ok: true, text: MOMENT_2_SHOTS } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "rocket", visual_only: false },
      ctxWith(probeRunner(null)),
    );
    expect(r.ok).toBe(true);
    const { body } = lastProxyCall();
    expect(body.args.prompt).not.toContain("The video is exactly");
    expect(body.args.prompt).not.toContain("VISUAL-ONLY MODE");
  });
});

describe("video_find_moment — prose moment/shot parsing", () => {
  it("parses a moment with two shots (snap edges, skip 'none' on-screen text)", async () => {
    proxy.mockResolvedValue({ result: { ok: true, text: MOMENT_2_SHOTS } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "rocket" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.raw_text).toBeNull();
    const m = (r.moments as Any[])[0];
    expect(m.start_s).toBe(2);
    expect(m.end_s).toBe(8);
    expect(m.peak_s).toBe(5);
    expect(m.why).toContain("clearly centered");
    expect(m.shots).toHaveLength(2);
    expect(m.shots[0].description).toContain("A rocket on the pad");
    expect(m.shots[0].description).toContain("on-screen: LIVE");
    expect(m.shots[0].description).toContain("tone: tense anticipation");
    // "none" on-screen text is dropped from the description.
    expect(m.shots[1].description).not.toContain("on-screen");
    expect(m.shots[1].description).toContain("The rocket ignites");
  });

  it("keeps an empty description for a shot with only a timestamp and skips 'n/a' text", async () => {
    const text = [
      "## Moment 1  00:00.000 - 00:30.000",
      "**Why:** best",
      "",
      "**Shot 1**",
      "*   **Timestamp:** 00:00.000 - 00:05.000",
      "",
      "**Shot 2**",
      "*   **Timestamp:** 00:05.000 - 00:10.000",
      "*   **What is in frame:** person walking",
      "*   **On-screen text:** n/a",
      "*   **Tone/mood:** calm",
      "",
    ].join("\n");
    proxy.mockResolvedValue({ result: { ok: true, text } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "person" },
      ctxWith(probeRunner(null)),
    );
    const m = (r.moments as Any[])[0];
    expect(m.shots).toHaveLength(2);
    expect(m.shots[0].description).toBe("");
    expect(m.shots[1].description).toContain("person walking");
    expect(m.shots[1].description).not.toContain("on-screen");
  });

  it("skips malformed shots: missing timestamp, zero-length, out-of-window, overlapping", async () => {
    const text = [
      "## Moment 1  00:00.000 - 00:20.000",
      "**Why:** best",
      "",
      "**Shot 1**",
      "*   **What is in frame:** no timestamp here",
      "",
      "**Shot 2**",
      "*   **Timestamp:** 00:06.000 - 00:06.000",
      "",
      "**Shot 3**",
      "*   **Timestamp:** 00:50.000 - 00:55.000",
      "",
      "**Shot 4**",
      "*   **Timestamp:** 00:02.000 - 00:08.000",
      "*   **What is in frame:** valid shot",
      "",
      "**Shot 5**",
      "*   **Timestamp:** 00:03.000 - 00:09.000",
      "",
    ].join("\n");
    proxy.mockResolvedValue({ result: { ok: true, text } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner(null)),
    );
    const m = (r.moments as Any[])[0];
    expect(m.shots).toHaveLength(1);
    expect(m.shots[0].description).toContain("valid shot");
    expect(m.shots[0].in_s).toBe(2);
    expect(m.shots[0].out_s).toBe(8);
  });

  it("parses a moment that has no shot blocks", async () => {
    const text = [
      "## Moment 1  00:02.000 - 00:08.000",
      "**Why:** just a moment, no shots",
      "",
    ].join("\n");
    proxy.mockResolvedValue({ result: { ok: true, text } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner(null)),
    );
    const m = (r.moments as Any[])[0];
    expect(m.shots).toEqual([]);
    expect(m.why).toContain("just a moment");
  });

  it("returns raw_text when the response has no ## Moment block", async () => {
    proxy.mockResolvedValue({
      result: { ok: true, text: "I could not find a good moment for that." },
    } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.moments).toEqual([]);
    expect(r.raw_text).toContain("could not find");
  });

  it("returns a null raw_text when the response text is empty", async () => {
    proxy.mockResolvedValue({ result: { ok: true, text: "" } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(true);
    expect(r.moments).toEqual([]);
    expect(r.raw_text).toBeNull();
  });

  it("skips a moment header with an invalid range then uses the next valid one", async () => {
    const text = [
      "## Moment 1  no valid range here",
      "## Moment 2  00:02.000 - 00:08.000",
      "**Why:** second is good",
      "",
    ].join("\n");
    proxy.mockResolvedValue({ result: { ok: true, text } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner(null)),
    );
    const m = (r.moments as Any[])[0];
    expect(m.start_s).toBe(2);
    expect(m.why).toContain("second is good");
  });

  it("skips a reversed range then uses the next valid moment", async () => {
    const text = [
      "## Moment 1  00:08.000 - 00:02.000",
      "## Moment 2  00:02.000 - 00:08.000",
      "**Why:** good",
      "",
    ].join("\n");
    proxy.mockResolvedValue({ result: { ok: true, text } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner(null)),
    );
    expect((r.moments as Any[])[0].start_s).toBe(2);
  });

  it("skips a moment that runs past the known duration then uses the next", async () => {
    const text = [
      "## Moment 1  00:00.000 - 00:30.000",
      "## Moment 2  00:02.000 - 00:08.000",
      "**Why:** within bounds",
      "",
    ].join("\n");
    proxy.mockResolvedValue({ result: { ok: true, text } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner(15)),
    );
    const m = (r.moments as Any[])[0];
    expect(m.start_s).toBe(2);
    expect(m.end_s).toBe(8);
  });

  it("returns no moments when every candidate is invalid", async () => {
    proxy.mockResolvedValue({
      result: { ok: true, text: "## Moment 1  00:08.000 - 00:02.000" },
    } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner(null)),
    );
    expect(r.moments).toEqual([]);
    expect(r.raw_text).toContain("Moment 1");
  });
});

describe("video_find_moment — encode/proxy errors", () => {
  it("catches an encoder failure", async () => {
    encode.mockRejectedValueOnce(new Error("encode fail"));
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("encode fail");
  });

  it("catches an encoder failure (non-Error)", async () => {
    encode.mockRejectedValueOnce("bad enc");
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("bad enc");
  });

  it("surfaces a model-side failure with its error", async () => {
    proxy.mockResolvedValue({ result: { ok: false, error: "vfm boom" } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("vfm boom");
  });

  it("surfaces a bare model-side failure with a default message", async () => {
    proxy.mockResolvedValue({ result: { ok: false } } as Any);
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("video model failed");
  });

  it("catches a proxy transport failure (Error)", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("net down");
  });

  it("catches a proxy transport failure (non-Error)", async () => {
    proxy.mockRejectedValue("weird");
    const r = await runTool(
      "video_find_moment",
      { media_ref: "media_a", query: "x" },
      ctxWith(probeRunner()),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("weird");
  });
});
