import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { registerAudioTools } from "./audio";
import { ClientToolRegistry } from "./registry";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";

// audio.ts leans on three side-effects: the hosted /ai/{voiceover,music} proxy
// call, library persistence, and (voiceover only) the local whisper aligner.
// Mock all three so no network / whisper runs. fromB64 is stubbed so the
// (mocked-away) base64 payloads never have to be real; registerLibraryClip
// returns a fixed library entry so assets are stable. The music tool's OWN
// ffmpeg re-mux + ffprobe are driven through the injected CommandRunner.
vi.mock("../api/ai", () => ({
  callAiProxy: vi.fn(),
  fromB64: vi.fn(() => new Uint8Array(48000)),
}));
vi.mock("./import", () => ({
  registerLibraryClip: vi.fn(),
}));
// generate_music now SUBMITS. The mock still runs the submitted work so every assertion about
// what reaches the proxy (and the ffmpeg re-mux) keeps its teeth, and swallows a throw the way
// the real background settle does.
vi.mock("./genJobs", () => ({
  submitGeneration: vi.fn(),
}));
vi.mock("./transcribe", () => ({
  runWhisper: vi.fn(),
}));

import { callAiProxy, fromB64 } from "../api/ai";
import { registerLibraryClip } from "./import";
import { submitGeneration } from "./genJobs";
import { runWhisper } from "./transcribe";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// A minimal music ffprobe payload: a stereo 44.1 kHz audio stream + duration.
const MUSIC_PROBE = JSON.stringify({
  format: { format_name: "wav", duration: "3.2" },
  streams: [{ codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "44100", channels: 2 }],
});
// Video-only probe (no audio stream) with a duration.
const PROBE_VIDEO_ONLY = JSON.stringify({
  format: { format_name: "mp4", duration: "5.5" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 100, height: 100 }],
});
// Audio probe whose sample_rate is unparseable and that carries no duration, so
// the tool keeps the default sample rate + 0 duration but adopts the channels.
const PROBE_AUDIO_NAN = JSON.stringify({
  format: { format_name: "wav" },
  streams: [{ codec_type: "audio", codec_name: "pcm", sample_rate: "notanum", channels: 6 }],
});

function mockRunner(impl: (program: string, args: string[]) => CommandResult): CommandRunner {
  return { run: vi.fn(async (program: string, args: string[]) => impl(program, args)) };
}
// A runner that never shells out (voiceover: whisper is mocked; never probes).
function noopRunner(): CommandRunner {
  return mockRunner(() => ({ code: 0, stdout: "", stderr: "" }));
}
function ctxWith(runner: CommandRunner, fs: MockFs = new MockFs()): ClientToolContext {
  return { store: new ProjectStoreAccess(DIR, fs), runner };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ClientToolContext | null,
): Promise<Any> {
  const reg = new ClientToolRegistry();
  registerAudioTools(reg, () => ctx);
  return (await reg.run(name, args)) as Any;
}

const proxy = vi.mocked(callAiProxy);
const fromB64Mock = vi.mocked(fromB64);
const regClip = vi.mocked(registerLibraryClip);
const submit = vi.mocked(submitGeneration);
const whisper = vi.mocked(runWhisper);

/** The error a submitted music job settled with, or null when it succeeded. */
let jobError: string | null = null;
/** What the submitted job actually produced — bytes plus the metadata only it can know. */
let jobOutputs: Any[] = [];
/** Metadata the job attached to the library row. */
const jobMeta = (): Any => jobOutputs[0]?.meta ?? {};

// Resolve the proxy with a raw result payload (the `{result}` envelope wrapper).
function proxyResult(result: Record<string, unknown>): void {
  proxy.mockResolvedValue({ result } as Any);
}
// The (name, body) of the most recent proxy call.
function lastProxyCall(): { name: string; body: Any } {
  const c = proxy.mock.calls[proxy.mock.calls.length - 1];
  return { name: c[0] as string, body: c[1] as Any };
}

beforeEach(() => {
  proxy.mockReset();
  fromB64Mock.mockReset().mockReturnValue(new Uint8Array(48000));
  regClip.mockReset().mockResolvedValue({
    id: "media_gen",
    path: "library/media_gen.wav",
    filename: "gen.wav",
    kind: "audio",
    existed: false,
  } as Any);
  jobError = null;
  submit.mockReset().mockImplementation(async (spec: Any) => {
    jobOutputs = [];
    try {
      jobOutputs = (await spec.run()) as Any[];
    } catch (e) {
      jobError = e instanceof Error ? e.message : String(e);
    }
    return { media_refs: ["media_gen_0"], job_id: "job_1" };
  });
  whisper.mockReset().mockResolvedValue({ words: [] } as Any);
});

