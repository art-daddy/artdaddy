// A look must answer within its bound whatever the speech model's download, the engine and the
// queue are doing, and leave the work running for the next look. These drive the REAL
// transcription path (runWhisper, the model install, the one-run-per-file join, the app cache)
// behind buildTranscript, with a fake engine, a fake origin and a fake clock, and check what the
// look ANSWERS rather than how it got there.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportAppError, reportTranscription } = vi.hoisted(() => ({
  reportAppError: vi.fn(),
  reportTranscription: vi.fn(),
}));
vi.mock("../api/appEvents", async (orig) => ({
  ...(await orig<object>()),
  reportAppError,
  reportTranscription,
}));
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "C:/res/fonts" }));

import type { ClientToolContext } from "./context";
import { buildTranscript } from "./inspect";
import { clearModelDownload } from "../store/modelDownload";
import { cpuOnlyNow, CPU_ONLY_HOLD_MS } from "./speechBackend";
import { TRANSCRIPT_FAILURE_REASONS, type TranscriptFailureReason } from "./speechFailure";
import { readPace } from "./speechPace";
import { transcriptCacheSlot, WHISPER_MODELS, whisperModelPath } from "./transcribe";
import { __resetWaiting } from "./transcriptWait";
import { __resetWorkGate } from "./workGate";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const DIR = "C:/data/projects/p1";
const WORK = "C:/Users/u/AppData/Local/com.artdaddy.app/work/launch-1-1";
const MODEL = whisperModelPath(DIR, "small");
const SPOKEN = JSON.stringify({
  result: { language: "en" },
  transcription: [
    {
      offsets: { from: 0, to: 2000 },
      text: " hello there",
      tokens: [
        { text: " hello", offsets: { from: 0, to: 900 }, p: 0.9 },
        { text: " there", offsets: { from: 900, to: 2000 }, p: 0.9 },
      ],
    },
  ],
});

/** What whisper prints about a run of `audio` seconds that took `wall` seconds (whisperFacts.ts). */
const timings = (audio: number, wall: number): string =>
  `main: processing 'x.wav' (${audio * 16000} samples, ${audio}.0 sec), 6 threads, 1 processors\n` +
  `whisper_print_timings:    total time = ${wall * 1000}.00 ms\n`;

interface RigOptions {
  /** The speech model is installed (default). Otherwise it has to be downloaded. */
  model?: boolean;
  /** How long the fake engine takes, in fake ms. */
  engineMs?: number;
  engineExit?: number;
  engineStderr?: string;
  /** Exits 0 and writes nothing, as whisper does for a language it does not know. */
  noOutput?: boolean;
  /** The first N engine runs fail (exit 1); later ones succeed. */
  engineFailures?: number;
  ffmpegExit?: number;
  /** Crashes with this exit status, having named a GPU, whenever the engine runs on the GPU. */
  gpuCrash?: number;
  /** The engine crashes with the GPU off too (the GPU was not the cause). */
  cpuCrashes?: boolean;
  signal?: AbortSignal;
}

/** What whisper-cli printed before it crashed on one AMD machine (no names of people or files). */
const GPU_LOG =
  "ggml_vulkan: Found 1 Vulkan devices:\nggml_vulkan: 0 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1\n" +
  "whisper_init_from_file_with_params_no_state: loading model from 'ggml-small.bin'\n";

/** Aborted after every test: a fake engine and a stalled download both end on their signal. */
const stops: AbortController[] = [];

