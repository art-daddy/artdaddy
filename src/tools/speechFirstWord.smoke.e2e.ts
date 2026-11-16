// The first-word rule (lane L13) through the app's own code, with the engine: `runWhisper` for every clip of the corpus, today's
// launch against the rule's, and `get_transcript` on clips with quiet in front. Opt-in: it does nothing unless L13_ENGINE is set.
//
// WHAT IT DRIVES. The app's real `runWhisper` (and, for the second part, the real `get_transcript`) over the real node filesystem
// and a real command runner that spawns the shipped ffmpeg and (L13_ENGINE=real) the shipped whisper-cli, on the processor path
// (the chip held off with the app's own `holdCpuOnly`, as speechLive.smoke.e2e.ts does it) unless L13_PATH=chip. For each corpus clip
// and each mode it writes one JSON line (L13_OUT):
//   today  the constants off (`__setWordTimesShipped(false)`): what 0.27.0 launches and reads;
//   rule   the constants on and the server switch on: the owner's rule, a launch carries `-dtw small -nfa` only when the voice in
//          the ONE file it hears starts more than a second after the start of that file;
//   today2 (optional, L13_MODES=today,rule,today2) a second run of today, to tell what the engine itself moves between two runs.
// A line holds: the clip, its language, the KNOWN voice start, the detector's answer on the clip's own samples, the launch kind
// (today = no `-dtw`; fix = it carried them; fix-failed-fell-back = it carried them, failed, and the retry without them made the
// words), the launch line as spawned, what the detector said of the file each launch actually heard, the first word's time and the
// first three words, how late (+) or early (-) the first word is against the known voice start, the seconds the call took, and
// the engine's own backend lines. The scorer (helpers\c-rig\work\score.py) reads the lines.
//
// THE FLAGS COME FROM THE APP'S CODE. The "gate off" argv is recorded, for every clip, through a runner that spawns nothing (the
// app's own builder with the constants off); every launch is then checked against it: a today launch IS that argv, a rule launch IS
// that argv plus the app's `DTW_ARGS` and nothing else (a fell-back launch is that argv again). No flag list is written here.
// The oracle for "should it carry them" is the owner's rule written down here as the number it is (1000 ms) against the corpus's
// KNOWN voice start, never the app's own constant; a clip within the corpus's boundary band of one second may go either way but
// must agree with what the detector heard.
//
// Run (fake engine, no whisper-cli, real ffmpeg):
//   $env:L13_ENGINE = "fake"; npx vitest run --config vitest.smoke.config.ts src/tools/speechFirstWord.smoke.e2e.ts --maxWorkers=2
// Run (the real engine; the lane agent only, under the machine lock): L13_ENGINE=real, see helpers\c-rig\NEEDS-SLOT.md.
//   L13_ENGINE       fake | real (anything else: skipped)
//   L13_CORPUS       the corpus folder (corpus.json, real_clips.json, wav\, real\), default ~/Akaru/_scratch/lanes/L13-first-word/corpus
//   L13_MODEL_DIR    where the model files are (default ~/Akaru/_scratch/models); L13_MODEL the manifest key: small (default) or,
//                    in a build whose manifest has it, small_q8_0
//   L13_PATH         processor (default, the chip held off) | chip (no hold: a PC with a working chip)
//   L13_ALLOW=1      pretend the owner measured this model file on this path: the harness adds it to the app's measured lists (and turns
//                    the chip constant on for L13_PATH=chip) so the rule CAN fire there. Off: the rule must not fire on an unmeasured pair.
//   L13_SET          synthetic | real | all (default all);  L13_ONLY  ids, comma separated, or re:<regex>;  L13_LIMIT  the first N
//   L13_MODES        default today,rule;  L13_PART  runs | gettranscript | all (default);  L13_LANG  named (default) | auto
//   L13_OUT          the JSON lines file (default reports/l13/<engine>-<model>-<path>-<time>.jsonl);  L13_SCRATCH  scratch parent folder
//   L13_CORES        what the app is told the PC has (default: all of them: the engine's -t is cores - 2, at most 8)
//   fake engine only: L13_FAKE_FAULT=dtw-exit|dtw-garbage|dtw-missing|always-exit (L13_FAKE_FAULT_ONLY=<regex of clip ids>) makes the
//   engine fail; L13_HARNESS_FAULT=always-dtw|never-dtw|drop-mc changes what the app built before the engine sees it, and the
//   assertion that exists for it must fail (the test of this file's own assertions).
// It never touches the network: fetch is replaced and counted. It stops its engine children when it ends.
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

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __resetSpeechJobs } from "../store/speechJobs";
import { shippedSidecar } from "../test/sidecars";
import { ensureTimeline } from "../timeline/engine";
import { addClipsTool } from "../timeline/placement";
import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { MODEL_MANIFEST } from "./modelManifest";
import { __resetSpeechSession } from "./speechAdmission";
import { holdCpuOnly } from "./speechBackend";
import {
  pcm16WavSamples,
  speechOnsetMs,
  voiceStartOf,
  type VoiceStart,
} from "./speechLeadingQuiet";
import {
  DTW_ARGS,
  WORD_TIMES_CHIP_MODELS,
  WORD_TIMES_MODELS,
  __resetWordTimesShipped,
  __setWordTimesChipShipped,
  __setWordTimesShipped,
} from "./speechWordTimes";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import {
  PATIENT_DOWNLOAD,
  SINGLE_ATTEMPT,
  __setDownloadPolicy,
  getTranscriptTool,
  runWhisper,
  whisperModelPath,
} from "./transcribe";
import { whisperRunFacts } from "./whisperFacts";
import { __resetWorkGate } from "./workGate";
import {
  installE2EDocuments,
  libRef,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  resetE2EDocuments,
} from "./__e2e";

