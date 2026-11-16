// The first-word rule (lane L13) through the REAL transcription path (runWhisper, ensureTranscripts, the model plan, the
// launch boundary, the job supervisor, the app cache) with a fake engine whose answers each test scripts:
//
//   a launch of the engine carries the alignment (`-dtw small -nfa`) if and only if the build ships it, the server has not
//   switched it off, the model file launched and the engine path were measured, the launch hears exactly ONE audio file
//   and the voice in THAT file starts MORE than one second in. Every other launch, the words kept and every word time are
//   what 0.27.0 made. A launch that carried it and failed is made once more without it, unless it was stopped.
//
// What is checked is what the engine is started with and what ends up kept, never how speechWordTimes.ts decides. The
// frozen outputs (speechFirstWordFrozen.test.ts) prove the same for the shipped state; speechWordTimes.test.ts walks the
// pure rule; speechLeadingQuiet.test.ts the detector.
import { readFileSync } from "node:fs";
import path from "node:path";

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

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __resetHostInfo } from "../platform/host";
import { __resetSpeechJobs, cancelSpeechJob } from "../store/speechJobs";
import { FakeJobs } from "../test/fakeJobs";
import {
  flagValues,
  freshSource,
  installModels,
  speechRig,
  wavWithVoiceAt,
  type SpeechRigOptions,
} from "../test/speechRig";
import { __resetJobSupervisor, __setJobSupervisor, type JobSpec } from "./jobSupervisor";
import { __resetSpeechSession } from "./speechAdmission";
import { cpuOnlyNow, holdCpuOnly, releaseCpuOnly, WINDOWS_LOAD_FAILURES } from "./speechBackend";
import { isSpeechCancelled, TranscriptionFailure } from "./speechFailure";
import {
  __resetWordTimesShipped,
  __setWordTimesChipShipped,
  __setWordTimesShipped,
  DTW_ARGS,
  WORD_TIMES_CHIP_MODELS,
  WORD_TIMES_MODELS,
} from "./speechWordTimes";
import {
  ensureTranscripts,
  parseWhisperCppJson,
  peekTranscript,
  runWhisper,
  SpeechEngineUnavailableError,
} from "./transcribe";
import { __resetWorkGate } from "./workGate";

const CRASH = -1073740791; // 0xC0000409, the exit the chip's crash is known for
const GPU_LOG =
  "ggml_vulkan: Found 1 Vulkan devices:\nwhisper_init_from_file_with_params_no_state: loading model\n";
const CLIP = readFileSync(
  path.join(__dirname, "__fixtures__", "wordTimes", "en-leading-silence.json"),
  "utf8",
);
/** The same clip from a run without -dtw: every token's time is -1. */
const CLIP_STORED = CLIP.replace(/"t_dtw": \d+/g, '"t_dtw": -1');
/** Where the clip's first word is stored (20 ms) and where it sounds (1.36 s): the engine's own two readings. */
const STORED = 0.02;
const SOUND = 1.36;
const ON_SOUND = parseWhisperCppJson(CLIP, { wordTimes: true });
const AS_STORED = parseWhisperCppJson(CLIP, { wordTimes: false });
const starts = (t: { words: Array<{ start_seconds: number }> }): number[] =>
  t.words.map((w) => w.start_seconds);
const FULL = "small";
const SMALLER = "small_q8_0";

const configure = (gate: boolean, flag: boolean): void => {
  __setWordTimesShipped(gate);
  __setExportFlag("speech_word_times", flag);
};
/** The PC's chip crashed: the app keeps it off, so a launch is the processor's. */
const processor = (): void => holdCpuOnly(CRASH);

/** Strings that differ from one run to the next, or from one clip to the next, made equal. */
const shape = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value)
      .replace(/"-t","\d+"/g, '"-t","<n>"')
      .replace(/rig-\d+/g, "rig-N")
      .replace(/\/transcribe\/[0-9a-z]+/g, "/transcribe/<h>")
      .replace(/\.[0-9a-z]{4,12}\.tmp/g, ".<t>.tmp"),
  );

type Output = "dtw" | "stored" | "none" | "garbage" | "partial";
interface Behaviour {
  code?: number;
  stderr?: string;
  /** What the process leaves at its output path: by default what a real engine writes for the arguments it was given. */
  output?: Output;
  /** Runs as the process ends, before its exit is seen. */
  before?: () => void;
}
interface SetupOptions {
  audio?: SpeechRigOptions["audio"];
  installed?: readonly string[];
  /** What the nth whisper-cli process does; `null` leaves it running for the test to stop. Absent: it works. */
  script?: (n: number, spec: JobSpec) => Behaviour | null;
}

