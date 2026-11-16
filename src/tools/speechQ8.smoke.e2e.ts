// The speech model q8_0, proved through the app's own code (lane L12): `runWhisper(ctx, clip, "small", language)` on a
// processor-only PC and on a graphics-chip PC, with BOTH model files in the model folder, and what the engine was launched with.
//
// What it asserts, from the launches the runner saw (the only public view of a launch: the arguments the app builds):
//   * a processor PC (the chip held off, as speechLive.smoke.e2e.ts does it): English -> ggml-small-q8_0.bin, -bs 1 -bo 1, -ng;
//     Dutch -> the q8_0 file, no -bs/-bo (the engine's own 5 beams), -ng; Spanish like English; Arabic -> ggml-small.bin
//     (the full-size file), no -bs/-bo, -ng;
//   * a chip PC (no hold, its latest run on the chip) -> ggml-small.bin and never the q8_0 file, though that file is on disk;
//   * the RULE, over every launch of this file: a launch of the q8_0 file always has -ng, and every launch names a file the
//     app's manifest knows (the pairing the owner's I-1 forbids, "q8_0 on the graphics chip", cannot appear in any case);
//   * what an install that holds one file does: only the full-size file -> it keeps it and downloads nothing; only the q8_0 file
//     -> English runs on it, and Arabic is refused with a plain reason and NO launch (never a wrong-model run);
//   * language "auto" predicted as English and heard as Dutch: the greedy transcript is not kept, and the kept run is 5 beams;
//   * the words the app makes of the engine's JSON are the stored ones (the study's own words, see the engine-check kit), and the
//     kit's word reader (a port used by its standalone harness) agrees with the app's reader on stored transcripts of 12 languages.
// The behaviour under test (the choice of the model file, the launch boundary) is written by lane L12 itself: before that
// lands, the assertions on the q8_0 file are EXPECTED to fail (the app launches the full-size file for everything). The ones that
// describe today's behaviour (a chip PC, an install with only the full-size file, the stored words, the rule) pass before and after.
//
// Run:  ARTDADDY_SMOKE_NO_WARMUP=1 npx vitest run --config vitest.smoke.config.ts src/tools/speechQ8.smoke.e2e.ts
//   ARTDADDY_Q8_KIT            the engine-check kit folder (fixtures/clips.json, fixtures/wav, fixtures/stored, fixtures/parity, models/)
//   ARTDADDY_Q8_MODEL_DIR      where ggml-small.bin and ggml-small-q8_0.bin are (default <kit>/models)
//   ARTDADDY_Q8_SCRATCH        where this run's scratch folder goes (default the OS temp folder)
//   ARTDADDY_Q8_FAKE_ENGINE=1  prove the harness with no engine: fakeWhisper.mjs replays each clip's stored JSON, made-up model files
//   ARTDADDY_Q8_CHIP=0         leave out the chip PC case (it launches the real engine on this PC's graphics chip)
//   ARTDADDY_Q8_AR_STRICT=1    fail on any Arabic word that differs from the stored chip words (default: report it; the study's
//                              own control moved German by -0.31 and Japanese by -0.66 points between the chip and the processor)
//   ARTDADDY_Q8_FAULT=<kind>   (fake engine only) the test of this file's own assertions: the runner changes what the app built
//                              before the "engine" sees it, and the assertion that exists for it must fail. chip-q8: a launch
//                              without -ng is given the q8_0 file; ar-q8: Arabic is given the q8_0 file; drop-ng: -ng is removed.
// It SKIPS, naming what is missing, unless the shipped sidecars (src-tauri/binaries, src-tauri/resources/whisper: the kit's
// link_sidecars.ps1 makes them visible to a worktree), both model files and the kit are there (or the fake engine is asked for).
// It never touches the network: fetch is replaced and counted, and every case that must not download asserts zero calls.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fsp, readFileSync } from "node:fs";
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