type Mode = "today" | "rule" | "today2";
type Kind = "today" | "fix" | "fix-failed-fell-back" | "error";
type Rec = Record<string, unknown>;

const ENGINE = process.env.L13_ENGINE ?? "";
const FAKE = ENGINE === "fake";
const HOME = os.homedir();
const CORPUS =
  process.env.L13_CORPUS ??
  path.join(HOME, "Akaru", "_scratch", "lanes", "L13-first-word", "corpus");
const MODEL_DIR = process.env.L13_MODEL_DIR ?? path.join(HOME, "Akaru", "_scratch", "models");
const MODEL_KEY = process.env.L13_MODEL ?? "small";
const PC = process.env.L13_PATH === "chip" ? "chip" : "processor";
const ALLOW = process.env.L13_ALLOW === "1";
const PART = process.env.L13_PART ?? "all";
const NAMED_LANGUAGE = process.env.L13_LANG !== "auto";
const MODES = (process.env.L13_MODES ?? "today,rule")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Mode => s === "today" || s === "rule" || s === "today2");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT =
  process.env.L13_OUT ??
  path.join(process.cwd(), "reports", "l13", `${ENGINE}-${MODEL_KEY}-${PC}-${STAMP}.jsonl`);
const SCRATCH = path.join(
  process.env.L13_SCRATCH ?? path.join(process.cwd(), "reports", "l13", "scratch"),
  `run-${Date.now()}`,
);
const PROJ = joinPath(SCRATCH, "projects", "l13");
const MODELS_IN_APP = path.join(SCRATCH, "models"); // whisperModelPath(PROJ, ...): <data root>/models
/** whisper.cpp's Windows build is dynamic and finds its CPU backend by scanning the folder the process runs in. */
const DLL_DIR = path.resolve(process.cwd(), "src-tauri/resources/whisper");
const FAKE_ENGINE = path.join(
  __dirname,
  "__fixtures__",
  "speechFirstWord",
  "fakeWhisperFirstWord.mjs",
);
const FAULT = FAKE ? (process.env.L13_FAKE_FAULT ?? "") : "";
const FAULT_ONLY = process.env.L13_FAKE_FAULT_ONLY
  ? new RegExp(process.env.L13_FAKE_FAULT_ONLY)
  : null;
const HARNESS_FAULT = FAKE ? (process.env.L13_HARNESS_FAULT ?? "") : "";

/** The owner's rule (16 Nov 2026): "the quiet that counts is 1 second". Written as the number, not read from the app. */
const OWNER_QUIET_MS = 1000;

// ---------------------------------------------------------------------------------------------------------
// The corpus.

interface CorpusClip {
  id: string;
  kind: "synthetic" | "real";
  recording: string;
  set: string;
  group: string;
  language: string;
  text: string;
  x_s: number | null;
  total_seconds: number;
  wav: string;
  detector_ms: number | null;
  voice_s: number;
  expected_kind: "today" | "fix";
  boundary_ambiguous: boolean;
}