/** One PC: a job supervisor whose processes the script plays, and a store whose audio the test chooses (by default a
 *  voice that starts at 2 s). */
function setup(options: SetupOptions = {}) {
  const jobs = new FakeJobs();
  __setJobSupervisor(jobs);
  const rig = speechRig({ audio: options.audio ?? (() => wavWithVoiceAt(2000)) });
  if (options.installed) installModels(rig, options.installed);
  let n = 0;
  const whisper = (): JobSpec[] => jobs.submitted.filter((s) => s.program === "whisper-cli");
  jobs.onStart = (spec) => {
    if (spec.program !== "whisper-cli") return;
    const how = options.script ? options.script(n++, spec) : {};
    if (how === null) return;
    setTimeout(() => {
      const output = how.output ?? (spec.args.includes("-dtw") ? "dtw" : "stored");
      if (output !== "none")
        for (const base of flagValues(spec.args, "-of")) {
          rig.files.add(`${base}.json`);
          rig.texts.set(
            `${base}.json`,
            output === "dtw"
              ? CLIP
              : output === "stored"
                ? CLIP_STORED
                : output === "garbage"
                  ? "usage: whisper-cli [options] file0.wav file1.wav ..."
                  : CLIP.slice(0, 400),
          );
        }
      how.before?.();
      jobs.exit(spec.id, how.code ?? 0, how.stderr ?? "");
    }, 0);
  };
  return { jobs, rig, whisper };
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !pred(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(pred()).toBe(true);
}

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetWordTimesShipped();
  __resetSpeechSession();
  __resetSpeechJobs();
  __resetWorkGate();
  reportAppError.mockClear();
  reportTranscription.mockClear();
  // The PC is a Windows one: with no history the engine is assumed to have a chip (on any other host it has none, and
  // the smaller model file is planned for it).
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WINDOWS_UA);
  __resetHostInfo();
});
afterEach(() => {
  __resetJobSupervisor();
  __resetExportFlags();
  __resetWordTimesShipped();
  (WORD_TIMES_CHIP_MODELS as string[]).length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetHostInfo();
});

describe("a voice that starts within a second is 0.27.0, one that starts later has the engine's own times", () => {
  /** One whole transcription of a clip whose voice starts `quietMs` in, under the build's gate. */
  async function made(gate: boolean, quietMs: number, size = FULL) {
    localStorage.clear();
    processor();
    configure(gate, true);
    const t = setup({ audio: () => wavWithVoiceAt(quietMs) });
    const transcript = await runWhisper(t.rig.ctx(), freshSource(), size, "en");
    const [spec] = t.whisper();
    return { ...t, spec, transcript, all: t.whisper() };
  }

  it.each([0, 400, 500, 900, 980, 1000])(
    "with %s ms of quiet in front the launch, its job, the kept words and every time are what they are with the gate off",
    async (quiet) => {
      const off = await made(false, quiet);
      const on = await made(true, quiet);
      expect(on.all).toHaveLength(1);
      expect(shape(on.spec.args)).toStrictEqual(shape(off.spec.args));
      expect(shape(on.spec.meta)).toStrictEqual(shape(off.spec.meta));
      expect(on.spec.meta).not.toHaveProperty("wordTimes");
      expect(on.transcript).toStrictEqual(off.transcript);
      expect(shape([...on.rig.kept.entries()])).toStrictEqual(shape([...off.rig.kept.entries()]));
      expect(on.transcript.words[0].start_seconds).toBe(STORED);
    },
  );

  it.each([1020, 1100, 1500, 3000, 8000])(
    "with %s ms of quiet in front the launch is today's plus the arguments after `-ng`, and the first word is on the sound",
    async (quiet) => {
      const off = await made(false, quiet);
      const on = await made(true, quiet);
      expect(on.all).toHaveLength(1);
      expect(shape(on.spec.args)).toStrictEqual(shape([...off.spec.args, ...DTW_ARGS]));
      expect(on.spec.args.slice(-4)).toEqual(["-ng", ...DTW_ARGS]);
      expect(shape(on.spec.meta)).toStrictEqual(
        shape({ ...(off.spec.meta as object), wordTimes: true }),
      );
      expect(off.transcript.words[0].start_seconds).toBe(STORED);
      expect(on.transcript.words[0].start_seconds).toBe(SOUND);
    },
  );

  it("keeps whatever the clip's voice does after the first second out of it: appending speech never turns an early voice into a late one", async () => {
    for (const voiceMs of [600, 3000, 30_000]) {
      const got = await (async () => {
        localStorage.clear();
        processor();
        configure(true, true);
        const t = setup({ audio: () => wavWithVoiceAt(600, voiceMs) });
        await runWhisper(t.rig.ctx(), freshSource(), FULL, "en");
        return t.whisper();
      })();
      expect(got[0].args, `${voiceMs} ms of voice`).not.toContain("-dtw");
    }
  });
});

