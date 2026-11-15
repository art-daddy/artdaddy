// The first-word fix through the REAL transcription path (runWhisper, ensureTranscripts, the model check, the app
// cache, the job supervisor) with a fake engine: which launches of the engine are given word times, what the kept
// transcript then says of the first word, and that with the behaviour off (the shipped state) every launch is
// exactly what it was in 0.27.0. The engine writes what the real one writes: with -dtw a time for every token, and
// without it -1 (the real outputs of the speech study, __fixtures__/wordTimes).
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
import { FakeJobs } from "../test/fakeJobs";
import { DIR, flagValues, freshSource, speechRig, type SpeechRigOptions } from "../test/speechRig";
import { __resetJobSupervisor, __setJobSupervisor } from "./jobSupervisor";
import { __resetSpeechSession } from "./speechAdmission";
import { cpuOnlyNow, holdCpuOnly } from "./speechBackend";
import { __resetWordTimesShipped, __setWordTimesShipped, DTW_ARGS } from "./speechWordTimes";
import {
  ensureTranscripts,
  peekTranscript,
  runWhisper,
  WHISPER_MODELS,
  whisperModelPath,
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
const CLIP_NO_DTW = CLIP.replace(/"t_dtw": \d+/g, '"t_dtw": -1');
/** Where the clip's first word is stored (20 ms) and where it sounds (1.36 s). */
const STORED = 0.02;
const SOUND = 1.36;
const TAIL = [...DTW_ARGS];

const configure = (gate: boolean, flag: boolean): void => {
  __setWordTimesShipped(gate);
  __setExportFlag("speech_word_times", flag);
};
const hold = (): void => holdCpuOnly(CRASH);

/** A rig whose engine writes what the real one writes for the arguments it was given. */
function engineRig(options: SpeechRigOptions = {}) {
  const rig = speechRig(options);
  const inner = rig.runner.run;
  const runner = {
    run: vi.fn(async (program: string, args: string[], signal?: AbortSignal) => {
      const answer = await inner(program, args, signal);
      if (program === "whisper-cli" && answer.code === 0)
        for (const out of flagValues(args, "-of"))
          rig.texts.set(`${out}.json`, args.includes("-dtw") ? CLIP : CLIP_NO_DTW);
      return answer;
    }),
  };
  return {
    ...rig,
    ctx: (over: Record<string, unknown> = {}) => rig.ctx({ runner, ...over } as never),
  };
}
/** The arguments of a launch, with the one name that is unique to every run (the engine's scratch output). */
const argv = (args: string[]): string[] =>
  args.map((a, i) => (args[i - 1] === "-of" ? "<scratch>" : a));

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetWordTimesShipped();
  __resetSpeechSession();
  __resetWorkGate();
  reportAppError.mockClear();
  reportTranscription.mockClear();
});
afterEach(() => {
  __resetJobSupervisor();
  __resetExportFlags();
  __resetWordTimesShipped();
});

/** One transcription of `src` under the conditions given: its launches and its transcript. */
async function transcribed(
  conditions: { gate: boolean; flag: boolean; processor: boolean },
  src: string,
  size = "small",
) {
  localStorage.clear();
  if (conditions.processor) hold();
  configure(conditions.gate, conditions.flag);
  const rig = engineRig();
  rig.store.byteSize = async (p: string) =>
    p === whisperModelPath(DIR, size) ? WHISPER_MODELS.small.bytes : 0;
  rig.files.add(whisperModelPath(DIR, size));
  const transcript = await runWhisper(rig.ctx(), src, size, "en");
  return { launches: rig.launches.map(argv), transcript, rig };
}