function loadCorpus(): CorpusClip[] {
  const wanted = process.env.L13_SET ?? "all";
  const files = [
    ...(wanted === "real" ? [] : ["corpus.json"]),
    ...(wanted === "synthetic" ? [] : ["real_clips.json"]),
  ];
  let clips: CorpusClip[] = [];
  for (const f of files) {
    const file = path.join(CORPUS, f);
    if (existsSync(file))
      clips = clips.concat(
        (JSON.parse(readFileSync(file, "utf8")) as { clips: CorpusClip[] }).clips,
      );
  }
  const only = process.env.L13_ONLY ?? "";
  if (only.startsWith("re:")) clips = clips.filter((c) => new RegExp(only.slice(3)).test(c.id));
  else if (only)
    clips = clips.filter((c) =>
      only
        .split(",")
        .map((s) => s.trim())
        .includes(c.id),
    );
  const limit = Number(process.env.L13_LIMIT) || 0;
  return limit > 0 ? clips.slice(0, limit) : clips;
}
const CLIPS = ENGINE === "fake" || ENGINE === "real" ? loadCorpus() : [];
const wavOf = (c: CorpusClip): string => path.join(CORPUS, c.wav);

// ---------------------------------------------------------------------------------------------------------
// What this machine must have, or the file skips naming it.

const modelEntry = MODEL_MANIFEST[MODEL_KEY];
const whisper = FAKE ? null : shippedSidecar("whisper-cli");
const ffmpeg = shippedSidecar("ffmpeg");
const missing: string[] = [];
if (ENGINE !== "fake" && ENGINE !== "real") missing.push("L13_ENGINE (fake or real)");
if (!ffmpeg)
  missing.push(
    "the shipped ffmpeg (src-tauri/binaries): it makes the engine's audio in both modes",
  );
if (CLIPS.length === 0) missing.push(`clips in ${CORPUS} (L13_CORPUS, L13_SET, L13_ONLY)`);
if (!modelEntry)
  missing.push(
    `the model key '${MODEL_KEY}' in this build's manifest (the q8_0 file is not in it: chip_probe.mjs runs that pair directly)`,
  );
if (ENGINE === "real") {
  if (!whisper) missing.push("the shipped whisper-cli (src-tauri/binaries)");
  if (!existsSync(DLL_DIR)) missing.push(`its libraries at ${DLL_DIR}`);
  if (modelEntry && !existsSync(path.join(MODEL_DIR, modelEntry.file)))
    missing.push(`${modelEntry.file} in L13_MODEL_DIR (${MODEL_DIR})`);
}
if (missing.length > 0 && ENGINE !== "")
  console.log(`[speechFirstWord] skipped: missing ${missing.join("; ")}`); // eslint-disable-line no-console

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
const fetchCalls: string[] = [];

// ---------------------------------------------------------------------------------------------------------
// The records. Nothing in a line names a person: the home folder is written as ~.

const HOME_FORMS = [HOME, HOME.replace(/\\/g, "\\\\"), HOME.replace(/\\/g, "/")];
const redact = (text: string): string =>
  HOME_FORMS.reduce((t, form) => t.split(form).join("~"), text);
let outReady: Promise<void> | null = null;
async function appendRecord(rec: Rec): Promise<void> {
  outReady ??= fsp.mkdir(path.dirname(OUT), { recursive: true }).then(() => undefined);
  await outReady;
  await fsp.appendFile(OUT, `${redact(JSON.stringify(rec))}\n`);
}

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

/** One launch as the app made it and the engine answered it. */
interface Launch {
  argv: string[];
  code: number | null;
  seconds: number;
  stderr: string;
  /** What the detector said of the audio file this launch was handed, read at the moment of the launch. */
  heard: VoiceStart;
}

/** The argv without the per-run names (the audio extract, the scratch output) and without the model's folder: what the
 *  builder decides, comparable between two runs. */
function normalized(argv: readonly string[]): string[] {
  return argv.map((a, i) => {
    const before = argv[i - 1];
    if (before === "-f") return "<wav>";
    if (before === "-of") return "<scratch>";
    if (before === "-m") return path.basename(a.replace(/\\/g, "/"));
    return a;
  });
}
/** `argv` with the app's own alignment arguments taken out, wherever the contiguous run of them stands. */
function withoutAlignment(argv: readonly string[]): string[] {
  for (let i = 0; i + DTW_ARGS.length <= argv.length; i++)
    if (DTW_ARGS.every((a, k) => argv[i + k] === a))
      return [...argv.slice(0, i), ...argv.slice(i + DTW_ARGS.length)];
  return [...argv];
}
const carries = (argv: readonly string[]): boolean => argv.includes("-dtw");

/** The test of this file's own assertions (L13_HARNESS_FAULT, fake only): what the app built is changed on its way to the
 *  engine, as a bug at the gate or the builder would change it, and the assertion that exists for it must fail. */