describe("which launches can carry it: engine path x model file x switches x where the voice starts", () => {
  interface Row {
    path: "processor" | "chip";
    installed: readonly string[];
    gate: boolean;
    flag: boolean;
    quiet: number;
  }
  const rows: Row[] = [];
  for (const path of ["processor", "chip"] as const)
    for (const installed of [[FULL], [FULL, SMALLER]])
      for (const [gate, flag] of [
        [true, true],
        [false, true],
        [true, false],
      ])
        for (const quiet of [0, 1000, 1020, 3000])
          rows.push({ path, installed, gate, flag, quiet });

  it("walks every row: the arguments are on a launch exactly where the rule says, the file launched is the plan's, and the audio is read only where the rule can apply", async () => {
    let carried = 0;
    for (const row of rows) {
      localStorage.clear();
      if (row.path === "processor") processor();
      configure(row.gate, row.flag);
      let reads = 0;
      const t = setup({
        installed: row.installed,
        audio: () => {
          reads++;
          return wavWithVoiceAt(row.quiet);
        },
      });
      await runWhisper(t.rig.ctx(), freshSource(), FULL, "en");
      const [spec] = t.whisper();
      const name = JSON.stringify(row);
      // The smaller file is planned only for a PC on its processor that holds it, and is launched with `-ng`.
      const smaller = row.path === "processor" && row.installed.includes(SMALLER);
      expect(spec.args[spec.args.indexOf("-m") + 1], name).toMatch(
        smaller ? /ggml-small-q8_0\.bin$/ : /ggml-small\.bin$/,
      );
      expect(spec.args.includes("-ng"), name).toBe(row.path === "processor");
      // The rule: the file launched is one the alignment was measured on for the processor path (the list is the data a
      // release changes: one line), and the arguments are carried when the voice is late.
      const listed =
        row.path === "processor" && WORD_TIMES_MODELS.includes(smaller ? SMALLER : FULL);
      const carries = row.gate && row.flag && listed && row.quiet > 1000;
      expect(spec.args.includes("-dtw"), name).toBe(carries);
      expect(spec.args.includes("-nfa"), name).toBe(carries);
      expect(spec.meta, name).toSatisfy((m: object) => "wordTimes" in m === carries);
      // Nothing is read from the audio while the rule cannot apply: the build, the server, the file or the path say no.
      const mayRead = row.gate && row.flag && listed;
      expect(reads, name).toBe(mayRead ? 1 : 0);
      if (carries) carried++;
    }
    expect(carried, "the walk reaches the launches that carry it").toBeGreaterThan(0);
  });

  it("reads nothing for a run over several files that the rule cannot apply to (an unlisted file, the chip), and each late file's audio twice where it can: once to route it, once at its own launch", async () => {
    const run = async (
      path: "processor" | "chip",
      installed: readonly string[],
    ): Promise<{ reads: number; launches: number }> => {
      localStorage.clear();
      if (path === "processor") processor();
      configure(true, true);
      let reads = 0;
      const t = setup({
        installed,
        audio: () => {
          reads++;
          return wavWithVoiceAt(2000);
        },
      });
      const files = [freshSource(), freshSource()];
      await ensureTranscripts(t.rig.ctx(), files, FULL, "en");
      return { reads, launches: t.whisper().length };
    };
    const smallerListed = WORD_TIMES_MODELS.includes(SMALLER);
    // The smaller file is what a processor PC that holds it is planned: it carries nothing until it is listed.
    expect(await run("processor", [FULL, SMALLER])).toEqual(
      smallerListed ? { reads: 4, launches: 2 } : { reads: 0, launches: 1 },
    );
    expect(await run("chip", [FULL])).toEqual({ reads: 0, launches: 1 });
    expect(await run("processor", [FULL])).toEqual({ reads: 4, launches: 2 });
  });
});

