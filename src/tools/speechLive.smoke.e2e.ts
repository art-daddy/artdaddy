// The real-sidecar proof, P1: the shipped whisper-cli on the PROCESSOR, driven through the app's own code, three runs of
// ONE recording, written as one capture file that speechLive.replay.test.ts then replays with no engine at all.
//   run 1  a full run through runWhisper, every stdout chunk timestamped as it arrives
//   run 2  the same run, Cancel pressed through the chip's own path at KILL_AT_MS: the process, the output file, the result
//   run 3  runWhisper as the background indexer calls it, the chip's store sampled after every chunk
//
// Run:  npx vitest run --config vitest.smoke.config.ts src/tools/speechLive.smoke.e2e.ts
//   ARTDADDY_LIVE_SPEECH_FILE   the recording (20 to 30 minutes of speech, with real pauses)
//   ARTDADDY_LIVE_CAPTURE_OUT   where the capture is written (a file path)
//   ARTDADDY_LIVE_MODEL_DIR     where ggml-small.bin is (default %APPDATA%\ArtDaddy\models)
//   ARTDADDY_LIVE_KILL_AT_S     when run 2 presses Cancel, seconds after launch (default 90)
//   ARTDADDY_LIVE_RUNS          which runs, default "full,kill,app" ("full" is always needed)
//   ARTDADDY_LIVE_CORES         what the app is told the PC has (default: all of them)
//   ARTDADDY_LIVE_FAKE_ENGINE=1 prove the harness with no engine: fakeWhisper.mjs, a made-up recording, a made-up model
// It SKIPS, naming what is missing, unless the shipped sidecars, the engine's libraries, the model, the recording and the output
// path are all there (or the fake engine is asked for). It never touches the network: fetch is replaced for its length.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { reportTranscription, reportAppError } = vi.hoisted(() => ({
  reportTranscription: vi.fn(),
  reportAppError: vi.fn(),
}));
vi.mock("../api/appEvents", async (orig) => ({
  ...(await orig<object>()),
  reportTranscription,
  reportAppError,
}));

import { __resetSpeechJobs, cancelSpeechJob, useSpeechJobs } from "../store/speechJobs";
import { shippedSidecar } from "../test/sidecars";
import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { __resetSpeechSession, isSpeechDeferred } from "./speechAdmission";
import { holdCpuOnly } from "./speechBackend";
import { isSpeechCancelled } from "./speechFailure";
import {
  STDERR_HEAD_BYTES,
  TEXT_POLICY,
  CAPTURE_SCHEMA,
  createTextBlanker,
  readStderrFacts,
  redactPaths,
  sanitizeArgs,
  serializeCapture,
  validateCapture,
  type AppRunCapture,
  type ChipSample,
  type RunCapture,
  type RunExit,
  type SpeechLiveCapture,
  type StdoutChunk,
} from "./speechLiveCapture";
import { SPEECH_PACE_KEY, readPace, recordSpeechRun } from "./speechPace";
import { CAP_S } from "./speechPlan";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { WHISPER_MODELS, runWhisper, whisperModelPath } from "./transcribe";
import { whisperRunFacts } from "./whisperFacts";
import { nodeFs, nodeRunner } from "./__e2e";

const FAKE = process.env.ARTDADDY_LIVE_FAKE_ENGINE === "1";
const RUNS = new Set(
  (process.env.ARTDADDY_LIVE_RUNS ?? "full,kill,app").split(",").map((s) => s.trim()),
);
RUNS.add("full");
const MODEL_DIR =
  process.env.ARTDADDY_LIVE_MODEL_DIR ?? path.join(process.env.APPDATA ?? "", "ArtDaddy", "models");