function withHarnessFault(args: string[]): string[] {
  if (HARNESS_FAULT === "always-dtw" && !carries(args)) return [...args, ...DTW_ARGS];
  if (HARNESS_FAULT === "never-dtw") return withoutAlignment(args);
  if (HARNESS_FAULT === "drop-mc" && carries(args)) {
    const at = args.indexOf("-mc");
    return at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  }
  return args;
}

function spawnFake(
  args: string[],
  clipFile: string,
  fault: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FAKE_ENGINE, ...args], {
      windowsHide: true,
      env: { ...process.env, L13_FAKE_CLIP_FILE: clipFile, L13_FAKE_FAULT: fault },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    alive.add(child);
    child.once("close", () => alive.delete(child));
    let stdout = "";
    let stderr = "";
    let killed = false;
    const onAbort = (): void => {
      killed = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (t: string) => (stdout += t));
    child.stderr.on("data", (t: string) => (stderr += t));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(killed ? { code: -1, stdout, stderr: "cancelled" } : { code, stdout, stderr });
    });
  });
}

/** What a runner that spawns no engine answers: a one-word transcript, so the app's builder runs to its end. */
async function stubEngine(args: readonly string[]): Promise<CommandResult> {
  const base = flagValue(args, "-of");
  if (base)
    await fsp.writeFile(
      `${base}.json`,
      JSON.stringify({
        result: { language: "en" },
        transcription: [
          {
            offsets: { from: 0, to: 1000 },
            text: " x",
            tokens: [{ text: " x", offsets: { from: 0, to: 1000 }, p: 0.9 }],
          },
        ],
      }),
    );
  return { code: 0, stdout: "", stderr: "" };
}

/** The runner the app is given: ffmpeg is the real one; the engine is the real one, the fake, or (spawn false) none, and every
 *  launch is recorded with what the detector says of the very file it is handed. */
function engineRunner(
  launches: Launch[],
  clipFile: string,
  clipId: string,
  spawnEngine: boolean,
): CommandRunner {
  return {
    async run(program, appArgs, signal, cwd, onStdout) {
      if (program !== "whisper-cli") return nodeRunner.run(program, appArgs, signal, cwd, onStdout);
      const args = withHarnessFault([...appArgs]);
      const wav = flagValue(args, "-f") ?? "";
      let heard: VoiceStart = { kind: "unknown" };
      try {
        heard = voiceStartOf(await nodeFs.readHead!(wav, 1_048_576));
      } catch {
        /* a file that cannot be read is `unknown`, as for the app */
      }
      const record: Launch = { argv: [...args], code: null, seconds: 0, stderr: "", heard };
      launches.push(record);
      const started = Date.now();
      let result: CommandResult;
      if (!spawnEngine) result = await stubEngine(args);
      else if (FAKE)
        result = await spawnFake(
          args,
          clipFile,
          FAULT && (!FAULT_ONLY || FAULT_ONLY.test(clipId)) ? FAULT : "",
          signal,
        );
      else result = await nodeRunner.run("whisper-cli", args, signal, cwd, onStdout);
      record.seconds = (Date.now() - started) / 1000;
      record.code = result.code;
      record.stderr = result.stderr;
      return result;
    },
  };
}

/** Each case gets its own app cache and work folder, so none is answered from another's transcript. */
function fsFor(label: string): FsLike {
  const cache = path.join(SCRATCH, "cache", label);
  const work = path.join(SCRATCH, "work", label);
  return {
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
}
const ctxFor = (label: string, runner: CommandRunner, dir = PROJ): ClientToolContext =>
  ({ store: new ProjectStoreAccess(dir, fsFor(label)), runner }) as unknown as ClientToolContext;

/** The app's state for one case: the processor held (or not), and which side of the rule the constants are on. */
function configure(mode: Mode): void {
  __resetSpeechJobs();
  __resetSpeechSession();
  __resetWorkGate();
  __resetExportFlags();
  __resetWordTimesShipped();
  localStorage.clear();
  if (PC === "processor") holdCpuOnly(null);
  const rule = mode === "rule";
  __setWordTimesShipped(rule);
  __setWordTimesChipShipped(rule && PC === "chip" && ALLOW);
  __setExportFlag("speech_word_times", true);
}
/** Can the rule fire for this model file on this path at all (the app's lists, plus what L13_ALLOW added)? */
const RULE_CAN_FIRE = PC === "processor" ? MODEL_KEY === "small" || ALLOW : ALLOW;

function kindOf(launches: readonly Launch[], error: string | null): Kind {
  if (error !== null) return "error";
  if (!launches.some((l) => carries(l.argv))) return "today";
  const last = launches[launches.length - 1];
  return carries(launches[0].argv) && !carries(last.argv) ? "fix-failed-fell-back" : "fix";
}

/** The engine's own lines about where it ran, so a report can say what the chip did. */
function backendLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((l) => /use gpu|flash attn|dtw\s*=|backend|ggml_vulkan|no GPU|device/i.test(l))
    .slice(0, 8)
    .map((l) => redact(l.trim()).slice(0, 160));
}