describe("a launch whose audio's start is not known is today's launch", () => {
  const cases: Array<[string, SpeechRigOptions["audio"] | "no ranged read"]> = [
    ["a store with no ranged read at all", "no ranged read"],
    ["a file that cannot be read", () => null],
    ["a file that is not a WAV", () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])],
    ["a WAV cut inside its header", () => wavWithVoiceAt(2000).subarray(0, 30)],
    ["a WAV that holds nothing", () => wavWithVoiceAt(0, 0)],
    ["silence", () => new Uint8Array(wavWithVoiceAt(0, 0).length + 64_000)],
  ];
  it.each(cases)("%s", async (_name, audio) => {
    processor();
    configure(true, true);
    const t =
      audio === "no ranged read"
        ? (() => {
            const jobs = new FakeJobs();
            __setJobSupervisor(jobs);
            const rig = speechRig();
            jobs.onStart = (spec) =>
              void setTimeout(() => {
                for (const base of flagValues(spec.args, "-of")) {
                  rig.files.add(`${base}.json`);
                  rig.texts.set(`${base}.json`, CLIP_STORED);
                }
                jobs.exit(spec.id, 0, "");
              }, 0);
            return { rig, whisper: () => jobs.submitted };
          })()
        : setup({ audio });
    const transcript = await runWhisper(t.rig.ctx(), freshSource(), FULL, "en");
    const launches = t.whisper();
    expect(launches).toHaveLength(1);
    expect(launches[0].args).not.toContain("-dtw");
    expect(launches[0].meta).not.toHaveProperty("wordTimes");
    expect(transcript.words[0].start_seconds).toBe(STORED);
  });

  it("a read that throws, rejects or never returns does not stop the launch, and the one that never returns waits no longer than the guard", async () => {
    for (const how of ["throws", "rejects", "never"] as const) {
      localStorage.clear();
      processor();
      configure(true, true);
      // The engine is the page's own runner here (no job supervisor), so the only timer is the guard's.
      __resetJobSupervisor();
      const rig = speechRig({ audio: () => wavWithVoiceAt(2000) });
      Object.assign(rig.store, {
        readHead:
          how === "throws"
            ? () => {
                throw new Error("boom");
              }
            : how === "rejects"
              ? async () => {
                  throw new Error("boom");
                }
              : () => new Promise<never>(() => undefined),
      });
      if (how === "never") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = runWhisper(rig.ctx(), freshSource(), FULL, "en");
      // Time moves in steps until the launch happens: it must come once the guard (5 s) has run out, not before.
      let waited = 0;
      while (how === "never" && rig.launches.length === 0 && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      vi.useRealTimers();
      await run;
      expect(rig.launches, how).toHaveLength(1);
      expect(rig.launches[0], how).not.toContain("-dtw");
      if (how === "never") {
        expect(waited, "waits for the guard").toBeGreaterThanOrEqual(5_000);
        expect(waited, "and no longer").toBeLessThanOrEqual(6_000);
      }
    }
  });
});

describe("a window is judged on its own audio, never on the file's start", () => {
  const WINDOW = { start: 100, end: 110 };
  it("carries the arguments when the window's own audio has a late voice, whatever the whole file's start holds", async () => {
    processor();
    configure(true, true);
    const t = setup({ audio: (_s, _w, span) => wavWithVoiceAt(span ? 1500 : 200) });
    const transcript = await runWhisper(t.rig.ctx(), freshSource(), FULL, "en", WINDOW);
    expect(t.whisper()).toHaveLength(1);
    expect(t.whisper()[0].args.slice(-4)).toEqual(["-ng", ...DTW_ARGS]);
    expect(transcript.words[0].start_seconds).toBeCloseTo(WINDOW.start + SOUND, 9);
  });

  it("does not carry them when the window's own audio has an early voice, even when the whole file starts with a long quiet", async () => {
    processor();
    configure(true, true);
    const t = setup({ audio: (_s, _w, span) => wavWithVoiceAt(span ? 300 : 5000) });
    const transcript = await runWhisper(t.rig.ctx(), freshSource(), FULL, "en", WINDOW);
    expect(t.whisper()[0].args).not.toContain("-dtw");
    expect(transcript.words[0].start_seconds).toBeCloseTo(WINDOW.start + STORED, 9);
  });

  it("reads exactly one file per launch: the window's extract, once", async () => {
    processor();
    configure(true, true);
    const seen: Array<{ wav: string; span: unknown }> = [];
    const t = setup({
      audio: (_s, wav, span) => {
        seen.push({ wav, span });
        return wavWithVoiceAt(1500);
      },
    });
    await runWhisper(t.rig.ctx(), freshSource(), FULL, "en", WINDOW);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ span: { start: WINDOW.start, end: WINDOW.end } });
  });
});