// ── voiceover helpers ───────────────────────────────────────────────────────
function voiceCtx(fs: MockFs = new MockFs()): ClientToolContext {
  return ctxWith(noopRunner(), fs);
}

// ── music helpers ───────────────────────────────────────────────────────────
interface MusicRunnerOpts {
  ffmpegCode?: number;
  writeOut?: boolean;
  ffprobe?: string;
  ffprobeThrows?: boolean;
}
// A context whose ffmpeg re-mux touches its output (unless told not to) and
// whose ffprobe reports MUSIC_PROBE (unless overridden / made to throw).
function musicCtx(opts: MusicRunnerOpts = {}): ClientToolContext {
  const { ffmpegCode = 0, writeOut = true, ffprobe = MUSIC_PROBE, ffprobeThrows = false } = opts;
  const fs = new MockFs();
  const runner = mockRunner((program, args) => {
    if (program === "ffmpeg") {
      if (ffmpegCode === 0 && writeOut) fs.touch(args[args.length - 1]);
      return { code: ffmpegCode, stdout: "", stderr: "remux boom" };
    }
    if (ffprobeThrows) throw new Error("probe crash");
    return { code: 0, stdout: ffprobe, stderr: "" };
  });
  return ctxWith(runner, fs);
}
// Resolve the proxy with a successful music payload.
function musicOk(result: Record<string, unknown> = {}): void {
  proxyResult({ ok: true, audio_b64: "aud", format: "wav", ...result });
}