interface Run {
  mode: Mode;
  launches: Launch[];
  words: Array<[string, number, number]> | null;
  seconds: number;
  error: string | null;
  kind: Kind;
}

/** The argv the app's own builder makes for this clip with the constants off, nothing run: the oracle for what a launch may differ by. */
async function baselineNorm(clip: CorpusClip, label: string): Promise<string[]> {
  configure("today");
  const launches: Launch[] = [];
  const ctx = ctxFor(`${label}-baseline`, engineRunner(launches, "", clip.id, false));
  await runWhisper(ctx, wavOf(clip), MODEL_KEY, NAMED_LANGUAGE ? clip.language : undefined);
  return normalized(launches[0].argv);
}

async function runCase(clip: CorpusClip, mode: Mode): Promise<Run> {
  configure(mode);
  const clipFile = path.join(SCRATCH, "fake", `${clip.id}.json`);
  if (FAKE) {
    await fsp.mkdir(path.dirname(clipFile), { recursive: true });
    await fsp.writeFile(
      clipFile,
      JSON.stringify({ id: clip.id, language: clip.language, text: clip.text }),
    );
  }
  const launches: Launch[] = [];
  const ctx = ctxFor(`${clip.id}-${mode}`, engineRunner(launches, clipFile, clip.id, true));
  const started = Date.now();
  let words: Run["words"] = null;
  let error: string | null = null;
  try {
    const t = await runWhisper(
      ctx,
      wavOf(clip),
      MODEL_KEY,
      NAMED_LANGUAGE ? clip.language : undefined,
    );
    words = t.words.map((w) => [w.word, w.start_seconds, w.end_seconds]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const seconds = (Date.now() - started) / 1000;
  return { mode, launches, words, seconds, error, kind: kindOf(launches, error) };
}

const heardMs = (l: Launch): number | null => (l.heard.kind === "at" ? l.heard.ms : null);

/** The line for one run of one clip. */
function runRecord(clip: CorpusClip, run: Run, base: string[], detectorMs: number | null): Rec {
  const first = run.words?.[0] ?? null;
  const quiet = clip.x_s ?? clip.voice_s;
  const logs = run.launches.map((l) => whisperRunFacts(l.stderr));
  return {
    schema: "l13-first-word-run/1",
    record: "run",
    ts: new Date().toISOString(),
    engine: ENGINE,
    model: MODEL_KEY,
    path: PC,
    allow: ALLOW,
    harness_fault: HARNESS_FAULT || null,
    engine_fault: FAULT || null,
    clip: clip.id,
    set: clip.kind,
    group: clip.group,
    language: clip.language,
    recording: clip.recording,
    quiet_s: quiet,
    total_seconds: clip.total_seconds,
    known_voice_s: clip.voice_s,
    voice_basis: clip.kind === "synthetic" ? "constructed" : "onset proxy of the study",
    expected_kind: clip.expected_kind,
    boundary_ambiguous: clip.boundary_ambiguous,
    detector_ms: detectorMs,
    detector_ref_ms: clip.detector_ms,
    mode: run.mode,
    kind: run.kind,
    launch_count: run.launches.length,
    heard_ms: run.launches.map(heardMs),
    launch_line: redact(
      ["whisper-cli", ...(run.launches[0]?.argv ?? [])]
        .map((a) => (/\s/.test(a) ? `"${a}"` : a))
        .join(" "),
    ),
    launch_norm: normalized(run.launches[0]?.argv ?? []),
    launch_norm_last: normalized(run.launches[run.launches.length - 1]?.argv ?? []),
    baseline_norm: base,
    launches: run.launches.map((l, i) => ({
      code: l.code,
      seconds: l.seconds,
      carried: carries(l.argv),
      backend: logs[i].backend,
      backend_log: backendLines(l.stderr),
    })),
    seconds: run.seconds,
    first_word_s: first ? first[1] : null,
    first_words: (run.words ?? []).slice(0, 3).map((w) => [w[0], w[1]]),
    late_s: first ? first[1] - clip.voice_s : null,
    word_count: run.words?.length ?? 0,
    words: run.words,
    error: run.error,
  };
}

/** The owner's rule against the corpus, written as the number: may this clip's rule launch carry the arguments, must it, must it not. */
function ruleSays(clip: CorpusClip, heard: VoiceStart): "fix" | "today" {
  if (!RULE_CAN_FIRE) return "today";
  if (clip.boundary_ambiguous)
    return heard.kind === "at" && heard.ms > OWNER_QUIET_MS ? "fix" : "today";
  return clip.expected_kind;
}

// ---------------------------------------------------------------------------------------------------------

// File-level setup, shared by both parts below: the globals a node process lacks, the model where the app looks, the network refused.
// A real engine is warmed once first (the app hashes the model file the first time; the file is read from disk cold), so that cost
// lands in no clip's seconds; the warm-up is written as its own line.
beforeAll(async () => {
  if (missing.length > 0) return;
  installGlobal("navigator", {
    hardwareConcurrency:
      Number(process.env.L13_CORES) || os.availableParallelism?.() || os.cpus().length,
  });
  installGlobal("localStorage", memoryStorage());
  installGlobal("fetch", (input: unknown) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error("the first-word harness must not use the network"));
  });
  __setDownloadPolicy(SINGLE_ATTEMPT);
  await installModel();
  if (ALLOW) allowModel();
  if (!FAKE && process.env.L13_WARMUP !== "0") {
    const warm = await runCase(CLIPS[0], "today");
    await appendRecord({
      schema: "l13-first-word-run/1",
      record: "warmup",
      engine: ENGINE,
      model: MODEL_KEY,
      path: PC,
      clip: CLIPS[0].id,
      kind: warm.kind,
      seconds: warm.seconds,
      error: warm.error,
    });
  }
}, 180_000);