describe("a run over several files never carries the arguments: a file whose voice starts late is run alone, with them", () => {
  /** Every way three files can start, early (400 ms) or late (2 s). */
  const patterns: boolean[][] = [];
  for (let m = 0; m < 8; m++) patterns.push([!!(m & 1), !!(m & 2), !!(m & 4)]);

  it.each(patterns)("files late: %s, %s, %s", async (...late) => {
    processor();
    configure(true, true);
    const files = late.map(() => freshSource());
    const t = setup({
      audio: (source) => wavWithVoiceAt(late[files.indexOf(source)] ? 2000 : 400),
    });
    const outcomes = await ensureTranscripts(t.rig.ctx(), files, FULL, "en");
    expect(outcomes.map((o) => o.ok)).toEqual(files.map(() => true));
    const launches = t.whisper();
    const together = launches.filter((s) => flagValues(s.args, "-f").length > 1);
    const alone = launches.filter((s) => flagValues(s.args, "-f").length === 1);
    for (const s of together) expect(s.args).not.toContain("-dtw");
    // Each late file has its own launch with the arguments; the early ones share one launch, or run alone when only one is left.
    const lateCount = late.filter(Boolean).length;
    const earlyCount = late.length - lateCount;
    expect(alone.filter((s) => s.args.includes("-dtw"))).toHaveLength(lateCount);
    expect(together).toHaveLength(earlyCount >= 2 ? 1 : 0);
    expect(alone.filter((s) => !s.args.includes("-dtw"))).toHaveLength(earlyCount === 1 ? 1 : 0);
    // Every file's words were kept once, and a late file's first word is on the sound while an early one's is today's.
    for (const [i, src] of files.entries())
      expect(
        (await peekTranscript(t.rig.ctx(), src, FULL, "en"))!.words[0].start_seconds,
        src,
      ).toBe(late[i] ? SOUND : STORED);
  });
  it("never gives a launch over several files the arguments, even for a file whose audio reads later than it did when the run was planned", async () => {
    processor();
    configure(true, true);
    const files = [freshSource(), freshSource()];
    const reads = new Map<string, number>();
    const t = setup({
      audio: (source) => {
        const n = (reads.get(source) ?? 0) + 1;
        reads.set(source, n);
        return wavWithVoiceAt(n === 1 ? 400 : 3000);
      },
    });
    const outcomes = await ensureTranscripts(t.rig.ctx(), files, FULL, "en");
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    // Both read as early when the run was planned, so both stayed in the shared run, which can carry nothing.
    expect(t.whisper()).toHaveLength(1);
    expect(flagValues(t.whisper()[0].args, "-f")).toHaveLength(2);
    expect(t.whisper()[0].args).not.toContain("-dtw");
    expect(t.whisper()[0].meta).not.toHaveProperty("items.0.wordTimes");
  });
});