import { __resetSpeechJobs } from "../store/speechJobs";
import { shippedSidecar } from "../test/sidecars";
import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { MODEL_MANIFEST } from "./modelManifest";
import { __resetSpeechSession } from "./speechAdmission";
import { holdCpuOnly } from "./speechBackend";
import { beamFor, decodeArgs, rememberSpeechLanguage } from "./speechDecoding";
import { TranscriptionFailure } from "./speechFailure";
import { recordSpeechRun } from "./speechPace";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import {
  PATIENT_DOWNLOAD,
  SINGLE_ATTEMPT,
  __setDownloadPolicy,
  parseWhisperCppJson,
  runWhisper,
  whisperModelPath,
} from "./transcribe";
import { whisperRunFacts } from "./whisperFacts";
import { nodeFs, nodeRunner } from "./__e2e";

const FAKE = process.env.ARTDADDY_Q8_FAKE_ENGINE === "1";
const KIT = process.env.ARTDADDY_Q8_KIT ?? "";
const MODEL_DIR = process.env.ARTDADDY_Q8_MODEL_DIR ?? (KIT ? path.join(KIT, "models") : "");
const WITH_CHIP_CASE = process.env.ARTDADDY_Q8_CHIP !== "0";
const AR_STRICT = process.env.ARTDADDY_Q8_AR_STRICT === "1";
const SCRATCH = path.join(
  process.env.ARTDADDY_Q8_SCRATCH ?? os.tmpdir(),
  `artdaddy-q8-smoke-${Date.now()}`,
);
const PROJ = joinPath(SCRATCH, "projects", "q8");
const MODELS_IN_APP = path.join(SCRATCH, "models"); // whisperModelPath(PROJ, ...): <data root>/models
/** whisper.cpp's Windows build is dynamic and finds its CPU backend by scanning the folder the process runs in. */
const DLL_DIR = path.resolve(process.cwd(), "src-tauri/resources/whisper");
const FAKE_ENGINE = path.join(__dirname, "__fixtures__", "speechLive", "fakeWhisper.mjs");

const F16_FILE = MODEL_MANIFEST.small.file;
const Q8_FILE = MODEL_MANIFEST.small_q8_0.file;
const KNOWN_FILES: readonly string[] = Object.values(MODEL_MANIFEST).map((e) => e.file);

const whisper = FAKE ? null : shippedSidecar("whisper-cli");
const ffmpeg = FAKE ? null : shippedSidecar("ffmpeg");

// ---------------------------------------------------------------------------------------------------------
// The kit's fixtures (made by the engine-check kit's make_fixtures.mjs from the study's stored gate outputs).

interface KitClip {
  id: string;
  language: string;
  durationS: number;
  wav: string;
  expect: { key: string; file: string; ftype: number; beam: number; strictWords: boolean };
  stored: { config: string; path: string; words: string[] };
}
interface KitParity {
  id: string;
  language: string;
  path: string;
  words: string[];
}
interface Kit {
  clips: KitClip[];
  parity: KitParity[];
}

function loadKit(): Kit | null {
  const file = KIT ? path.join(KIT, "fixtures", "clips.json") : "";
  return file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Kit) : null;
}
const kit = loadKit();
const clipOf = (id: string): KitClip => {
  const c = kit?.clips.find((x) => x.id === id);
  if (!c) throw new Error(`the kit has no clip '${id}'`);
  return c;
};

const missing: string[] = [];
if (!kit) missing.push("ARTDADDY_Q8_KIT (the engine-check kit with fixtures/clips.json)");
if (!FAKE) {
  if (!whisper) missing.push("the shipped whisper-cli (src-tauri/binaries)");
  if (!ffmpeg) missing.push("the shipped ffmpeg (src-tauri/binaries)");
  if (!existsSync(DLL_DIR)) missing.push(`its libraries at ${DLL_DIR}`);
  for (const f of [F16_FILE, Q8_FILE])
    if (!MODEL_DIR || !existsSync(path.join(MODEL_DIR, f)))
      missing.push(`${f} in ARTDADDY_Q8_MODEL_DIR (${MODEL_DIR || "unset"})`);
}
if (missing.length > 0) console.log(`[speechQ8] skipped: missing ${missing.join("; ")}`); // eslint-disable-line no-console

// ---------------------------------------------------------------------------------------------------------
// What the app finds in a browser or a desktop shell and a node process does not have.

const restore: Array<() => void> = [];
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