afterAll(async () => {
  if (missing.length > 0) return;
  killAlive();
  __setDownloadPolicy(PATIENT_DOWNLOAD);
  __resetWordTimesShipped();
  __resetExportFlags();
  for (const undo of restore.splice(0).reverse()) undo();
  await new Promise((resolve) => setTimeout(resolve, 400)); // the app's cache index is written behind a run's back
  await fsp.rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(missing.length > 0 || PART === "gettranscript")(
  `the first-word rule through the app's own code (${ENGINE} engine, ${MODEL_KEY}, ${PC})`,
  () => {
    for (const clip of CLIPS) {
      it(`${clip.id}: ${MODES.join(" then ")}`, async () => {
        const bytes = new Uint8Array(await fsp.readFile(wavOf(clip)));
        const wav = pcm16WavSamples(bytes);
        const detectorMs = wav ? speechOnsetMs(wav.samples, wav.rate) : null;
        const base = await baselineNorm(clip, clip.id);
        const runs: Partial<Record<Mode, Run>> = {};
        // The modes alternate their order from one clip to the next, so the second run of a pair is not always the warm one.
        const order =
          process.env.L13_ORDER === "fixed" || CLIPS.indexOf(clip) % 2 === 0
            ? MODES
            : [...MODES].reverse();
        for (const mode of order) {
          const run = await runCase(clip, mode);
          runs[mode] = run;
          await appendRecord({ ...runRecord(clip, run, base, detectorMs), order: order.join(">") });
        }
        for (const mode of MODES) check(clip, runs[mode]!, base, runs.today ?? null, detectorMs);
      });
    }

    it("never touched the network", () => {
      expect(fetchCalls).toEqual([]);
    });
  },
);

/** The assertions of one run: the launch is what the app's builder makes, with the arguments exactly when the owner's rule says. */
function check(
  clip: CorpusClip,
  run: Run,
  base: string[],
  today: Run | null,
  detectorMs: number | null,
): void {
  const label = `${clip.id} (${run.mode})`;
  expect(run.error, `${label}: the app made words`).toBeNull();
  expect(run.launches.length, `${label}: the engine was launched`).toBeGreaterThan(0);
  const first = run.launches[0];
  if (run.mode !== "rule") {
    expect(run.kind, `${label}: with the constants off no launch carries the alignment`).toBe(
      "today",
    );
    expect(
      normalized(first.argv),
      `${label}: the gate-off launch is the one the builder makes`,
    ).toEqual(base);
    return;
  }
  // The detector saw the very file the engine was handed, and it is the clip's own samples (16 kHz mono 16-bit).
  const heard = heardMs(first);
  if (detectorMs !== null)
    expect(
      heard,
      `${label}: what the app measured before the launch is the detector's answer on the clip's samples`,
    ).toBe(detectorMs);
  if (clip.detector_ms !== null && heard !== null)
    expect
      .soft(
        Math.abs(heard - clip.detector_ms),
        `${label}: the study's reference detector agrees within a frame`,
      )
      .toBeLessThanOrEqual(20);
  const wants = ruleSays(clip, first.heard);
  if (wants === "today") {
    expect(
      run.kind,
      `${label}: a voice at ${first.heard.kind === "at" ? first.heard.ms : first.heard.kind} ms keeps the launch of 0.27.0`,
    ).toBe("today");
    expect(normalized(first.argv), `${label}: the launch is the gate-off launch`).toEqual(base);
    if (today?.words)
      expect
        .soft(
          run.words,
          `${label}: the words are the gate-off words, word for word and time for time`,
        )
        .toEqual(today.words);
    return;
  }
  expect(
    ["fix", "fix-failed-fell-back"],
    `${label}: a voice later than a second carries the alignment`,
  ).toContain(run.kind);
  expect(
    withoutAlignment(normalized(first.argv)),
    `${label}: the launch is the gate-off launch plus the alignment arguments and nothing else`,
  ).toEqual(base);
  expect(
    carries(first.argv),
    `${label}: the first launch carried the app's alignment arguments`,
  ).toBe(true);
  if (run.kind === "fix-failed-fell-back") {
    const last = run.launches[run.launches.length - 1];
    expect(normalized(last.argv), `${label}: the retry is the gate-off launch`).toEqual(base);
  } else {
    // The study's own bound: with the alignment no first word is early by more than half a second.
    const early = run.words?.[0] ? clip.voice_s - run.words[0][1] : 0;
    expect
      .soft(early, `${label}: the first word is at most half a second before the voice`)
      .toBeLessThanOrEqual(0.5);
  }
}

/** Put the model file where the app looks for it: the real one linked in (the app hashes it itself the first time), or for the
 *  fake engine a file of the pinned size with the marker the app writes once it has checked the hash. */
async function installModel(): Promise<void> {
  await fsp.mkdir(path.join(PROJ, "src"), { recursive: true });
  await fsp.mkdir(MODELS_IN_APP, { recursive: true });
  const model = whisperModelPath(PROJ, MODEL_KEY, modelEntry.file);
  if (FAKE) {
    const handle = await fsp.open(model, "w");
    await handle.truncate(modelEntry.bytes);
    await handle.close();
    await fsp.writeFile(
      `${model}.verified.json`,
      JSON.stringify({ bytes: modelEntry.bytes, sha256: modelEntry.sha256 }),
    );
    return;
  }
  try {
    await fsp.link(path.join(MODEL_DIR, modelEntry.file), model);
  } catch {
    await fsp.copyFile(path.join(MODEL_DIR, modelEntry.file), model);
  }
}

/** L13_ALLOW: the model file is added to the app's measured list for the path under test, so the rule can fire there. */
function allowModel(): void {
  const list = (PC === "chip" ? WORD_TIMES_CHIP_MODELS : WORD_TIMES_MODELS) as string[];
  if (list.includes(MODEL_KEY)) return;
  list.push(MODEL_KEY);
  restore.push(() => void list.splice(list.indexOf(MODEL_KEY), 1));
}

// ---------------------------------------------------------------------------------------------------------
// get_transcript (brief I-7): the clip's span plus a second each side is transcribed on its own audio, and the words before the
// clip's in-point are dropped. Is a clip's first word there, and where, before and after the rule?

interface Scenario {
  id: string;
  clip: string;
  /** The source seconds the clip plays: [start, "end"] or absent for the whole file. */
  span: [number, "end"] | null;
  note: string;
}
const SCENARIOS: Scenario[] = [
  {
    id: "x3-whole",
    clip: "enT1_x3",
    span: null,
    note: "3 s of quiet in front, the whole file placed: the window is the whole file",
  },
  {
    id: "x3-in-before-voice",
    clip: "enT1_x3",
    span: [2.5, "end"],
    note: "3 s of quiet, the clip cut to start half a second before the voice",
  },
  {
    id: "x3-in-at-voice",
    clip: "enT1_x3",
    span: [3, "end"],
    note: "3 s of quiet, the clip cut to start at the voice: its window starts one second before it",
  },
  {
    id: "x0.5-whole",
    clip: "enT1_x0.5",
    span: null,
    note: "half a second of quiet, the whole file placed (the rule must change nothing)",
  },
  {
    id: "x0.5-in-at-voice",
    clip: "enT1_x0.5",
    span: [0.5, "end"],
    note: "half a second of quiet, the clip cut to start at the voice",
  },
];
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

describe.skipIf(missing.length > 0 || PART === "runs")(
  `get_transcript on clips with quiet in front (${ENGINE} engine, ${MODEL_KEY}, ${PC})`,
  () => {
    beforeAll(() => installE2EDocuments());
    afterAll(() => resetE2EDocuments());

    for (const sc of SCENARIOS) {
      const corpusClip = loadCorpusClip(sc.clip);
      it.skipIf(!corpusClip)(`${sc.id}: ${sc.note}`, async () => {
        const clip = corpusClip!;
        const found: Partial<Record<Mode, Rec>> = {};
        for (const mode of ["today", "rule"] as const) {
          configure(mode);
          const label = `gt-${sc.id}-${mode}`;
          const dir = joinPath(SCRATCH, "projects", label);
          await fsp.mkdir(dir, { recursive: true });
          const clipFile = path.join(SCRATCH, "fake", `${clip.id}.json`);
          if (FAKE) {
            await fsp.mkdir(path.dirname(clipFile), { recursive: true });
            await fsp.writeFile(
              clipFile,
              JSON.stringify({ id: clip.id, language: clip.language, text: clip.text }),
            );
          }
          const launches: Launch[] = [];
          const ctx = ctxFor(label, engineRunner(launches, clipFile, clip.id, true), dir);
          await ensureTimeline(ctx.store);
          await openE2EDoc(dir);
          const ref = await libRef(ctx, wavOf(clip), "audio");
          const inS = sc.span ? sc.span[0] : 0;
          const entry: Rec = { media_ref: ref, timeline_in: 0 };
          if (sc.span)
            entry.source_span = [sc.span[0], Math.floor((clip.total_seconds - 0.1) * 100) / 100];
          const placed = (await addClipsTool({ entries: [entry] }, ctx)) as Rec;
          expect(placed.ok, JSON.stringify(placed).slice(0, 300)).toBe(true);
          const started = Date.now();
          const tr = (await getTranscriptTool({}, ctx)) as Rec;
          const seconds = (Date.now() - started) / 1000;
          expect(tr.ok, JSON.stringify(tr).slice(0, 300)).toBe(true);
          const fps = Number(tr.fps) || 30;
          const rows = (
            (tr.clips as Array<{ words: Array<[number, string, number, number]> }> | undefined) ??
            []
          ).flatMap((c) => c.words);
          const truth = words(clip.text);
          const firstRow = rows[0] ?? null;
          const voiceOnTimeline = clip.voice_s - inS;
          const kind = kindOf(launches, null);
          found[mode] = {
            schema: "l13-first-word-run/1",
            record: "get_transcript",
            ts: new Date().toISOString(),
            engine: ENGINE,
            model: MODEL_KEY,
            path: PC,
            allow: ALLOW,
            scenario: sc.id,
            note: sc.note,
            clip: clip.id,
            mode,
            kind,
            launch_count: launches.length,
            heard_ms: launches.map(heardMs),
            launch_norm: normalized(launches[0]?.argv ?? []),
            seconds,
            fps,
            clip_in_source_s: inS,
            voice_on_timeline_s: voiceOnTimeline,
            words_expected: truth.length,
            words_returned: rows.length,
            first_word: firstRow ? firstRow[1] : null,
            first_word_s: firstRow ? firstRow[2] / fps : null,
            first_word_present: firstRow ? words(firstRow[1])[0] === truth[0] : false,
            first_word_late_s: firstRow ? firstRow[2] / fps - voiceOnTimeline : null,
            first_five: rows.slice(0, 5).map((r) => [r[1], r[2] / fps]),
          };
          await appendRecord(found[mode]!);
          // The rule on the window's own file: arguments exactly when its voice starts later than a second.
          const heard = launches[0]?.heard ?? { kind: "unknown" as const };
          const shouldCarry =
            mode === "rule" && RULE_CAN_FIRE && heard.kind === "at" && heard.ms > OWNER_QUIET_MS;
          expect(
            carries(launches[0].argv),
            `${sc.id} (${mode}): the window's launch carries the alignment exactly when the voice in its own file starts later than a second`,
          ).toBe(shouldCarry);
        }
      });
    }
  },
);

function loadCorpusClip(id: string): CorpusClip | null {
  const file = path.join(CORPUS, "corpus.json");
  if (!existsSync(file)) return null;
  return (
    (JSON.parse(readFileSync(file, "utf8")) as { clips: CorpusClip[] }).clips.find(
      (c) => c.id === id,
    ) ?? null
  );
}