function rig(opts: RigOptions = {}) {
  const installed = opts.model ?? true;
  const files = new Set<string>(installed ? [MODEL] : []);
  const texts = new Map<string, string>();
  const kept = new Map<string, unknown>();
  const calls: { program: string; args: string[] }[] = [];
  let engineStarts = 0;
  let failuresLeft = opts.engineFailures ?? 0;
  const own = new AbortController();
  stops.push(own);
  const signal = opts.signal ?? own.signal;
  if (opts.signal) opts.signal.addEventListener("abort", () => own.abort(), { once: true });

  const sleep = (ms: number, s: AbortSignal | undefined): Promise<boolean> =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      s?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve(true);
        },
        { once: true },
      );
    });

  const store = {
    projectDir: DIR,
    fileIdentity: async (src: string) => `file:${src}`,
    appCache: async () => ({
      get: async (ns: string, key: string) => kept.get(`${ns}|${key}`) ?? null,
      put: async (ns: string, key: string, value: unknown) => (
        kept.set(`${ns}|${key}`, value),
        true
      ),
    }),
    prepareWork: async (rel: string) => `${WORK}/${rel}`,
    exists: async (p: string) => files.has(p),
    readText: async (p: string) => texts.get(p) ?? SPOKEN,
    writeText: async (p: string, s: string) => (files.add(p), void texts.set(p, s)),
    canRename: true,
    rename: async (from: string, to: string) => (files.delete(from), void files.add(to)),
    remove: async (p: string) => void files.delete(p),
    byteSize: async (p: string) => (p === MODEL ? WHISPER_MODELS.small.bytes : 0),
    probeMedia: async () => ({
      id12: WHISPER_MODELS.small.sha256.slice(0, 12),
      sha256: WHISPER_MODELS.small.sha256,
      size: WHISPER_MODELS.small.bytes,
      head: new Uint8Array(),
    }),
    canStreamDownload: true,
    appendBytes: async () => true,
    resolveRef: async (r: string) => r,
  };
  const runner = {
    run: async (program: string, args: string[], s?: AbortSignal) => {
      calls.push({ program, args });
      if (program === "ffmpeg") {
        if (opts.ffmpegExit) return { code: opts.ffmpegExit, stdout: "", stderr: "Invalid data" };
        files.add(args[args.length - 1]);
        return { code: 0, stdout: "", stderr: "" };
      }
      engineStarts++;
      const cpuOnly = args.includes("-ng");
      if (opts.gpuCrash !== undefined && (!cpuOnly || opts.cpuCrashes)) {
        if (opts.engineMs) await sleep(opts.engineMs, s); // a crash comes when it comes, Stop or not
        return { code: opts.gpuCrash, stdout: "", stderr: GPU_LOG };
      }
      if (opts.engineMs && (await sleep(opts.engineMs, s)))
        return { code: 1, stdout: "", stderr: "cancelled" };
      const stderr =
        (cpuOnly ? "whisper_backend_init_gpu: no GPU found\n" : "") + (opts.engineStderr ?? "");
      if (failuresLeft > 0) {
        failuresLeft--;
        return { code: 1, stdout: "", stderr: "device lost" };
      }
      if (opts.engineExit) return { code: opts.engineExit, stdout: "", stderr };
      if (opts.noOutput) return { code: 0, stdout: "", stderr };
      const out = `${args[args.indexOf("-of") + 1]}.json`;
      files.add(out);
      texts.set(out, SPOKEN);
      return { code: 0, stdout: "", stderr };
    },
  };
  const ctx = { store, runner, signal } as unknown as ClientToolContext;
  return { ctx, engineRuns: () => engineStarts, calls, signal: own };
}

let seq = 0;
/** A file nobody has asked about: a run still going from another test is never joined. */
const freshSrc = (): string => `/media/clip-${++seq}.mp4`;

const look = (seconds: number, extra: Record<string, unknown> = {}) => ({
  start: null,
  end: seconds,
  duration: seconds,
  wordTimestamps: false,
  language: "",
  waitMs: 15_000,
  ...extra,
});

/** Starts a look and records when and with what it answered, on the fake clock. */
function startLook(ctx: ClientToolContext, src: string, opts: ReturnType<typeof look>) {
  const t0 = Date.now();
  const seen: { at: number | null; result: Any } = { at: null, result: undefined };
  void buildTranscript(ctx, src, opts).then((r) => {
    seen.at = Date.now() - t0;
    seen.result = r;
  });
  return seen;
}