const REAL_MODEL = path.join(MODEL_DIR, "ggml-small.bin");
/** whisper.cpp's Windows build is dynamic and finds its CPU backend by scanning the folder the process runs in. */
const DLL_DIR = path.resolve(process.cwd(), "src-tauri/resources/whisper");
const FAKE_ENGINE = path.join(__dirname, "__fixtures__", "speechLive", "fakeWhisper.mjs");
/** The made-up recording of the fake engine: sixty windows, two a second. */
const FAKE_AUDIO_S = 1800;
const KILL_AT_MS = FAKE ? 6_000 : Number(process.env.ARTDADDY_LIVE_KILL_AT_S ?? 90) * 1000;
/** A killed process that is still there this long after Cancel is reported as one that survived. */
const SURVIVAL_WATCH_MS = 15_000;
const SCRATCH = path.join(os.tmpdir(), `artdaddy-live-speech-${Date.now()}`);
const PROJ = joinPath(SCRATCH, "projects", "live");
const OUT =
  process.env.ARTDADDY_LIVE_CAPTURE_OUT ?? (FAKE ? path.join(SCRATCH, "capture.json") : "");
const SPEECH_FILE = FAKE
  ? path.join(SCRATCH, "inbox", "personal-name-marker.wav")
  : (process.env.ARTDADDY_LIVE_SPEECH_FILE ?? "");
const whisper = FAKE ? null : shippedSidecar("whisper-cli");
const ffmpeg = FAKE ? null : shippedSidecar("ffmpeg");

const missing: string[] = [];
if (!FAKE) {
  if (!whisper) missing.push("the shipped whisper-cli (src-tauri/binaries)");
  if (!ffmpeg) missing.push("the shipped ffmpeg (src-tauri/binaries), which reads the recording");
  if (!existsSync(DLL_DIR)) missing.push(`its libraries at ${DLL_DIR}`);
  if (!existsSync(REAL_MODEL)) missing.push(`the small model at ${REAL_MODEL}`);
  if (!SPEECH_FILE || !existsSync(SPEECH_FILE))
    missing.push("ARTDADDY_LIVE_SPEECH_FILE (the recording)");
  if (!OUT) missing.push("ARTDADDY_LIVE_CAPTURE_OUT (where to write the capture)");
}
if (missing.length > 0) console.log(`[speechLive] skipped: missing ${missing.join("; ")}`); // eslint-disable-line no-console

// ---------------------------------------------------------------------------------------------------------
// What the app finds in a browser or a desktop shell and a node process does not have.

const restore: Array<() => void> = [];
/** The engines this file started that are still going: a test that times out or throws must not leave one at work
 *  on a shared PC. */
const alive = new Set<ChildProcess>();
function killAlive(): void {
  for (const child of alive) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone already */
    }
  }
  alive.clear();
}
process.once("exit", killAlive);
function installGlobal(name: string, value: unknown): void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  restore.push(() => {
    if (had) Object.defineProperty(globalThis, name, had);
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, String(v)),
  };
}

// ---------------------------------------------------------------------------------------------------------
// One run of the engine, watched.

interface Trace {
  launches: number;
  chunks: StdoutChunk[];
  chip: ChipSample[];
  stderr: string;
  code: number | null;
  args: string[];
  /** Epoch ms of the launch, as the chip's store has it (the app's own clock for the run). */
  launchAt: number;
  closeAt: number | null;
  /** When the runner was told to stop the process (the app's Cancel reached it). */
  abortAt: number | null;
  /** The process was still there SURVIVAL_WATCH_MS after it was told to stop. */
  survived: boolean;
  /** What the engine's own output file held, read before the app reads it and removes it. */
  finalJson?: { segments: number; lastEndS: number };
}

const newTrace = (): Trace => ({
  launches: 0,
  chunks: [],
  chip: [],
  stderr: "",
  code: null,
  args: [],
  launchAt: 0,
  closeAt: null,
  abortAt: null,
  survived: false,
});

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