/** The network the app would use, counted: a case that must not download asserts that nothing asked. */
const fetchCalls: string[] = [];

// ---------------------------------------------------------------------------------------------------------
// One run of the engine, recorded as the app launched it.

interface Launch {
  args: string[];
  stderr: string;
  code: number | null;
  wallS: number;
  /** What the engine's own output file held when it finished: the model file it says it loaded, and that file's ftype
   *  (7 = q8_0, 1 = f16). Read from a real engine only: the fake replays a stored file that cannot know. */
  jsonModel: string | null;
  jsonFtype: number | null;
}

/** Every launch of the file, across all cases, for the closing rule. */
const everyLaunch: Launch[] = [];

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const modelOf = (l: Launch): string =>
  path.basename((flagValue(l.args, "-m") ?? "").replace(/\\/g, "/"));

/** What ffmpeg's extraction is in the fake run: a silent 16 kHz mono 16-bit file of the clip's length. */
async function fakeFfmpeg(args: readonly string[], seconds: number): Promise<CommandResult> {
  const out = args[args.length - 1];
  const bytes = 44 + Math.round(seconds * 32_000);
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

/** The test of the assertions themselves (ARTDADDY_Q8_FAULT, fake engine only): what the app built is changed on its way to the
 *  engine, as a bug in the selection or at the launch boundary would change it. */
function withFault(args: string[]): string[] {
  const fault = FAKE ? (process.env.ARTDADDY_Q8_FAULT ?? "") : "";
  const at = args.indexOf("-m");
  const swapToQ8 = (): void => {
    args[at + 1] = path.join(path.dirname(args[at + 1]), Q8_FILE);
  };
  if (fault === "chip-q8" && at >= 0 && !args.includes("-ng")) swapToQ8();
  if (fault === "ar-q8" && at >= 0 && flagValue(args, "-l") === "ar") swapToQ8();
  return fault === "drop-ng" ? args.filter((a) => a !== "-ng") : args;
}

/** The runner the app is given: the real one for everything but the engine; the engine is spawned as the app's own runner
 *  spawns it (the engine's DLL folder as its working directory) and every launch is recorded. The fake engine writes the
 *  clip's stored JSON as its output. */
function engineRunner(launches: Launch[], clip: KitClip): CommandRunner {
  return {
    async run(program, appArgs, signal, cwd, onStdout) {
      if (program === "ffmpeg" && FAKE) return fakeFfmpeg(appArgs, clip.durationS);
      if (program !== "whisper-cli") return nodeRunner.run(program, appArgs, signal, cwd, onStdout);
      const args = withFault([...appArgs]);
      return new Promise<CommandResult>((resolve) => {
        const started = Date.now();
        const record: Launch = {
          args: [...args],
          stderr: "",
          code: null,
          wallS: 0,
          jsonModel: null,
          jsonFtype: null,
        };
        launches.push(record);
        everyLaunch.push(record);
        const child = FAKE
          ? spawn(process.execPath, [FAKE_ENGINE, ...args], {
              windowsHide: true,
              env: {
                ...process.env,
                ARTDADDY_FAKE_REPLAY_JSON: path.join(KIT, clip.stored.path),
                ARTDADDY_FAKE_STARTUP_MS: "30",
                ARTDADDY_FAKE_BURST_MS: "30",
              },
            })
          : spawn(whisper!, args, { cwd: DLL_DIR, windowsHide: true });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        alive.add(child);
        child.once("close", () => alive.delete(child));
        let stdout = "";
        let killed = false;
        const onAbort = (): void => {
          killed = true;
          child.kill("SIGKILL");
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (text: string) => {
          stdout += text;
          onStdout?.(text);
        });
        child.stderr.on("data", (text: string) => {
          record.stderr += text;
        });
        child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
        child.on("close", async (code) => {
          signal?.removeEventListener("abort", onAbort);
          record.code = code;
          record.wallS = (Date.now() - started) / 1000;
          const base = flagValue(args, "-of");
          if (!FAKE && base && existsSync(`${base}.json`)) {
            try {
              const json = JSON.parse(await fsp.readFile(`${base}.json`, "utf8")) as {
                params?: { model?: string };
                model?: { ftype?: number };
              };
              record.jsonModel = path.basename(String(json.params?.model ?? "").replace(/\\/g, "/"));
              record.jsonFtype = json.model?.ftype ?? null;
            } catch {
              /* a cut file is a finding of its own: the app reads it next and says so */
            }
          }
          resolve(
            killed
              ? { code: -1, stdout, stderr: "cancelled" }
              : { code, stdout, stderr: record.stderr },
          );
        });
      });
    },
  };
}

/** Each case gets its own app cache and work folder, so none is answered from another's transcript. */
function ctxFor(label: string, runner: CommandRunner): ClientToolContext {
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
  return { store: new ProjectStoreAccess(PROJ, fs), runner };
}

/** Which of the two model files are on disk (whole and checked by the app) for the next case. The others are set aside under
 *  another name, never deleted. */
async function installOnly(keys: ReadonlyArray<"small" | "small_q8_0">): Promise<void> {
  for (const [key, entry] of Object.entries(MODEL_MANIFEST)) {
    const file = whisperModelPath(PROJ, key, entry.file);
    const aside = `${file}.aside`;
    const want = (keys as readonly string[]).includes(key);
    if (want && !existsSync(file) && existsSync(aside)) await fsp.rename(aside, file);
    if (!want && existsSync(file)) await fsp.rename(file, aside);
  }
}

type Backend = "processor" | "chip";
/** The PC the case runs on, by the app's own records: the processor is the chip held off after a crash (what
 *  speechLive.smoke.e2e.ts does); the chip is no hold and a latest run that used it. */
function configurePc(backend: Backend): void {
  localStorage.clear();
  if (backend === "processor") holdCpuOnly(null);
  else recordSpeechRun(60, 30, "gpu");
}

interface CaseResult {
  launches: Launch[];
  words: string[] | null;
  error: unknown;
  fetches: number;
}

async function runCase(
  label: string,
  clip: KitClip,
  language: string,
  opts: { backend: Backend; keys?: ReadonlyArray<"small" | "small_q8_0">; lastLanguage?: string },
): Promise<CaseResult> {
  __resetSpeechJobs();
  __resetSpeechSession();
  configurePc(opts.backend);
  if (opts.lastLanguage) rememberSpeechLanguage(opts.lastLanguage);
  await installOnly(opts.keys ?? ["small", "small_q8_0"]);
  const launches: Launch[] = [];
  const ctx = ctxFor(label, engineRunner(launches, clip));
  const src = FAKE ? path.join(SCRATCH, "inbox", `${clip.id}.wav`) : path.join(KIT, clip.wav);
  const fetchesBefore = fetchCalls.length;
  let words: string[] | null = null;
  let error: unknown;
  try {
    const transcript = await runWhisper(ctx, src, "small", language);
    words = transcript.words.map((w) => w.word);
  } catch (e) {
    error = e;
  }
  const line = launches
    .map((l) => {
      const facts = whisperRunFacts(l.stderr);
      return `${modelOf(l)} ${l.args.includes("-bs") ? "-bs 1 -bo 1" : "5 beams"} ${l.args.includes("-ng") ? "-ng" : "(chip)"} -> ${facts.backend ?? "?"}, ${l.wallS.toFixed(1)} s`;
    })
    .join(" | ");
  console.log(`[speechQ8] ${label}: ${launches.length} launch(es): ${line || "none"}${error ? `; ended with ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` : ""}`); // eslint-disable-line no-console
  return { launches, words, error, fetches: fetchCalls.length - fetchesBefore };
}

/** The words the app's own reader makes of a stored transcript of the study. */
function appWordsOfStored(clip: KitClip): string[] {
  const raw = readFileSync(path.join(KIT, clip.stored.path), "utf8");
  return parseWhisperCppJson(raw, { wordTimes: false }).words.map((w) => w.word);
}

/** What every launch of a case on a processor PC must show, whichever file it runs. */
function expectProcessorLaunch(l: Launch): void {
  expect(l.args, "the launch is the processor's: -ng").toContain("-ng");
  const facts = whisperRunFacts(l.stderr);
  expect(facts.backend, "the engine's own log says it ran on the processor").toBe("cpu");
}

describe.skipIf(missing.length > 0)(
  `the q8_0 speech model through the app's own code${FAKE ? " (fake engine)" : ""}`,
  () => {
    beforeAll(async () => {
      installGlobal("navigator", {
        hardwareConcurrency: Number(process.env.ARTDADDY_LIVE_CORES) || os.availableParallelism?.() || os.cpus().length,
      });
      installGlobal("localStorage", memoryStorage());
      installGlobal("fetch", (input: unknown) => {
        fetchCalls.push(String(input));
        return Promise.reject(new Error("the q8_0 proof must not use the network"));
      });
      __setDownloadPolicy(SINGLE_ATTEMPT);
      await fsp.mkdir(path.join(PROJ, "src"), { recursive: true });
      await fsp.mkdir(MODELS_IN_APP, { recursive: true });
      for (const [key, entry] of Object.entries(MODEL_MANIFEST)) {
        const model = whisperModelPath(PROJ, key, entry.file);
        if (FAKE) {
          // The model as the app checks it: its exact size, and the marker the app writes once it has checked the hash.
          const handle = await fsp.open(model, "w");
          await handle.truncate(entry.bytes);
          await handle.close();
          await fsp.writeFile(
            `${model}.verified.json`,
            JSON.stringify({ bytes: entry.bytes, sha256: entry.sha256 }),
          );
        } else {
          // The real files, linked (copied across volumes). No marker: the app hashes them itself the first time and
          // writes its own, which is the check that these are the pinned bytes.
          try {
            await fsp.link(path.join(MODEL_DIR, entry.file), model);
          } catch {
            await fsp.copyFile(path.join(MODEL_DIR, entry.file), model);
          }
        }
      }
      if (FAKE)
        for (const c of kit?.clips ?? []) {
          await fsp.mkdir(path.join(SCRATCH, "inbox"), { recursive: true });
          await fsp.writeFile(
            path.join(SCRATCH, "inbox", `${c.id}.wav`),
            "a made-up recording: the fake engine reads only the extract's length",
          );
        }
    });

    afterAll(async () => {
      killAlive();
      __setDownloadPolicy(PATIENT_DOWNLOAD);
      for (const undo of restore.splice(0).reverse()) undo();
      await fsp.rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
    });

    it("the kit's word reader finds the same words as the app's parseWhisperCppJson in stored transcripts of 12 languages", () => {
      const parity = kit!.parity;
      expect(parity.length, "the parity corpus is there").toBeGreaterThanOrEqual(12);
      for (const p of parity) {
        const raw = readFileSync(path.join(KIT, p.path), "utf8");
        const app = parseWhisperCppJson(raw, { wordTimes: false }).words.map((w) => w.word);
        expect(app, `${p.id}: the app's words are the kit's`).toEqual(p.words);
      }
      for (const c of kit!.clips)
        expect(appWordsOfStored(c), `${c.id}: the stored words`).toEqual(c.stored.words);
    });

    it(
      "English on a processor PC: the q8_0 file, greedy (-bs 1 -bo 1), -ng; the words are the stored ones",
      async () => {
        const clip = clipOf("en");
        const r = await runCase("en-processor", clip, "en", { backend: "processor" });
        expect(r.error, String(r.error)).toBeUndefined();
        expect(r.launches, "one launch, no retry").toHaveLength(1);
        const l = r.launches[0];
        expect(modelOf(l), "the q8_0 file").toBe(Q8_FILE);
        expect(flagValue(l.args, "-bs")).toBe("1");
        expect(flagValue(l.args, "-bo")).toBe("1");
        expect(flagValue(l.args, "-l")).toBe("en");
        expect(flagValue(l.args, "-mc")).toBe("0");
        expectProcessorLaunch(l);
        expect(r.fetches, "both files are on disk: nothing is downloaded").toBe(0);
        if (!FAKE) {
          expect(l.jsonModel, "the engine says it loaded the q8_0 file").toBe(Q8_FILE);
          expect(l.jsonFtype, "ftype 7 is q8_0").toBe(7);
        }
        expect(r.words, "the words are the stored ones").toEqual(appWordsOfStored(clip));
      },
      5 * 60_000,
    );

    it(
      "Dutch on a processor PC: the q8_0 file, 5 beams (no -bs, no -bo), -ng; the words are the stored ones",
      async () => {
        const clip = clipOf("nl");
        const r = await runCase("nl-processor", clip, "nl", { backend: "processor" });
        expect(r.error, String(r.error)).toBeUndefined();
        expect(r.launches).toHaveLength(1);
        const l = r.launches[0];
        expect(modelOf(l), "the q8_0 file").toBe(Q8_FILE);
        expect(l.args, "Dutch fails greedy on the processor: the engine's own 5 beams").not.toContain("-bs");
        expect(l.args).not.toContain("-bo");
        expect(flagValue(l.args, "-l")).toBe("nl");
        expectProcessorLaunch(l);
        expect(r.fetches).toBe(0);
        if (!FAKE) expect(l.jsonFtype).toBe(7);
        expect(r.words).toEqual(appWordsOfStored(clip));
      },
      5 * 60_000,
    );

    it(
      "Spanish on a processor PC: the q8_0 file, greedy, -ng; the words are the stored ones",
      async () => {
        const clip = clipOf("es");
        const r = await runCase("es-processor", clip, "es", { backend: "processor" });
        expect(r.error, String(r.error)).toBeUndefined();
        expect(r.launches).toHaveLength(1);
        const l = r.launches[0];
        expect(modelOf(l)).toBe(Q8_FILE);
        expect(flagValue(l.args, "-bs")).toBe("1");
        expect(flagValue(l.args, "-bo")).toBe("1");
        expectProcessorLaunch(l);
        expect(r.fetches).toBe(0);
        if (!FAKE) expect(l.jsonFtype).toBe(7);
        expect(r.words).toEqual(appWordsOfStored(clip));
      },
      5 * 60_000,
    );

    it(
      "Arabic on a processor PC: the full-size file (f16), 5 beams (no -bs, no -bo), -ng, never the q8_0 file",
      async () => {
        const clip = clipOf("ar");
        const r = await runCase("ar-processor", clip, "ar", { backend: "processor" });
        expect(r.error, String(r.error)).toBeUndefined();
        expect(r.launches).toHaveLength(1);
        const l = r.launches[0];
        expect(modelOf(l), "Arabic misses the 2-point rule on q8_0: the full-size file").toBe(F16_FILE);
        expect(l.args).not.toContain("-bs");
        expect(l.args).not.toContain("-bo");
        expect(flagValue(l.args, "-l")).toBe("ar");
        expectProcessorLaunch(l);
        expect(r.fetches).toBe(0);
        if (!FAKE) {
          expect(l.jsonModel).toBe(F16_FILE);
          expect(l.jsonFtype, "ftype 1 is f16").toBe(1);
        }
        const stored = appWordsOfStored(clip);
        if (FAKE || AR_STRICT) expect(r.words, "the stored chip words").toEqual(stored);
        else {
          const same = JSON.stringify(r.words) === JSON.stringify(stored);
          console.log(`[speechQ8] ar-processor words ${same ? "equal the stored f16 chip words" : `DIFFER from the stored f16 chip words (${r.words?.length ?? 0} produced, ${stored.length} stored): reported, not failed`}`); // eslint-disable-line no-console
          expect(r.words?.length ?? 0, "some words were made").toBeGreaterThan(0);
        }
      },
      5 * 60_000,
    );

    it.skipIf(!WITH_CHIP_CASE)(
      "a graphics-chip PC (no hold, its latest run on the chip): the full-size file, never the q8_0 file, though that file is on disk",
      async () => {
        const clip = clipOf("en");
        const r = await runCase("en-chip", clip, "en", { backend: "chip" });
        expect(r.error, String(r.error)).toBeUndefined();
        expect(r.launches.length, "at least one launch").toBeGreaterThanOrEqual(1);
        for (const l of r.launches) expect(modelOf(l), "never the q8_0 file on the chip").toBe(F16_FILE);
        const first = r.launches[0];
        expect(first.args, "the first launch is the chip's: no -ng").not.toContain("-ng");
        // The decoding is today's, byte for byte: what the gate cleared for the full-size file in English.
        const decodeOf = (args: readonly string[]): string[] =>
          args.includes("-bs") ? ["-bs", flagValue(args, "-bs") ?? "", "-bo", flagValue(args, "-bo") ?? ""] : [];
        expect(decodeOf(first.args)).toEqual(decodeArgs(beamFor("f16", "en")));
        expect(r.fetches).toBe(0);
      },
      5 * 60_000,
    );

    it(
      "a processor PC that has only the full-size file keeps it (today's behaviour) and downloads nothing",
      async () => {
        const clip = clipOf("en");
        const r = await runCase("en-processor-f16-only", clip, "en", { backend: "processor", keys: ["small"] });
        expect(r.error, String(r.error)).toBeUndefined();
        expect(r.launches).toHaveLength(1);
        const l = r.launches[0];
        expect(modelOf(l), "no surprise download of the other file").toBe(F16_FILE);
        expect(r.fetches, "no network").toBe(0);
        expectProcessorLaunch(l);
        expect(l.args.includes("-bs"), "today's decoding for the full-size file in English").toBe(beamFor("f16", "en") === 1);
      },
      5 * 60_000,
    );

    it(
      "a processor PC that has only the q8_0 file runs English on it (-ng, greedy) and downloads nothing",
      async () => {
        const clip = clipOf("en");
        const r = await runCase("en-processor-q8-only", clip, "en", { backend: "processor", keys: ["small_q8_0"] });
        expect(r.error, String(r.error)).toBeUndefined();
        expect(r.launches).toHaveLength(1);
        const l = r.launches[0];
        expect(modelOf(l), "the file that is there").toBe(Q8_FILE);
        expectProcessorLaunch(l);
        expect(r.fetches, "no network: the file it needs is on disk").toBe(0);
        expect(r.words).toEqual(appWordsOfStored(clip));
      },
      5 * 60_000,
    );

    it(
      "Arabic on a PC that has only the q8_0 file: no engine is launched, the reason is plain, and the q8_0 file is never used for it",
      async () => {
        const clip = clipOf("ar");
        const r = await runCase("ar-processor-q8-only", clip, "ar", { backend: "processor", keys: ["small_q8_0"] });
        expect(r.launches.filter((l) => modelOf(l) === Q8_FILE), "never a wrong-model run").toHaveLength(0);
        expect(r.launches, "it needs the full-size file, which is not there and cannot be fetched: nothing runs").toHaveLength(0);
        expect(r.error, "a plain reason, not a transcript").toBeInstanceOf(TranscriptionFailure);
        expect((r.error as TranscriptionFailure).reason).toBe("model_unavailable");
        expect(r.fetches, "the app asked the network for the file it needs").toBeGreaterThan(0);
      },
      5 * 60_000,
    );

    it(
      'language "auto" predicted as English, heard as Dutch: the greedy transcript is not kept, the kept run is 5 beams',
      async () => {
        const clip = clipOf("nl");
        const r = await runCase("auto-nl-processor", clip, "auto", { backend: "processor", lastLanguage: "en" });
        expect(r.error, String(r.error)).toBeUndefined();
        expect(r.launches, "the prediction, then the run the heard language needs").toHaveLength(2);
        const [first, second] = r.launches;
        expect(first.args.includes("-bs"), "the first run was planned for the predicted English: greedy").toBe(true);
        expect(second.args, "the kept run is Dutch's: 5 beams").not.toContain("-bs");
        expect(second.args).not.toContain("-bo");
        for (const l of r.launches) expect(l.args, "every launch of this PC is the processor's").toContain("-ng");
        if (!FAKE) expect(r.words?.length ?? 0).toBeGreaterThan(0);
        else expect(r.words).toEqual(appWordsOfStored(clip));
      },
      5 * 60_000,
    );

    it("the rule over every launch of this file: the q8_0 file is never launched without -ng, and every launch names a file of the manifest", () => {
      expect(everyLaunch.length, "the cases above launched the engine").toBeGreaterThan(0);
      for (const l of everyLaunch) {
        const file = modelOf(l);
        expect(KNOWN_FILES, `a launch of ${file}: a file the manifest knows`).toContain(file);
        if (file === Q8_FILE) expect(l.args, "the q8_0 file is the processor's only").toContain("-ng");
      }
    });
  },
);