/** Lets the promise chains behind a finished or aborted run play out. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** A speech-model origin that accepts the request and never sends a byte. */
function stalledOrigin() {
  const fetchMock = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(WHISPER_MODELS.small.bytes) }),
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_, reject) =>
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              }),
            ),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    } as unknown as Response;
  });
  return { fetch: fetchMock, requests: () => fetchMock.mock.calls.length };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  __resetWaiting();
  reportAppError.mockClear();
});

afterEach(async () => {
  for (const s of stops.splice(0)) s.abort();
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetWorkGate();
  clearModelDownload();
});

describe("a look that has to wait for a transcript", () => {
  it("answers at the bound with an estimate while a 40 s engine goes on, and the next look has the words", async () => {
    const { ctx, engineRuns } = rig({ engineMs: 40_000 });
    const src = freshSrc();
    const first = startLook(ctx, src, look(30));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(first.at, "answered before its bound").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.at).toBe(15_000);
    expect(first.result).toMatchObject({
      status: "in_progress",
      stage: "transcribing",
      waited_s: 15,
    });
    expect(first.result.eta_s).toBeGreaterThanOrEqual(1);
    expect(first.result.note).toMatch(/not ready/);
    expect(first.result.note).toMatch(/Do not guess/);
    expect(first.result.segments, "no words yet, so none are invented").toBeUndefined();
    expect(engineRuns()).toBe(1);

    await vi.advanceTimersByTimeAsync(26_000); // the engine lands at 40 s, nobody waiting
    const before = Date.now();
    const second = await buildTranscript(ctx, src, look(30));
    expect(second.segments).toEqual([["hello there", 0, 2]]);
    expect(Date.now() - before, "the second look waited for nothing").toBe(0);
    expect(engineRuns(), "the work done after the first look was not done again").toBe(1);
  });

  it("with wait_seconds raised to 60, waits past 15 s and returns words that land at 30 s", async () => {
    const { ctx, engineRuns } = rig({ engineMs: 30_000 });
    const seen = startLook(ctx, freshSrc(), look(30, { waitMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(seen.at).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.at).toBe(30_000);
    expect(seen.result.segments).toEqual([["hello there", 0, 2]]);
    expect(seen.result.status).toBeUndefined();
    expect(engineRuns()).toBe(1);
  });

  it("with wait_seconds 0, starts the work and does not wait for it", async () => {
    const { ctx, engineRuns } = rig({ engineMs: 5_000 });
    const src = freshSrc();
    const seen = startLook(ctx, src, look(30, { waitMs: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at).toBe(0);
    expect(seen.result).toMatchObject({ status: "in_progress", waited_s: 0 });
    expect(seen.result.note).not.toMatch(/this call waited/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engineRuns(), "the engine was started, though nobody waited").toBe(1);
    expect((await buildTranscript(ctx, src, look(30))).segments).toEqual([["hello there", 0, 2]]);
  });

  it("makes ONE engine run when two looks ask for the same file at once", async () => {
    const { ctx, engineRuns } = rig({ engineMs: 40_000 });
    const src = freshSrc();
    const a = startLook(ctx, src, look(30));
    const b = startLook(ctx, src, look(30));
    await vi.advanceTimersByTimeAsync(15_000);
    expect([a.result?.status, b.result?.status]).toEqual(["in_progress", "in_progress"]);
    await vi.advanceTimersByTimeAsync(26_000);
    expect((await buildTranscript(ctx, src, look(30))).segments).toHaveLength(1);
    expect(engineRuns()).toBe(1);
  });

  it("answers a transcript already kept at once, with no engine and no waiting", async () => {
    const { ctx, engineRuns } = rig({ engineMs: 40_000 });
    const src = freshSrc();
    const { namespace, key } = await transcriptCacheSlot(ctx, src);
    await (await ctx.store.appCache())!.put(namespace, key!, JSON.parse(SPOKEN));
    const before = Date.now();
    const got = await buildTranscript(ctx, src, look(30));
    expect(got.segments).toEqual([["hello there", 0, 2]]);
    expect(Date.now() - before).toBe(0);
    expect(engineRuns()).toBe(0);
  });

  it("is ended by Stop within a second, and the engine it started is stopped with it", async () => {
    const stop = new AbortController();
    const { ctx } = rig({ engineMs: 40_000, signal: stop.signal });
    const seen = startLook(ctx, freshSrc(), look(30, { waitMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen.at).toBeNull();
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.result).toEqual({ error: "cancelled" });
    expect(seen.at!).toBeLessThanOrEqual(1_000);
    await settle(); // the run it left behind ends cancelled; nothing is left unhandled
  });

  it("answers a failure that came after the bound as nothing, and the next look starts afresh", async () => {
    const { ctx, engineRuns } = rig({ engineMs: 20_000, engineFailures: 1 });
    const src = freshSrc();
    const first = startLook(ctx, src, look(30));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.result.status).toBe("in_progress");
    await vi.advanceTimersByTimeAsync(6_000); // the engine failed at 20 s, after the look had gone
    const second = startLook(ctx, src, look(30, { waitMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(second.result.segments, "a failure is not kept as an answer").toEqual([
      ["hello there", 0, 2],
    ]);
    expect(engineRuns()).toBe(2);
  });

  it("gives a machine that has measured itself fast a shorter estimate than one with no history", async () => {
    const unmeasured = rig({ engineMs: 600_000 });
    const none = startLook(unmeasured.ctx, freshSrc(), look(30, { waitMs: 2_000 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(none.result.status).toBe("in_progress");
    unmeasured.signal.abort(); // a look's engine runs alone: free it for the next
    await settle();

    // A run of 30 s of speech that took 6 s: the machine's own pace, kept for the next estimate.
    const measured = rig({ engineStderr: timings(30, 6) });
    await buildTranscript(measured.ctx, freshSrc(), look(30));
    expect(readPace()).toEqual([[30, 6]]);

    const again = rig({ engineMs: 600_000 });
    const fast = startLook(again.ctx, freshSrc(), look(30, { waitMs: 2_000 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fast.result.eta_s).toBeLessThan(none.result.eta_s);
  });
});

describe("a look that has to wait for the speech model", () => {
  it("answers at the bound while the download is stalled, and says so", async () => {
    const origin = stalledOrigin();
    vi.stubGlobal("fetch", origin.fetch);
    const { ctx, engineRuns } = rig({ model: false });
    const seen = startLook(ctx, freshSrc(), look(30));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(seen.at).toBe(15_000);
    expect(seen.result).toMatchObject({
      status: "in_progress",
      stage: "downloading_speech_model",
      progress_pct: 0,
    });
    expect(seen.result.note).toMatch(/model is still downloading/);
    expect(seen.result.note).toMatch(/one-time/);
    expect(origin.requests()).toBe(1);
    expect(engineRuns(), "nothing is transcribed before the model is there").toBe(0);
  });

  // UJ-052: one turn took 81 minutes. The agent looked at four files at once while the speech model
  // downloaded at under 1 Mbit/s, and every look waited for the whole download.
  it("replays the 81-minute turn: four looks at once on a stalled download all answer in 15 s", async () => {
    const origin = stalledOrigin();
    vi.stubGlobal("fetch", origin.fetch);
    const { ctx } = rig({ model: false });
    const looks = [freshSrc(), freshSrc(), freshSrc(), freshSrc()].map((src) =>
      startLook(ctx, src, look(30)),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(looks.map((l) => l.at)).toEqual([15_000, 15_000, 15_000, 15_000]);
    for (const l of looks)
      expect(l.result).toMatchObject({ status: "in_progress", stage: "downloading_speech_model" });
    expect(origin.requests(), "the four looks shared one download").toBe(1);
  });

  // Not set in this file, so this is what the app does: an origin that keeps failing is tried again
  // from where it stopped, after 2, 10 and 30 s, and only then is the failure the look's.
  it("is patient by default: a failing origin is retried with back-off, and the look says how often", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: new Headers(),
      body: null,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = rig({ model: false });
    const seen = startLook(ctx, freshSrc(), look(30, { waitMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(41_999);
    expect(seen.at, "still trying").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.at).toBe(42_000);
    expect(seen.result).toMatchObject({ status: "failed", reason: "model_unavailable" });
    expect(seen.result.error).toMatch(/HTTP 503 \(after 4 attempts\)/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not hold the download hostage: Stop ends the look, and the download stops with it", async () => {
    const origin = stalledOrigin();
    vi.stubGlobal("fetch", origin.fetch);
    const stop = new AbortController();
    const { ctx } = rig({ model: false, signal: stop.signal });
    const seen = startLook(ctx, freshSrc(), look(30, { waitMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(2_000);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.result).toEqual({ error: "cancelled" });
    await settle();
  });
});

describe("a look that names a language", () => {
  const engineLanguage = (calls: { program: string; args: string[] }[]): string[] =>
    calls.filter((c) => c.program === "whisper-cli").map((c) => c.args[c.args.indexOf("-l") + 1]);

  // UJ-063: the agent passed "fil", whisper-cli printed its usage and exited 0, and 19 calls failed.
  it("is transcribed in the engine's name for it: fil as tl, jpn as ja", async () => {
    const { ctx, calls } = rig();
    expect(
      (await buildTranscript(ctx, freshSrc(), look(30, { language: "fil" }))).segments,
    ).toBeTruthy();
    expect(
      (await buildTranscript(ctx, freshSrc(), look(30, { language: "jpn" }))).segments,
    ).toBeTruthy();
    expect(engineLanguage(calls)).toEqual(["tl", "ja"]);
  });

  it("shares one transcript between every name for the language", async () => {
    const { ctx, engineRuns } = rig();
    const src = freshSrc();
    await buildTranscript(ctx, src, look(30, { language: "jpn" }));
    for (const alias of ["ja", "JA", "ja-JP", "japanese"]) {
      const again = await buildTranscript(ctx, src, look(30, { language: alias }));
      expect(again.segments, alias).toEqual([["hello there", 0, 2]]);
    }
    expect(engineRuns()).toBe(1);
  });

  it("detects the language when the engine does not know the one named, and says so", async () => {
    const { ctx, calls } = rig();
    const got = await buildTranscript(ctx, freshSrc(), look(30, { language: "klingon" }));
    expect(got.segments).toBeTruthy();
    expect(engineLanguage(calls), "the engine is never handed a language it would refuse").toEqual([
      "auto",
    ]);
    expect(got.language_note).toMatch(/"klingon" is not one the speech engine knows/);
  });

  it("has nothing to say when the language is fine", async () => {
    const { ctx } = rig();
    const got = await buildTranscript(ctx, freshSrc(), look(30, { language: "es" }));
    expect(got.language_note).toBeUndefined();
  });

  it("still names the engine's refusal as a refusal, should a language slip past the table", async () => {
    const { ctx } = rig({
      noOutput: true,
      engineStderr: "error: unknown language 'zz'\nusage: whisper-cli [options] file0 file1",
    });
    const got = await buildTranscript(ctx, freshSrc(), look(30, { language: "es" }));
    expect(got).toMatchObject({ status: "failed", reason: "language_rejected" });
    expect(got.error).toBe('the speech engine did not accept the language "zz"');
    expect(String(got.error), "never the engine's help text").not.toMatch(/usage/i);
  });
});

// UJ-052/UJ-063: on some machines whisper-cli crashes outright on the GPU (exit 0xC0000409 right
// after it began to load the model, on AMD, Intel and NVIDIA), and every transcription there failed
// the same way, three times per file in the background indexer: 226 retries from three users.
describe("an engine that crashes on the GPU", () => {
  const CRASH = -1073740791; // 0xC0000409
  const onCpu = (calls: { program: string; args: string[] }[]): boolean[] =>
    calls.filter((c) => c.program === "whisper-cli").map((c) => c.args.includes("-ng"));

  it("is retried once with the GPU off, and the look gets its words", async () => {
    const { ctx, calls } = rig({ gpuCrash: CRASH });
    const got = await buildTranscript(ctx, freshSrc(), look(30));
    expect(got.segments).toEqual([["hello there", 0, 2]]);
    expect(onCpu(calls), "one run on the GPU, then one without it").toEqual([false, true]);
  });

  it("is remembered: the next file goes straight to the CPU, and nothing after it crashes first", async () => {
    const { ctx, calls } = rig({ gpuCrash: CRASH });
    await buildTranscript(ctx, freshSrc(), look(30));
    for (let i = 0; i < 3; i++) await buildTranscript(ctx, freshSrc(), look(30));
    expect(onCpu(calls)).toEqual([false, true, true, true, true]);
  });

  it("is given the GPU again after a week, because drivers are updated", async () => {
    const { ctx, calls } = rig({ gpuCrash: CRASH });
    await buildTranscript(ctx, freshSrc(), look(30));
    vi.setSystemTime(Date.now() + CPU_ONLY_HOLD_MS - 1);
    await buildTranscript(ctx, freshSrc(), look(30));
    expect(onCpu(calls).slice(2), "still off one ms before the week is out").toEqual([true]);
    vi.setSystemTime(Date.now() + 2);
    await buildTranscript(ctx, freshSrc(), look(30));
    expect(onCpu(calls).slice(3), "tried again, and crashed again, and retried").toEqual([
      false,
      true,
    ]);
  });

  it("is not blamed on the GPU when the CPU run crashes too: nothing is remembered, and the look says it failed", async () => {
    const { ctx, calls } = rig({ gpuCrash: CRASH, cpuCrashes: true });
    const got = await buildTranscript(ctx, freshSrc(), look(30));
    expect(onCpu(calls), "two runs, never a third").toEqual([false, true]);
    expect(got).toMatchObject({ status: "failed", reason: "engine_failed" });
    expect(cpuOnlyNow(), "the GPU was not proved to be the cause").toBe(false);
    await buildTranscript(ctx, freshSrc(), look(30));
    expect(onCpu(calls).slice(2), "the next file tries the GPU first again").toEqual([false, true]);
  });

  it("is not retried for a failure that is not a crash, or a crash that is not the GPU's", async () => {
    const plain = rig({ engineExit: 1, engineStderr: GPU_LOG });
    await buildTranscript(plain.ctx, freshSrc(), look(30));
    expect(onCpu(plain.calls)).toEqual([false]);

    const noGpu = rig({ engineExit: CRASH, engineStderr: "whisper_init_from_file: loading model" });
    await buildTranscript(noGpu.ctx, freshSrc(), look(30));
    expect(onCpu(noGpu.calls), "it never named a GPU").toEqual([false]);

    const cannotStart = rig({ engineExit: -1073741515, engineStderr: GPU_LOG });
    expect(await buildTranscript(cannotStart.ctx, freshSrc(), look(30))).toMatchObject({
      reason: "engine_unavailable",
    });
    expect(onCpu(cannotStart.calls), "a missing DLL is not the GPU").toEqual([false]);
  });

  it("is not retried once Stop has been pressed", async () => {
    const stop = new AbortController();
    const { ctx, calls } = rig({ gpuCrash: CRASH, engineMs: 5_000, signal: stop.signal });
    const seen = startLook(ctx, freshSrc(), look(30, { waitMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.result).toEqual({ error: "cancelled" });
    expect(onCpu(calls), "the crash after Stop did not start another run").toEqual([false]);
  });

  it("tells the telemetry once what happened, and which way the transcription then ran", async () => {
    reportTranscription.mockClear();
    const { ctx } = rig({ gpuCrash: -1073740940, engineStderr: timings(30, 20) });
    for (let i = 0; i < 3; i++) await buildTranscript(ctx, freshSrc(), look(30));
    const reports = reportAppError.mock.calls
      .map(([r]) => r)
      .filter((r) => /speech_gpu_crash/.test(r));
    expect(reports, "the same news once per session, not once per file").toHaveLength(1);
    expect(reports[0]).toMatch(/exit -1073740940.*the CPU run worked/);
    expect(
      reportTranscription.mock.calls.map(([facts]) => facts.backend),
      "every run that was kept says it ran on the CPU",
    ).toEqual(["cpu", "cpu", "cpu"]);
  });
});

// Each reason a transcription can fail is a thing the model can act on differently, so each must
// come out of the REAL failure, not out of a hand-built error.
describe("a look whose transcription fails", () => {
  const SCENARIOS: Record<TranscriptFailureReason, () => ReturnType<typeof rig>> = {
    model_unavailable: () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 404, headers: new Headers(), body: null })),
      );
      return rig({ model: false });
    },
    engine_unavailable: () => rig({ engineExit: -1073741515 }),
    language_rejected: () =>
      rig({
        noOutput: true,
        engineStderr: "error: unknown language 'fil'\nusage: whisper-cli [options] file0 file1",
      }),
    audio_extraction_failed: () => rig({ ffmpegExit: 1 }),
    engine_failed: () => rig({ engineExit: 3, engineStderr: "ggml_vulkan: device lost" }),
  };

  it("has a scenario for every reason there is, so a new reason cannot go untested", () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...TRANSCRIPT_FAILURE_REASONS].sort());
  });

  it.each(TRANSCRIPT_FAILURE_REASONS)(
    "%s: the look says why, in a code, a sentence and advice",
    async (reason) => {
      const { ctx } = SCENARIOS[reason]();
      const got = await buildTranscript(ctx, freshSrc(), look(30));
      expect(got).toMatchObject({ status: "failed", reason });
      expect(String(got.error).length).toBeGreaterThan(10);
      expect(String(got.note).length).toBeGreaterThan(20);
      expect(got.segments, "a failure is never an empty transcript").toBeUndefined();
      expect(String(got.error)).not.toMatch(/Error: Error/);
    },
  );

  it("names the HTTP status when the speech model cannot be fetched", async () => {
    const { ctx } = SCENARIOS.model_unavailable();
    expect((await buildTranscript(ctx, freshSrc(), look(30))).error).toMatch(/HTTP 404/);
  });

  it("reports one app_error per file and reason, however often the file is looked at again", async () => {
    const { ctx } = rig({ engineExit: 3 });
    const a = freshSrc();
    const b = freshSrc();
    for (let i = 0; i < 3; i++) await buildTranscript(ctx, a, look(30));
    expect(reportAppError).toHaveBeenCalledTimes(1);
    await buildTranscript(ctx, b, look(30));
    expect(reportAppError).toHaveBeenCalledTimes(2);
    for (const [reason] of reportAppError.mock.calls) {
      expect(reason).toBe("transcript_failed: engine_failed");
      expect(reason, "only the reason leaves the machine").not.toContain("clip-");
    }
  });

  it("is retried by the next look: a failure is never kept as the answer", async () => {
    const { ctx, engineRuns } = rig({ engineFailures: 1 });
    const src = freshSrc();
    expect(await buildTranscript(ctx, src, look(30))).toMatchObject({
      status: "failed",
      reason: "engine_failed",
    });
    expect((await buildTranscript(ctx, src, look(30))).segments).toEqual([["hello there", 0, 2]]);
    expect(engineRuns()).toBe(2);
  });
});