describe("which launches of the engine carry word times", () => {
  it("gives a processor launch the arguments after everything it had before, and the first word is then on the sound", async () => {
    const src = freshSource();
    const today = await transcribed({ gate: false, flag: false, processor: true }, src);
    const now = await transcribed({ gate: true, flag: true, processor: true }, src);
    expect(today.launches).toHaveLength(1);
    expect(today.launches[0].slice(-9)).toEqual([
      "-l",
      "en",
      "-mc",
      "0",
      "-bs",
      "1",
      "-bo",
      "1",
      "-ng",
    ]);
    expect(now.launches).toEqual([[...today.launches[0], ...TAIL]]);
    expect(now.launches[0].slice(-4)).toEqual(["-ng", "-dtw", "small", "-nfa"]);
    expect(today.transcript.words[0].start_seconds).toBe(STORED);
    expect(now.transcript.words[0].start_seconds).toBe(SOUND);
  });

  it("gives a launch on the graphics chip none of them, and nothing else changes", async () => {
    const src = freshSource();
    const today = await transcribed({ gate: false, flag: false, processor: false }, src);
    const now = await transcribed({ gate: true, flag: true, processor: false }, src);
    expect(now.launches).toEqual(today.launches);
    expect(now.launches[0]).not.toContain("-ng");
    expect(now.launches[0]).not.toContain("-dtw");
    expect(now.launches[0]).not.toContain("-nfa");
    expect(now.transcript.words[0].start_seconds).toBe(STORED);
  });

  it("is 0.27.0 exactly for the flag off with the gate on (the operator's way back), for the gate off with the flag on (the shipped state), and for both off, on either backend", async () => {
    for (const processor of [true, false]) {
      const src = freshSource();
      const today = await transcribed({ gate: false, flag: false, processor }, src);
      for (const [gate, flag] of [
        [true, false],
        [false, true],
      ] as const) {
        const got = await transcribed({ gate, flag, processor }, src);
        expect(got.launches, `gate ${gate} flag ${flag} processor ${processor}`).toEqual(
          today.launches,
        );
        expect(got.transcript, `gate ${gate} flag ${flag} processor ${processor}`).toStrictEqual(
          today.transcript,
        );
      }
    }
  });

  it("gives a model other than the one measured none of them, on the processor with both on", async () => {
    const models = WHISPER_MODELS as Record<string, unknown>;
    models.tiny = WHISPER_MODELS.small;
    try {
      const got = await transcribed(
        { gate: true, flag: true, processor: true },
        freshSource(),
        "tiny",
      );
      expect(got.launches).toHaveLength(1);
      expect(got.launches[0]).toContain(whisperModelPath(DIR, "tiny"));
      expect(got.launches[0]).toContain("-ng");
      expect(got.launches[0]).not.toContain("-dtw");
      expect(got.launches[0]).not.toContain("-nfa");
    } finally {
      delete models.tiny;
    }
  });

  it("gives the retry after the chip crashed, which is a processor launch, the arguments; the launch that crashed had none", async () => {
    configure(true, true);
    const rig = engineRig({
      engine: async (launch) => (launch === 0 ? { code: CRASH, stderr: GPU_LOG } : { code: 0 }),
    });
    const transcript = await runWhisper(rig.ctx(), freshSource(), "small", "en");
    expect(rig.launches).toHaveLength(2);
    expect(rig.launches[0]).not.toContain("-ng");
    expect(rig.launches[0]).not.toContain("-dtw");
    expect(rig.launches[1].slice(-4)).toEqual(["-ng", "-dtw", "small", "-nfa"]);
    expect(cpuOnlyNow(), "the chip is held off after a retry that worked").toBe(true);
    expect(transcript.words[0].start_seconds).toBe(SOUND);
  });

  it("gives that retry nothing when the behaviour is off: the same two launches as 0.27.0", async () => {
    const run = async (gate: boolean, flag: boolean) => {
      localStorage.clear();
      configure(gate, flag);
      const rig = engineRig({
        engine: async (launch) => (launch === 0 ? { code: CRASH, stderr: GPU_LOG } : { code: 0 }),
      });
      const transcript = await runWhisper(rig.ctx(), "/media/retry-off.mp4", "small", "en");
      return { launches: rig.launches.map(argv), transcript };
    };
    const today = await run(false, false);
    expect(today.launches[1].slice(-1)).toEqual(["-ng"]);
    expect(await run(true, false)).toStrictEqual(today);
    expect(await run(false, true)).toStrictEqual(today);
  });

  it("reads the kept transcript on the sound when it is on and as 0.27.0 did when it is off: the way back needs no new run", async () => {
    const src = freshSource();
    hold();
    configure(true, true);
    const rig = engineRig();
    await runWhisper(rig.ctx(), src, "small", "en");
    const ctx = rig.ctx();
    expect((await peekTranscript(ctx, src, "small", "en"))!.words[0].start_seconds).toBe(SOUND);
    __setExportFlag("speech_word_times", false);
    expect((await peekTranscript(ctx, src, "small", "en"))!.words[0].start_seconds).toBe(STORED);
    __setExportFlag("speech_word_times", true);
    __setWordTimesShipped(false);
    expect((await peekTranscript(ctx, src, "small", "en"))!.words[0].start_seconds).toBe(STORED);
    __setWordTimesShipped(true);
    expect((await peekTranscript(ctx, src, "small", "en"))!.words[0].start_seconds).toBe(SOUND);
  });

  it("does not repair a transcript kept before: one made without dtw is read as it was, with the behaviour on", async () => {
    const src = freshSource();
    configure(false, false);
    const rig = engineRig();
    await runWhisper(rig.ctx(), src, "small", "en");
    configure(true, true);
    expect((await peekTranscript(rig.ctx(), src, "small", "en"))!.words[0].start_seconds).toBe(
      STORED,
    );
  });
});