describe("a launch that carried the arguments and failed is made once more without them", () => {
  /** One whole transcription with the gate on and the first process misbehaving as `bad` says, against the same with the gate off. */
  async function twice(bad: Behaviour, retry: Behaviour = {}) {
    const run = async (gate: boolean) => {
      localStorage.clear();
      processor();
      configure(gate, true);
      const t = setup({ script: (n) => (gate ? (n === 0 ? bad : retry) : retry) });
      const outcome = await runWhisper(t.rig.ctx(), freshSource(), FULL, "en").catch(
        (e: unknown) => e,
      );
      return { ...t, outcome, specs: t.whisper() };
    };
    return { today: await run(false), got: await run(true) };
  }

  const FAILURES: Array<[string, Behaviour]> = [
    ["a non-zero exit and no output", { code: 1, output: "none" }],
    ["an exit 0 and no output file", { code: 0, output: "none" }],
    ["an exit 0 and an output that is not JSON", { code: 0, output: "garbage" }],
    ["an exit 0 and an output cut short", { code: 0, output: "partial" }],
    ["a non-zero exit with a partial output left behind", { code: 1, output: "partial" }],
    ["an access violation", { code: -1073741819, output: "none" }],
    [
      "the chip's crash status on a launch that was never on the chip",
      { code: CRASH, stderr: GPU_LOG, output: "none" },
    ],
    [
      "an engine that does not know the argument",
      { code: 1, stderr: "error: unknown argument: -dtw", output: "none" },
    ],
  ];

  it.each(FAILURES)(
    "%s: one more launch, which is today's launch, and today's words",
    async (_name, bad) => {
      const { today, got } = await twice(bad);
      expect(today.specs).toHaveLength(1);
      expect(got.specs).toHaveLength(2);
      expect(got.specs[0].args.slice(-4)).toEqual(["-ng", ...DTW_ARGS]);
      expect(got.specs[0].meta).toMatchObject({ wordTimes: true });
      // The second launch is the launch 0.27.0 made, its job says nothing of the alignment, and the words are today's.
      expect(shape(got.specs[1].args)).toStrictEqual(shape(today.specs[0].args));
      expect(got.specs[1].meta).not.toHaveProperty("wordTimes");
      expect(got.outcome).toStrictEqual(today.outcome);
      expect(starts(got.outcome as { words: Array<{ start_seconds: number }> })).toStrictEqual(
        starts(AS_STORED),
      );
      // Nothing is left behind, every job is let go of, and nobody is told the chip crashed.
      expect(got.rig.leftovers()).toEqual([]);
      expect(got.jobs.forgotten.slice().sort()).toEqual(got.specs.map((s) => s.id).sort());
      expect(reportAppError).not.toHaveBeenCalled();
    },
  );

  it("fails as a failed 0.27.0 launch does when the second launch fails too, after exactly two launches, and never builds the words from the first one's partial output", async () => {
    const { today, got } = await twice(
      { code: 1, output: "partial", stderr: "first" },
      { code: 0, output: "none", stderr: "second" },
    );
    expect(got.specs).toHaveLength(2);
    expect(got.outcome).toBeInstanceOf(TranscriptionFailure);
    expect((got.outcome as TranscriptionFailure).reason).toBe("engine_failed");
    expect((today.outcome as TranscriptionFailure).reason).toBe("engine_failed");
    expect((got.outcome as Error).message).toBe((today.outcome as Error).message);
    expect(got.rig.leftovers()).toEqual([]);
    expect(got.jobs.forgotten.slice().sort()).toEqual(got.specs.map((s) => s.id).sort());
  });

  it("does not make the launch again for a launch that worked", async () => {
    const { got } = await twice({ code: 0 });
    expect(got.specs).toHaveLength(1);
    expect(starts(got.outcome as { words: Array<{ start_seconds: number }> })).toStrictEqual(
      starts(ON_SOUND),
    );
  });

  it.each([...WINDOWS_LOAD_FAILURES])(
    "does not make it again when the engine cannot start at all (exit %s): without the arguments it could not either",
    async (code) => {
      const { got } = await twice({ code, output: "none" });
      expect(got.specs).toHaveLength(1);
      expect(got.outcome).toBeInstanceOf(SpeechEngineUnavailableError);
    },
  );

  it("does not make it again for a language the engine does not know, which prints its usage and exits 0", async () => {
    const { got } = await twice({
      code: 0,
      output: "none",
      stderr: "error: unknown language 'zz'\nusage: whisper-cli",
    });
    expect(got.specs).toHaveLength(1);
    expect((got.outcome as TranscriptionFailure).reason).toBe("language_rejected");
  });

  describe("and never when the run was stopped", () => {
    it("the person pressed Cancel during the first launch: one launch, answered as a cancel", async () => {
      processor();
      configure(true, true);
      const t = setup({ script: () => null });
      const run = runWhisper(t.rig.ctx({ background: true }), freshSource(), FULL, "en").catch(
        (e: unknown) => e,
      );
      await until(() => t.whisper().length === 1);
      const [first] = t.whisper();
      expect(first.args).toContain("-dtw");
      cancelSpeechJob(first.id);
      expect(isSpeechCancelled(await run)).toBe(true);
      expect(t.whisper()).toHaveLength(1);
      expect(t.jobs.killed).toEqual([first.id]);
      expect(reportAppError).not.toHaveBeenCalled();
    });

    it("the person pressed Cancel as the alignment launch died by itself with another exit: still no second launch, answered as a cancel", async () => {
      processor();
      configure(true, true);
      const t = setup({ script: () => null });
      const run = runWhisper(t.rig.ctx({ background: true }), freshSource(), FULL, "en").catch(
        (e: unknown) => e,
      );
      await until(() => t.whisper().length === 1);
      const [first] = t.whisper();
      t.jobs.exit(first.id, 1, ""); // it died by itself...
      cancelSpeechJob(first.id); // ...as the person pressed Cancel
      expect(isSpeechCancelled(await run)).toBe(true);
      expect(t.whisper()).toHaveLength(1);
      expect(reportAppError).not.toHaveBeenCalled();
    });

    it("the caller's own Stop during the first launch: one launch", async () => {
      processor();
      configure(true, true);
      const stop = new AbortController();
      const t = setup({ script: () => null });
      const run = runWhisper(t.rig.ctx({ signal: stop.signal }), freshSource(), FULL, "en").catch(
        (e: unknown) => e,
      );
      await until(() => t.whisper().length === 1);
      stop.abort();
      await run;
      expect(t.whisper()).toHaveLength(1);
    });

    it("the person pressed Cancel during the second launch: no third launch, answered as a cancel", async () => {
      processor();
      configure(true, true);
      const t = setup({ script: (n) => (n === 0 ? { code: 1, output: "none" } : null) });
      const run = runWhisper(t.rig.ctx({ background: true }), freshSource(), FULL, "en").catch(
        (e: unknown) => e,
      );
      await until(() => t.whisper().length === 2);
      const [first, second] = t.whisper();
      expect(second.args).not.toContain("-dtw");
      expect(cancelSpeechJob(first.id), "the first has ended").toBe(false);
      expect(cancelSpeechJob(second.id)).toBe(true);
      expect(isSpeechCancelled(await run)).toBe(true);
      expect(t.whisper()).toHaveLength(2);
      expect(t.jobs.killed).toEqual([second.id]);
    });

    it("a Stop that arrives as the first launch ends in failure: the failure is not made up for", async () => {
      processor();
      configure(true, true);
      const stop = new AbortController();
      const t = setup({
        script: (n) => (n === 0 ? { code: 1, output: "none", before: () => stop.abort() } : {}),
      });
      const outcome = await runWhisper(
        t.rig.ctx({ signal: stop.signal }),
        freshSource(),
        FULL,
        "en",
      ).catch((e: unknown) => e);
      expect(t.whisper()).toHaveLength(1);
      expect(outcome).toBeInstanceOf(Error);
    });
  });
});