describe("abort signal threading (R5)", () => {
  // Inverted deliberately. generate_music is PAID at submit, so cancelling the fetch on Stop or
  // project-close throws away media that has already been bought. Voiceover still takes the
  // signal, because it is synchronous and its result is only useful inside the turn.
  it("generate_music does NOT take ctx.signal — cancelling a paid call saves nothing", async () => {
    musicOk();
    const controller = new AbortController();
    await runTool(
      "generate_music",
      { prompt: "lofi" },
      { ...musicCtx(), signal: controller.signal },
    );
    expect(proxy.mock.calls.at(-1)![2]).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe("registerAudioTools", () => {
  it("registers exactly generate_voiceover + generate_music", () => {
    const reg = new ClientToolRegistry();
    registerAudioTools(reg, () => null);
    expect(reg.names().sort()).toEqual(["generate_music", "generate_voiceover"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("generate_voiceover — guards", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("generate_voiceover", { text: "hi" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("rejects a missing text", async () => {
    const r = await runTool("generate_voiceover", {}, voiceCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("text must be a non-empty string");
  });

  it("rejects a whitespace-only text", async () => {
    const r = await runTool("generate_voiceover", { text: "   " }, voiceCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("text must be a non-empty string");
  });

  it("rejects an unknown voice", async () => {
    const r = await runTool("generate_voiceover", { text: "hi", voice: "Bogus" }, voiceCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown voice 'Bogus'");
  });

  it("rejects an unknown tts model (wrong category)", async () => {
    const r = await runTool("generate_voiceover", { text: "hi", model: "lyria" }, voiceCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown tts model 'lyria'");
  });

  it("rejects an unknown tts model (absent id)", async () => {
    const r = await runTool("generate_voiceover", { text: "hi", model: "zzz" }, voiceCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown tts model 'zzz'");
  });
});

describe("generate_voiceover — success", () => {
  it("submits with defaults and returns a placeholder, not finished audio", async () => {
    proxyResult({ ok: true, pcm_b64: "p", mime: "audio/l16; rate=24000; channels=1" });
    const r = await runTool("generate_voiceover", { text: "hello world" }, voiceCtx());
    expect(r.ok).toBe(true);
    expect(r.status).toBe("generating");
    expect(r.voice).toBe("Charon");
    expect(r.model).toBe("gemini-3.1-flash-tts-preview");
    expect(r.style).toBeNull();
    expect(r.language).toBeNull();
    expect(r.media_ref).toBe("media_gen_0");
    expect(r.path).toBeUndefined(); // the model gets a ref, never a path
    // The turn must not carry a length the audio may not have, nor timings it no longer owns.
    expect(r.duration_s).toBeUndefined();
    expect(r.words).toBeUndefined();
    expect(r.word_count).toBeUndefined();
    // Transcription is the library's job now, on its own pass — never inline, and never twice.
    expect(whisper).not.toHaveBeenCalled();

    // Measured length/rate/channels are knowable ONLY inside the job, so they must ride to the
    // library row rather than being dropped by the early return.
    expect(jobMeta().duration_s).toBe(1); // 48000 bytes / 2 / 1ch / 24000 = 1.0s
    expect(jobMeta().sample_rate).toBe(24000);
    expect(jobMeta().channels).toBe(1);

    const { name, body } = lastProxyCall();
    expect(name).toBe("voiceover");
    expect(body.args.model).toBe("gemini-3.1-flash-tts-preview");
    expect(body.args.text).toBe("hello world");
    expect(body.args.voice).toBe("Charon");
    expect(body.args.language).toBe("");
  });

  it("submits without the turn's abort signal — Stop must not cancel a call already paid for", async () => {
    proxyResult({ ok: true, pcm_b64: "p", mime: "audio/l16; rate=24000; channels=1" });
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(proxy.mock.calls[0][2]).toBeUndefined();
  });

  it("threads voice, model, style (colon-stripped) and language through", async () => {
    proxyResult({ ok: true, pcm_b64: "p", mime: "audio/l16; rate=24000; channels=1" });
    const r = await runTool(
      "generate_voiceover",
      {
        text: "read this",
        voice: "Puck",
        style: "excited:",
        language: "en",
        model: "gemini-tts-pro-2.5",
      },
      voiceCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.voice).toBe("Puck");
    expect(r.model).toBe("gemini-2.5-pro-preview-tts");
    expect(r.style).toBe("excited:");
    expect(r.language).toBe("en");
    const { body } = lastProxyCall();
    expect(body.args.model).toBe("gemini-2.5-pro-preview-tts");
    expect(body.args.text).toBe("excited: read this"); // trailing ":" trimmed then re-joined
    expect(body.args.voice).toBe("Puck");
    expect(body.args.language).toBe("en");
  });

  it("parses a non-default rate + channel count from the pcm mime", async () => {
    proxyResult({ ok: true, pcm_b64: "p", mime: "audio/l16; rate=48000; channels=2" });
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobMeta().sample_rate).toBe(48000);
    expect(jobMeta().channels).toBe(2);
    expect(jobMeta().duration_s).toBe(0.25); // 48000 / 2 / 2ch / 48000 = 0.25s
  });

  it("floors a zero channel count to 1 for the duration maths", async () => {
    proxyResult({ ok: true, pcm_b64: "p", mime: "audio/l16; rate=24000; channels=0" });
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobMeta().channels).toBe(0); // reported as-is
    expect(jobMeta().duration_s).toBe(1); // 48000 / 2 / max(1,0) / 24000 = 1.0s
  });

  it("keeps mime defaults when rate/channels are unparseable", async () => {
    proxyResult({ ok: true, pcm_b64: "p", mime: "audio/l16; rate=abc; channels=xyz" });
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobMeta().sample_rate).toBe(24000);
    expect(jobMeta().channels).toBe(1);
  });

  it("defaults the mime entirely when absent", async () => {
    proxyResult({ ok: true, pcm_b64: "p" }); // no mime key
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobMeta().sample_rate).toBe(24000);
    expect(jobMeta().channels).toBe(1);
  });
});

// A submitted call cannot fail the TURN — the turn is already over. Each of these fails inside
// the job, so what must survive is the reason, carried to the settle that marks the clip failed.
describe("generate_voiceover — failures", () => {
  it("surfaces a model-side failure with its error", async () => {
    proxyResult({ ok: false, error: "tts boom" });
    const r = await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(r.ok).toBe(true); // the SUBMIT succeeded
    expect(jobError).toBe("tts boom");
  });

  it("surfaces a bare model-side failure with a default message", async () => {
    proxyResult({ ok: false });
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobError).toBe("voiceover synthesis failed");
  });

  it("treats a missing pcm payload as a failure", async () => {
    proxyResult({ ok: true }); // no pcm_b64
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobError).toBe("voiceover synthesis failed");
  });

  it("treats a missing result envelope as a failure", async () => {
    proxy.mockResolvedValue({} as Any); // no `result` key => `dto.result ?? {}`
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobError).toBe("voiceover synthesis failed");
  });

  it("propagates a proxy transport failure (Error) to the job", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobError).toBe("net down");
  });

  it("propagates a proxy transport failure (non-Error, e.g. rate_limited) to the job", async () => {
    proxy.mockRejectedValue("rate_limited");
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobError).toBe("rate_limited");
  });

  it("never writes a library row when synthesis fails", async () => {
    proxyResult({ ok: false, error: "tts boom" });
    await runTool("generate_voiceover", { text: "hi" }, voiceCtx());
    expect(jobOutputs).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("generate_music — guards", () => {
  it("returns NOT_READY when the runtime context is null", async () => {
    const r = await runTool("generate_music", { prompt: "x" }, null);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("runtime not ready");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("requires at least one of prompt, mood, or genre", async () => {
    const r = await runTool("generate_music", {}, musicCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("at least one of prompt, mood, or genre");
  });

  it("rejects a non-numeric bpm", async () => {
    const r = await runTool("generate_music", { prompt: "x", bpm: "abc" }, musicCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("bpm must be a number");
  });

  it("rejects a non-numeric seed", async () => {
    const r = await runTool("generate_music", { prompt: "x", seed: "abc" }, musicCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("seed must be an integer");
  });

  it("rejects an unknown music model (wrong category)", async () => {
    const r = await runTool(
      "generate_music",
      { prompt: "x", model: "gemini-tts-flash" },
      musicCtx(),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown music model 'gemini-tts-flash'");
  });

  it("rejects an unknown music model (absent id)", async () => {
    const r = await runTool("generate_music", { prompt: "x", model: "zzz" }, musicCtx());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown music model 'zzz'");
  });
});

describe("generate_music — success", () => {
  it("generates an instrumental bed with defaults", async () => {
    musicOk();
    const r = await runTool("generate_music", { prompt: "lofi beat" }, musicCtx());
    expect(r.ok).toBe(true);
    expect(r.model).toBe("lyria-002");
    expect(r.prompt).toBe("instrumental, lofi beat");
    expect(r.instrumental).toBe(true);
    expect(r.seed).toBeNull();
    expect(r.status).toBe("generating");
    expect(r.media_ref).toBe("media_gen_0");
    expect(r.path).toBeUndefined(); // the model gets a ref, never a path
    // Only the JOB can know these — they come from the response and the probe.
    expect(jobMeta().lyrics).toBeNull();
    expect(jobMeta().duration_s).toBe(3.2);
    expect(jobMeta().sample_rate).toBe(44100);
    expect(jobMeta().channels).toBe(2);

    const { name, body } = lastProxyCall();
    expect(name).toBe("music");
    expect(body.args.backend_id).toBe("lyria-002");
    expect(body.args.prompt).toBe("instrumental, lofi beat");
    expect(body.args.interactions).toBe(false);
    expect(body.args.negative_prompt).toBe("vocals, singing, lyrics, spoken word");
    expect(body.args.seed).toBeNull();
  });

  it("composes the full control set on a lyrics-capable model (mp3 source)", async () => {
    musicOk({ format: "mp3", lyrics: "generated lyrics" });
    const r = await runTool(
      "generate_music",
      {
        prompt: "my prompt",
        mood: "happy",
        genre: "rock",
        bpm: 120.7,
        style_instructions: "epic strings",
        lyrics: "la la",
        seed: 7,
        model: "lyria-3-clip",
      },
      musicCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.model).toBe("lyria-3-clip-preview");
    expect(r.prompt).toBe("rock, happy, 120 BPM, epic strings, my prompt\nLyrics:\nla la");
    expect(r.instrumental).toBe(false); // forced off by lyrics
    expect(jobMeta().lyrics).toBe("generated lyrics");
    expect(r.seed).toBe(7);

    const { body } = lastProxyCall();
    expect(body.args.backend_id).toBe("lyria-3-clip-preview");
    expect(body.args.interactions).toBe(true);
    expect(body.args.negative_prompt).toBe(""); // non-instrumental => no negative
    expect(body.args.seed).toBe(7);
  });

  it("drops lyrics + style instructions on a model that lacks support", async () => {
    musicOk();
    const r = await runTool(
      "generate_music",
      { prompt: "x", lyrics: "la la", style_instructions: "epic" },
      musicCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.instrumental).toBe(true); // lyrics stripped => stays instrumental
    expect(r.prompt).toBe("instrumental, x");
    expect(jobMeta().lyrics).toBeNull();
  });

  it("honours an explicit instrumental=false without lyrics", async () => {
    musicOk();
    const r = await runTool("generate_music", { prompt: "x", instrumental: false }, musicCtx());
    expect(r.ok).toBe(true);
    expect(r.instrumental).toBe(false);
    expect(r.prompt).toBe("x"); // no "instrumental" token
    expect(lastProxyCall().body.args.negative_prompt).toBe("");
  });

  it("passes with mood-only (prompt absent from the composed string)", async () => {
    musicOk();
    const r = await runTool("generate_music", { mood: "chill" }, musicCtx());
    expect(r.ok).toBe(true);
    expect(r.prompt).toBe("chill, instrumental");
  });

  it("falls back to the source file when the re-mux fails (non-zero exit)", async () => {
    musicOk();
    const r = await runTool("generate_music", { prompt: "x" }, musicCtx({ ffmpegCode: 1 }));
    expect(r.ok).toBe(true);
    expect(jobMeta().duration_s).toBe(3.2); // still probed (of the source path)
  });

  it("falls back to the source file when the re-mux writes no output", async () => {
    musicOk();
    const r = await runTool("generate_music", { prompt: "x" }, musicCtx({ writeOut: false }));
    expect(r.ok).toBe(true);
  });

  it("uses metadata defaults when the probe reports no audio stream", async () => {
    musicOk();
    const r = await runTool(
      "generate_music",
      { prompt: "x" },
      musicCtx({ ffprobe: PROBE_VIDEO_ONLY }),
    );
    expect(r.ok).toBe(true);
    expect(jobMeta().duration_s).toBe(5.5); // duration still read
    expect(jobMeta().sample_rate).toBe(48000); // default (no audio stream)
    expect(jobMeta().channels).toBe(2); // default
  });

  it("keeps the default sample rate on an unparseable probe rate but adopts channels", async () => {
    musicOk();
    const r = await runTool(
      "generate_music",
      { prompt: "x" },
      musicCtx({ ffprobe: PROBE_AUDIO_NAN }),
    );
    expect(r.ok).toBe(true);
    expect(jobMeta().duration_s).toBe(0); // no duration in this probe
    expect(jobMeta().sample_rate).toBe(48000); // "notanum" => keep default
    expect(jobMeta().channels).toBe(6); // channels adopted
  });

  it("uses metadata defaults when the probe itself throws", async () => {
    musicOk();
    const r = await runTool("generate_music", { prompt: "x" }, musicCtx({ ffprobeThrows: true }));
    expect(r.ok).toBe(true);
    expect(jobMeta().duration_s).toBe(0);
    expect(jobMeta().sample_rate).toBe(48000);
    expect(jobMeta().channels).toBe(2);
  });

  it("defaults the format to wav when the payload omits it", async () => {
    proxyResult({ ok: true, audio_b64: "aud" }); // no format key
    const r = await runTool("generate_music", { prompt: "x" }, musicCtx());
    expect(r.ok).toBe(true);
  });
});

describe("generate_music — failures", () => {
  // The tool has already succeeded by handing back a placeholder, so every reason below has to
  // reach the JOB. If it did not, the failure would be invisible to everyone.
  it("fails the job with the model-side error", async () => {
    proxyResult({ ok: false, error: "music boom" });
    const r = await runTool("generate_music", { prompt: "x" }, musicCtx());
    expect(r.ok).toBe(true);
    expect(jobError).toBe("music boom");
  });

  it("fails the job with a default message when the model gives none", async () => {
    proxyResult({ ok: false });
    await runTool("generate_music", { prompt: "x" }, musicCtx());
    expect(jobError).toBe("music generation failed");
  });

  it("fails the job when the audio payload is missing", async () => {
    proxyResult({ ok: true }); // no audio_b64
    await runTool("generate_music", { prompt: "x" }, musicCtx());
    expect(jobError).toBe("music generation failed");
  });

  it("fails the job when the result envelope is missing", async () => {
    proxy.mockResolvedValue({} as Any);
    await runTool("generate_music", { prompt: "x" }, musicCtx());
    expect(jobError).toBe("music generation failed");
  });

  it("fails the job on a proxy transport failure (Error)", async () => {
    proxy.mockRejectedValue(new Error("net down"));
    const r = await runTool("generate_music", { prompt: "x" }, musicCtx());
    expect(r.ok).toBe(true);
    expect(jobError).toBe("net down");
  });

  it("fails the job on a proxy transport failure (non-Error, e.g. rate_limited)", async () => {
    proxy.mockRejectedValue("rate_limited");
    await runTool("generate_music", { prompt: "x" }, musicCtx());
    expect(jobError).toBe("rate_limited");
  });
});