describe("a window is transcribed from its own audio, so its dtw times are on its own clock", () => {
  it.each([
    [100, 10],
    [12.345, 10],
    [31.7, 5],
    [0.5, 30],
  ])(
    "a window starting at %s s: the first word is on the sound there, the window's start plus the clip's own %s s",
    async (start) => {
      hold();
      configure(true, true);
      const rig = engineRig();
      const t = await runWhisper(rig.ctx(), freshSource(), "small", "en", {
        start,
        end: start + 10,
      });
      expect(t.words[0].start_seconds).toBeCloseTo(start + SOUND, 9);
      expect(t.segments[0].start_seconds).toBeCloseTo(start + SOUND, 9);
      // The words after it keep their distances from it: the whole transcript moved, not one word.
      const whole = (await transcribed({ gate: true, flag: true, processor: true }, freshSource()))
        .transcript;
      t.words.forEach((w, i) => {
        expect(w.start_seconds - t.words[0].start_seconds).toBeCloseTo(
          whole.words[i].start_seconds - whole.words[0].start_seconds,
          9,
        );
      });
    },
  );

  it("keeps the kept window on the file's clock for both readings: stored times shifted, dtw times shifted with them", async () => {
    hold();
    configure(true, true);
    const rig = engineRig();
    const src = freshSource();
    const window = { start: 100, end: 110 };
    await runWhisper(rig.ctx(), src, "small", "en", window);
    expect(
      (await peekTranscript(rig.ctx(), src, "small", "en", window))!.words[0].start_seconds,
    ).toBeCloseTo(100 + SOUND, 9);
    __setExportFlag("speech_word_times", false);
    expect(
      (await peekTranscript(rig.ctx(), src, "small", "en", window))!.words[0].start_seconds,
    ).toBeCloseTo(100 + STORED, 9);
  });
});

describe("one run over several files", () => {
  it("is one launch on the processor, with the arguments once, and every file's first word is on the sound", async () => {
    hold();
    configure(true, true);
    const rig = engineRig();
    const [a, b] = [freshSource(), freshSource()];
    const outcomes = await ensureTranscripts(rig.ctx(), [a, b], "small", "en");
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    expect(rig.launches).toHaveLength(1);
    expect(rig.launches[0].slice(-4)).toEqual(["-ng", "-dtw", "small", "-nfa"]);
    expect(rig.launches[0].filter((x) => x === "-dtw")).toHaveLength(1);
    for (const src of [a, b])
      expect((await peekTranscript(rig.ctx(), src, "small", "en"))!.words[0].start_seconds).toBe(
        SOUND,
      );
  });

  it("is 0.27.0 on the chip, and with the behaviour off on the processor", async () => {
    const run = async (gate: boolean, flag: boolean, processor: boolean) => {
      localStorage.clear();
      if (processor) hold();
      configure(gate, flag);
      const rig = engineRig();
      const [a, b] = [freshSource(), freshSource()];
      await ensureTranscripts(rig.ctx(), [a, b], "small", "en");
      expect(rig.launches).toHaveLength(1);
      return {
        args: rig.launches[0],
        first: (await peekTranscript(rig.ctx(), a, "small", "en"))!.words[0].start_seconds,
      };
    };
    const chip = await run(true, true, false);
    expect(chip.args).not.toContain("-ng");
    expect(chip.args).not.toContain("-dtw");
    expect(chip.first).toBe(STORED);
    const off = await run(true, false, true);
    expect(off.args.slice(-1)).toEqual(["-ng"]);
    expect(off.args).not.toContain("-dtw");
    expect(off.first).toBe(STORED);
  });
});