describe("the graphics chip, if a later release turns its own constant on and lists a model file for it", () => {
  const chipOn = (): void => {
    __setWordTimesChipShipped(true);
    (WORD_TIMES_CHIP_MODELS as string[]).push(FULL);
  };

  it("is today's launch while its constant is off, and carries the arguments on the chip, without `-ng`, once both are on and the voice is late", async () => {
    configure(true, true);
    const off = setup();
    await runWhisper(off.rig.ctx(), freshSource(), FULL, "en");
    expect(off.whisper()[0].args).not.toContain("-dtw");
    expect(off.whisper()[0].args).not.toContain("-ng");
    __resetJobSupervisor();
    chipOn();
    const on = setup();
    const transcript = await runWhisper(on.rig.ctx(), freshSource(), FULL, "en");
    expect(on.whisper()[0].args).not.toContain("-ng");
    expect(on.whisper()[0].args.slice(-3)).toEqual([...DTW_ARGS]);
    expect(transcript.words[0].start_seconds).toBe(SOUND);
  });

  it("makes a failed alignment launch once more on the chip, without the arguments, and does not hold the chip off", async () => {
    configure(true, true);
    chipOn();
    const t = setup({ script: (n) => (n === 0 ? { code: 1, output: "none" } : {}) });
    const transcript = await runWhisper(t.rig.ctx(), freshSource(), FULL, "en");
    const [first, second] = t.whisper();
    expect(t.whisper()).toHaveLength(2);
    expect(first.args).toContain("-dtw");
    expect(second.args).not.toContain("-dtw");
    expect(second.args).not.toContain("-ng");
    expect(cpuOnlyNow(), "the chip is not held").toBe(false);
    expect(reportAppError).not.toHaveBeenCalled();
    expect(transcript.words[0].start_seconds).toBe(STORED);
  });

  it("does not take the alignment launch's crash for the chip's when the launch without it works: the chip stays on and nothing is reported", async () => {
    configure(true, true);
    chipOn();
    const t = setup({
      script: (n) => (n === 0 ? { code: CRASH, stderr: GPU_LOG, output: "none" } : {}),
    });
    await runWhisper(t.rig.ctx(), freshSource(), FULL, "en");
    expect(t.whisper()).toHaveLength(2);
    expect(t.whisper()[1].args).not.toContain("-ng");
    expect(cpuOnlyNow()).toBe(false);
    expect(reportAppError).not.toHaveBeenCalled();
  });

  it("takes it for the chip's crash when the launch without the arguments crashes too: then the processor, with no arguments, and the chip is held", async () => {
    configure(true, true);
    chipOn();
    const t = setup({
      script: (n) => (n < 2 ? { code: CRASH, stderr: GPU_LOG, output: "none" } : {}),
    });
    const transcript = await runWhisper(t.rig.ctx(), freshSource(), FULL, "en");
    const [a, b, c] = t.whisper();
    expect(t.whisper()).toHaveLength(3);
    expect([a, b, c].map((s) => s.args.includes("-ng"))).toEqual([false, false, true]);
    expect([a, b, c].map((s) => s.args.includes("-dtw"))).toEqual([true, false, false]);
    expect(cpuOnlyNow()).toBe(true);
    expect(transcript.words[0].start_seconds).toBe(STORED);
  });
});