/** What ffmpeg's extraction is in the fake run: a silent 16 kHz mono 16-bit file of the made-up recording's length. */
async function fakeFfmpeg(args: readonly string[]): Promise<CommandResult> {
  const out = args[args.length - 1];
  const bytes = 44 + FAKE_AUDIO_S * 32_000;
  const wav = Buffer.alloc(bytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(bytes - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(bytes - 44, 40);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, wav);
  return { code: 0, stdout: "", stderr: "" };
}

/** The runner the app is given: the real one for everything but the engine, and for the engine one that spawns it as
 *  the app's own runner does and streams its output, timestamping every chunk on the clock of the app's own record of
 *  the run (the chip's store holds its launch). `killAfterMs`: Cancel is pressed through the chip's own path at that
 *  time. `sampleChip`: the chip's store is read after every chunk the app has heard. */
function engineRunner(
  trace: Trace,
  opts: { killAfterMs?: number; sampleChip?: boolean },
): CommandRunner {
  return {
    async run(program, args, signal, cwd, onStdout) {
      if (program === "ffmpeg" && FAKE) return fakeFfmpeg(args);
      if (program !== "whisper-cli") return nodeRunner.run(program, args, signal, cwd, onStdout);
      return new Promise<CommandResult>((resolve) => {
        trace.launches++;
        const job = useSpeechJobs.getState().jobs[0];
        const launchAt = job?.startedAt ?? Date.now();
        trace.launchAt = launchAt;
        trace.args = [...args];
        const blank = createTextBlanker();
        const child = FAKE
          ? spawn(process.execPath, [FAKE_ENGINE, ...args], { windowsHide: true })
          : spawn(whisper!, args, { cwd: DLL_DIR, windowsHide: true });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        alive.add(child);
        child.once("close", () => alive.delete(child));
        let stdout = "";
        let stderr = "";
        let killed = false;
        let watchdog: NodeJS.Timeout | null = null;
        let killTimer: NodeJS.Timeout | null = null;
        const onAbort = (): void => {
          trace.abortAt ??= Date.now();
          killed = true;
          child.kill("SIGKILL");
          watchdog = setTimeout(() => {
            trace.survived = true;
            try {
              process.kill(child.pid!, "SIGKILL");
            } catch {
              /* it may have gone between the two */
            }
            trace.stderr = stderr;
            resolve({ code: -1, stdout, stderr: "cancelled" });
          }, SURVIVAL_WATCH_MS);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (opts.killAfterMs !== undefined && job)
          killTimer = setTimeout(
            () => cancelSpeechJob(job.id),
            Math.max(0, opts.killAfterMs - (Date.now() - launchAt)),
          );
        child.stdout.on("data", (text: string) => {
          const tMs = Date.now() - launchAt;
          trace.chunks.push({ tMs, text: blank(text) });
          stdout += text;
          onStdout?.(text);
          if (!opts.sampleChip) return;
          const j = useSpeechJobs.getState().jobs[0];
          if (j)
            trace.chip.push({
              tMs,
              phase: j.phase,
              firstWordsMs:
                j.firstWordsAt === null ? null : j.firstWordsAt - (j.startedAt ?? launchAt),
              doneS: j.doneS,
              rate: j.rate,
              etaS: j.etaS,
            });
        });
        child.stderr.on("data", (text: string) => {
          stderr += text;
        });
        child.on("error", (e) => {
          trace.stderr = stderr;
          resolve({ code: -1, stdout, stderr: String(e) });
        });
        child.on("close", async (code) => {
          if (watchdog) clearTimeout(watchdog);
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener("abort", onAbort);
          trace.closeAt = Date.now();
          trace.code = code;
          trace.stderr = stderr;
          const base = flagValue(args, "-of");
          if (base && existsSync(`${base}.json`)) {
            try {
              const json = JSON.parse(await fsp.readFile(`${base}.json`, "utf8")) as {
                transcription?: Array<{ offsets?: { to?: number } }>;
              };
              const list = json.transcription ?? [];
              trace.finalJson = {
                segments: list.length,
                lastEndS: list.length ? (list[list.length - 1].offsets?.to ?? 0) / 1000 : 0,
              };
            } catch {
              /* a cut file is a finding of its own: the app reads it next and says so */
            }
          }
          resolve(killed ? { code: -1, stdout, stderr: "cancelled" } : { code, stdout, stderr });
        });
      });
    },
  };
}

type Outcome = "done" | "cancelled" | "too_slow" | "deferred" | "failed";

interface RunResult {
  trace: Trace;
  outcome: Outcome;
  error: unknown;
  audioS: number;
}

/** Each run gets its own app cache and work folder, so none is answered from another's transcript. */
function ctxFor(label: string, runner: CommandRunner, background: boolean): ClientToolContext {
  const cache = path.join(SCRATCH, "cache", label);
  const work = path.join(SCRATCH, "work", label);
  const fs: FsLike = {
    ...nodeFs,
    cacheDir: async () => {
      await fsp.mkdir(cache, { recursive: true });
      return cache;
    },
    workDir: async () => {
      await fsp.mkdir(work, { recursive: true });
      return work;
    },
  };
  return {
    store: new ProjectStoreAccess(PROJ, fs),
    runner,
    ...(background ? { background: true } : {}),
  };
}

async function doRun(
  label: string,
  opts: { killAfterMs?: number; sampleChip?: boolean; background?: boolean },
): Promise<RunResult> {
  __resetSpeechJobs();
  __resetSpeechSession();
  const trace = newTrace();
  const ctx = ctxFor(label, engineRunner(trace, opts), opts.background === true);
  let outcome: Outcome = "done";
  let error: unknown;
  try {
    await runWhisper(ctx, SPEECH_FILE);
  } catch (e) {
    error = e;
    outcome = isSpeechCancelled(e)
      ? "cancelled"
      : isSpeechDeferred(e)
        ? e.stopped
          ? "too_slow"
          : "deferred"
        : "failed";
  }
  const audioS = whisperRunFacts(trace.stderr).audioSeconds ?? 0;
  const wallS = trace.closeAt === null ? 0 : (trace.closeAt - trace.launchAt) / 1000;
  console.log(
    `[speechLive] ${label}: ${outcome}, ${trace.chunks.length} chunks, ${audioS.toFixed(1)} s of audio in ${wallS.toFixed(1)} s, ${trace.launches} launch(es)`,
  ); // eslint-disable-line no-console
  return { trace, outcome, error, audioS };
}

// ---------------------------------------------------------------------------------------------------------
// The capture.

function needles(): string[] {
  const list = [os.homedir(), os.tmpdir(), SCRATCH, PROJ, os.hostname()];
  try {
    const user = os.userInfo().username;
    if (user.length >= 4) list.push(user);
  } catch {
    /* no user name to find */
  }
  return list.filter((n) => n.length >= 4);
}

function runCapture(r: RunResult, exit: RunExit): RunCapture {
  const t = r.trace;
  const facts = whisperRunFacts(t.stderr);
  return {
    engine: {
      backend: facts.backend ?? "unknown",
      threads: facts.threads,
      model: facts.model,
      args: sanitizeArgs(t.args),
    },
    audioS: r.audioS,
    chunks: t.chunks,
    stderrHead: redactPaths(t.stderr.slice(0, STDERR_HEAD_BYTES), needles()),
    stderrFacts: readStderrFacts(t.stderr),
    ...(t.finalJson ? { finalJson: t.finalJson } : {}),
    exit,
  };
}

const wallMs = (t: Trace): number => (t.closeAt === null ? 0 : t.closeAt - t.launchAt);

describe.skipIf(missing.length > 0)(`the live speech proof${FAKE ? " (fake engine)" : ""}`, () => {
  const results: { full?: RunResult; kill?: RunResult; app?: RunResult } = {};

  beforeAll(async () => {
    installGlobal("navigator", {
      hardwareConcurrency:
        Number(process.env.ARTDADDY_LIVE_CORES) || os.availableParallelism?.() || os.cpus().length,
    });
    installGlobal("localStorage", memoryStorage());
    installGlobal("fetch", () =>
      Promise.reject(new Error("the live speech proof must not use the network")),
    );
    if (FAKE) {
      process.env.ARTDADDY_FAKE_STARTUP_MS ??= "500";
      process.env.ARTDADDY_FAKE_BURST_MS ??= "500";
    }
    await fsp.mkdir(path.join(PROJ, "src"), { recursive: true });
    const model = whisperModelPath(PROJ, "small");
    await fsp.mkdir(path.dirname(model), { recursive: true });
    if (FAKE) {
      // The model as the app checks it: its exact size, and the marker the app writes once it has checked the hash.
      const spec = WHISPER_MODELS.small;
      const handle = await fsp.open(model, "w");
      await handle.truncate(spec.bytes);
      await handle.close();
      await fsp.writeFile(
        `${model}.verified.json`,
        JSON.stringify({ bytes: spec.bytes, sha256: spec.sha256 }),
      );
      await fsp.mkdir(path.dirname(SPEECH_FILE), { recursive: true });
      await fsp.writeFile(
        SPEECH_FILE,
        "a made-up recording: the fake engine reads only the extract's length",
      );
    } else {
      try {
        await fsp.link(REAL_MODEL, model);
      } catch {
        await fsp.copyFile(REAL_MODEL, model);
      }
      if (existsSync(`${REAL_MODEL}.verified.json`))
        await fsp.copyFile(`${REAL_MODEL}.verified.json`, `${model}.verified.json`);
    }
    // The processor, by the app's own hold on the chip: it launches the engine with -ng and knows it is on the processor.
    holdCpuOnly(null);
  });

  afterAll(async () => {
    killAlive();
    for (const undo of restore.splice(0).reverse()) undo();
    await fsp.rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
  });

  it(
    "run 1: a full run through the app's own code, every chunk of its output timestamped as it arrives",
    async () => {
      const r = await doRun("full", {});
      results.full = r;
      expect(r.error, String(r.error)).toBeUndefined();
      expect(r.outcome).toBe("done");
      expect(r.trace.launches, "no retry of the engine").toBe(1);
      expect(r.trace.args, "the app launched it on the processor").toContain("-ng");
      expect(r.trace.chunks.length).toBeGreaterThan(0);
      const times = r.trace.chunks.map((c) => c.tMs);
      expect(times, "chunks in the order they arrived").toEqual([...times].sort((a, b) => a - b));
      expect(r.trace.code).toBe(0);
      expect(r.trace.finalJson, "the engine's own output file").toBeDefined();
      expect(r.audioS).toBeGreaterThan(0);
    },
    60 * 60_000,
  );

  it.skipIf(!RUNS.has("kill"))(
    "run 2: Cancel through the chip's own path: the process dies, no output file is left, the app answers a stop",
    async () => {
      const r = await doRun("kill", { killAfterMs: KILL_AT_MS });
      results.kill = r;
      expect(r.trace.abortAt, "Cancel reached the runner").not.toBeNull();
      expect(r.trace.survived, "the process was still there after the kill").toBe(false);
      expect(r.trace.closeAt, "the process was gone").not.toBeNull();
      expect(r.outcome, String(r.error)).toBe("cancelled");
      const base = flagValue(r.trace.args, "-of");
      expect(base, "the engine was given an output path").toBeDefined();
      expect(existsSync(`${base}.json`), "no output file is left").toBe(false);
      expect(r.trace.launches, "no retry after a stop").toBe(1);
    },
    30 * 60_000,
  );

  it.skipIf(!RUNS.has("app"))(
    "run 3: the app's own background path, the chip's store sampled after every chunk",
    async () => {
      expect(results.full, "run 1 comes first").toBeDefined();
      // This run is about the chip and the live check on the real cadence, not about admission (which has its own
      // tests): this PC's own pace, from run 1, is put aside and the file is admitted as a PC that does it in half the
      // cap would be, so a PC slower than the cap allows is still watched, and stopped by the live check if it is slow.
      const own = readPace();
      console.log(`[speechLive] this PC's own pace after run 1: ${JSON.stringify(own)}`); // eslint-disable-line no-console
      localStorage.removeItem(SPEECH_PACE_KEY);
      recordSpeechRun(results.full!.audioS, CAP_S / 2, "cpu");
      const r = await doRun("app", { sampleChip: true, background: true });
      results.app = r;
      expect(r.outcome, `${r.outcome}: ${String(r.error)}`).toMatch(/^(done|too_slow)$/);
      const chip = r.trace.chip;
      expect(chip.length, "the chip was sampled").toBeGreaterThan(0);
      expect(
        chip.some((s) => s.firstWordsMs !== null),
        "the chip saw the first words",
      ).toBe(true);
      const done = chip.map((s) => s.doneS);
      expect(done, "the position never goes back").toEqual([...done].sort((a, b) => a - b));
      expect(done[done.length - 1], "the position rose").toBeGreaterThan(done[0] - 1e-9);
    },
    60 * 60_000,
  );

  it("writes the capture: it passes the schema check, holds no speech and no path of this PC", async () => {
    const full = results.full;
    expect(full, "run 1 made no capture").toBeDefined();
    const capture: SpeechLiveCapture = {
      schema: CAPTURE_SCHEMA,
      textPolicy: TEXT_POLICY,
      ...runCapture(full!, {
        code: full!.trace.code,
        wallMs: wallMs(full!.trace),
        launches: full!.trace.launches,
      }),
    };
    // A run that did not give a usable record is left out, saying so, and what the other runs made is still written:
    // the engine's time is the dear thing, and a section that cannot be one is the finding, in the log of this test.
    const k = results.kill;
    const killUsable =
      k !== undefined &&
      k.trace.closeAt !== null &&
      k.trace.abortAt !== null &&
      !k.trace.survived &&
      k.audioS > 0;
    if (k && !killUsable)
      console.log(
        "[speechLive] run 2 is left out of the capture: it made no usable record of a kill",
      ); // eslint-disable-line no-console
    if (k && killUsable)
      capture.killed = runCapture(k, {
        code: k.trace.code,
        wallMs: wallMs(k.trace),
        killedAtMs: k.trace.abortAt! - k.trace.launchAt,
        ...(k.outcome === "cancelled" ? { stoppedBy: "person" as const } : {}),
        deathMs: k.trace.closeAt! - k.trace.abortAt!,
        outputFileLeft: existsSync(`${flagValue(k.trace.args, "-of")}.json`),
        launches: k.trace.launches,
      });
    const a = results.app;
    const appUsable =
      a !== undefined &&
      (a.outcome === "done" || a.outcome === "too_slow") &&
      a.trace.closeAt !== null &&
      a.trace.chunks.length > 0 &&
      a.audioS > 0;
    if (a && !appUsable)
      console.log(`[speechLive] run 3 is left out of the capture: it ended as "${a.outcome}"`); // eslint-disable-line no-console
    if (a && appUsable) {
      const app: AppRunCapture = {
        ...runCapture(a, {
          code: a.trace.code,
          wallMs: wallMs(a.trace),
          ...(a.outcome === "too_slow" ? { stoppedBy: "too_slow" as const } : {}),
          launches: a.trace.launches,
        }),
        chip: a.trace.chip,
      };
      capture.app = app;
    }
    const problems = validateCapture(capture);
    expect(problems, "the capture passes its own schema check").toEqual([]);
    const text = serializeCapture(capture);
    for (const needle of [
      ...needles(),
      path.basename(SPEECH_FILE, path.extname(SPEECH_FILE)),
      "PRIVATE-WORDS",
      "PRIVATE-OTHER",
    ])
      expect(text.toLowerCase(), `the capture names ${needle.slice(0, 3)}...`).not.toContain(
        needle.toLowerCase(),
      );
    await fsp.mkdir(path.dirname(OUT), { recursive: true });
    await fsp.writeFile(OUT, text);
    console.log(`[speechLive] capture written: ${OUT} (${text.length} characters)`); // eslint-disable-line no-console
  });
});