describe("what a launch records on its job", () => {
  async function jobOf(processor: boolean, flag = true) {
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    if (processor) hold();
    configure(true, flag);
    const rig = engineRig();
    jobs.onStart = (spec) =>
      void setTimeout(() => {
        const out = `${spec.args[spec.args.indexOf("-of") + 1]}.json`;
        rig.files.add(out);
        rig.texts.set(out, spec.args.includes("-dtw") ? CLIP : CLIP_NO_DTW);
        jobs.exit(spec.id, 0, "");
      }, 0);
    const transcript = await runWhisper(rig.ctx(), freshSource(), "small", "en");
    return { spec: jobs.submitted[0], transcript };
  }

  it("carries nothing and records nothing for a launch on the graphics chip, with both switches on", async () => {
    const { spec, transcript } = await jobOf(false);
    expect(spec.args).not.toContain("-ng");
    expect(spec.args).not.toContain("-dtw");
    expect(spec.args).not.toContain("-nfa");
    expect(spec.meta).not.toHaveProperty("wordTimes");
    expect(transcript.words[0].start_seconds).toBe(STORED);
  });

  it("records it on the job of a launch on the processor, and only then", async () => {
    const on = await jobOf(true);
    expect(on.spec.args.slice(-4)).toEqual(["-ng", "-dtw", "small", "-nfa"]);
    expect(on.spec.meta).toMatchObject({ wordTimes: true });
    expect(on.transcript.words[0].start_seconds).toBe(SOUND);
    const off = await jobOf(true, false);
    expect(off.spec.args.slice(-1)).toEqual(["-ng"]);
    expect(off.spec.meta).not.toHaveProperty("wordTimes");
    expect(off.transcript.words[0].start_seconds).toBe(STORED);
  });
});

describe("a run a crashed page left in the app process is read the way it was made", () => {
  /** The first page launches a run on the processor (the chip is held off) and dies; the next page adopts it. */
  async function adopted(
    launchWith: { gate: boolean; flag: boolean },
    finishWith: { gate: boolean; flag: boolean },
    engineWrites = CLIP,
  ) {
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    hold();
    configure(launchWith.gate, launchWith.flag);
    const rig = engineRig();
    const src = freshSource();
    void runWhisper(rig.ctx(), src, "small", "en").catch(() => undefined);
    for (let i = 0; i < 500 && jobs.started.length === 0; i++)
      await new Promise((r) => setTimeout(r, 2));
    expect(jobs.started).toHaveLength(1);
    const [spec] = jobs.submitted.filter((s) => s.program === "whisper-cli");
    jobs.pageDied();
    vi.resetModules();
    const [transcribe, supervisor, wordTimes, flags] = await Promise.all([
      import("./transcribe"),
      import("./jobSupervisor"),
      import("./speechWordTimes"),
      import("../api/exportFlags"),
    ]);
    supervisor.__setJobSupervisor(jobs);
    wordTimes.__setWordTimesShipped(finishWith.gate);
    flags.__setExportFlag("speech_word_times", finishWith.flag);
    const io = {
      exists: (p: string) => rig.store.exists(p),
      readText: (p: string) => rig.store.readText(p),
      remove: (p: string) => rig.store.remove(p),
      appCache: () => rig.store.appCache(),
    };
    expect(await transcribe.adoptTranscriptions(io as never)).toBe(1);
    const joined = transcribe.runWhisper(rig.ctx(), src, "small", "en");
    // The request joins the adopted run before the run's words exist, so what it is given is the finish's own reading.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
    const out = `${spec.args[spec.args.indexOf("-of") + 1]}.json`;
    rig.files.add(out);
    rig.texts.set(out, engineWrites);
    jobs.exit(spec.id, 0, "");
    return { spec, transcript: await joined };
  }

  it("records on the job that it was launched with the arguments, and parses its words on the sound when it is finished by the next page", async () => {
    const { spec, transcript } = await adopted(
      { gate: true, flag: true },
      { gate: true, flag: true },
    );
    expect(spec.args.slice(-4)).toEqual(["-ng", "-dtw", "small", "-nfa"]);
    expect(spec.meta).toMatchObject({ kind: "transcript", wordTimes: true });
    expect(transcript.words[0].start_seconds).toBe(SOUND);
  });

  it("records nothing when it was launched without them: the job's meta is what 0.27.0 wrote", async () => {
    const { spec, transcript } = await adopted(
      { gate: true, flag: false },
      { gate: true, flag: true },
      CLIP_NO_DTW,
    );
    expect(spec.args.slice(-1)).toEqual(["-ng"]);
    expect(spec.meta).not.toHaveProperty("wordTimes");
    expect(transcript.words[0].start_seconds).toBe(STORED);
  });

  it("reads a run that was not launched with them as stored even if its output holds a dtw time, whatever the next page's switch says", async () => {
    const { transcript } = await adopted(
      { gate: true, flag: false },
      { gate: true, flag: true },
      CLIP,
    );
    expect(transcript.words[0].start_seconds).toBe(STORED);
  });

  it("reads the run as 0.27.0 when the switch was turned off before the next page finished it: off is off for a run in flight too", async () => {
    const { transcript } = await adopted({ gate: true, flag: true }, { gate: true, flag: false });
    expect(transcript.words[0].start_seconds).toBe(STORED);
  });
});