describe("kept transcripts and the cache", () => {
  it("asks the engine once: the next request for the same clip is answered from the cache, and read on the sound", async () => {
    processor();
    configure(true, true);
    const t = setup();
    const src = freshSource();
    await runWhisper(t.rig.ctx(), src, FULL, "en");
    const again = await runWhisper(t.rig.ctx(), src, FULL, "en");
    expect(t.whisper()).toHaveLength(1);
    expect(again.words[0].start_seconds).toBe(SOUND);
  });

  it("is read as a whole, never in part, whatever order the server's switch and the build's gate change in between", async () => {
    processor();
    configure(true, true);
    const t = setup();
    const src = freshSource();
    await runWhisper(t.rig.ctx(), src, FULL, "en");
    for (const [gate, flag] of [
      [true, true],
      [true, false],
      [false, true],
      [true, true],
      [false, false],
      [true, true],
    ] as const) {
      configure(gate, flag);
      const read = starts((await peekTranscript(t.rig.ctx(), src, FULL, "en"))!);
      expect(read, `gate ${gate} flag ${flag}`).toStrictEqual(
        starts(gate && flag ? ON_SOUND : AS_STORED),
      );
    }
  });

  it("reads a transcript made for an early voice as 0.27.0 read it, whatever the switches say afterwards", async () => {
    processor();
    configure(true, true);
    const t = setup({ audio: () => wavWithVoiceAt(400) });
    const src = freshSource();
    await runWhisper(t.rig.ctx(), src, FULL, "en");
    expect(t.whisper()[0].args).not.toContain("-dtw");
    for (const [gate, flag] of [
      [true, true],
      [false, true],
      [true, false],
    ] as const) {
      configure(gate, flag);
      expect(starts((await peekTranscript(t.rig.ctx(), src, FULL, "en"))!)).toStrictEqual(
        starts(AS_STORED),
      );
    }
  });
});

describe("the decision is taken at the launch, from what is true then", () => {
  it("is today's launch when the switch is thrown while the audio is being read: the answer at selection time does not count", async () => {
    processor();
    configure(true, true);
    const t = setup({
      audio: () => {
        __setExportFlag("speech_word_times", false);
        return wavWithVoiceAt(2000);
      },
    });
    const transcript = await runWhisper(t.rig.ctx(), freshSource(), FULL, "en");
    expect(t.whisper()[0].args).not.toContain("-dtw");
    expect(t.whisper()[0].meta).not.toHaveProperty("wordTimes");
    expect(transcript.words[0].start_seconds).toBe(STORED);
  });

  it("follows the PC's chip from one run to the next: the processor's launch has the arguments, a later launch back on the chip does not", async () => {
    configure(true, true);
    processor();
    const onProcessor = setup();
    await runWhisper(onProcessor.rig.ctx(), freshSource(), FULL, "en");
    expect(onProcessor.whisper()[0].args.slice(-4)).toEqual(["-ng", ...DTW_ARGS]);
    __resetJobSupervisor();
    releaseCpuOnly();
    const backOnTheChip = setup();
    await runWhisper(backOnTheChip.rig.ctx(), freshSource(), FULL, "en");
    expect(backOnTheChip.whisper()[0].args).not.toContain("-ng");
    expect(backOnTheChip.whisper()[0].args).not.toContain("-dtw");
  });
});
