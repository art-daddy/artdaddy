// The glue between one run of the engine and what observes it (S2-04, S2-09, S2-02): what the chip's store
// is told and when, how the live check stops a run that is too slow (and the many cases where it must NOT),
// that the measured start-up reaches the pace this PC keeps, and that an observer that fails changes nothing
// about a transcription. The first half drives the watcher directly with a clock of its own; the second half
// drives the real engine through a fake app process.
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
import { __resetSpeechJobs, cancelSpeechJob, useSpeechJobs } from "../store/speechJobs";
import { FakeJobs } from "../test/fakeJobs";
import { freshSource, speechRig } from "../test/speechRig";
import { __resetJobSupervisor, __setJobSupervisor, type JobSpec } from "./jobSupervisor";
import { __resetSpeechSession } from "./speechAdmission";
import { cpuOnlyNow, holdCpuOnly } from "./speechBackend";
import { readPace, recordSpeechRun } from "./speechPace";
import { __resetPlanLog, recentPlans } from "./speechPlanLog";
import { watchSpeechRun, type WatchInput } from "./speechRun";
import { getTranscriptTool, runWhisper, transcribeSpan } from "./transcribe";
import { __resetWaiting } from "./transcriptWait";
import { __resetWorkGate, setExportsBusy } from "./workGate";

const stamp = (s: number): string => {
  const total = Math.round(s * 1000);
  const whole = Math.floor(total / 1000);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}.${pad(total % 1000, 3)}`;
};
/** A decoded stretch of `to - from` seconds, as whisper-cli prints it on stdout. */
const stretch = (from: number, to: number): string =>
  `[${stamp(from)} --> ${stamp(to)}]  some words\n`;

const GPU_LOG = "whisper_backend_init_gpu: using Vulkan0 backend\n";
const NO_GPU_LOG = "whisper_backend_init_gpu: no GPU found\n";
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

const listed = () => useSpeechJobs.getState().jobs;
const the = () => listed()[0];

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetPlanLog();
  __resetSpeechSession();
  __resetSpeechJobs();
  __resetWorkGate();
  __resetWaiting();
  reportAppError.mockClear();
  reportTranscription.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetJobSupervisor();
});

describe("the watcher of one run", () => {
  let clock = T0;
  const stop = vi.fn();
  const watch = (over: Partial<WatchInput> = {}) => {
    clock = T0;
    stop.mockClear();
    return watchSpeechRun({
      id: "whisper-w1",
      purpose: "index",
      label: "talk.mp4",
      spanS: 3600,
      threads: 6,
      liveStop: true,
      several: false,
      cpuOnly: true,
      afterCrash: false,
      stop,
      now: () => clock,
      ...over,
    });
  };
  const at = (seconds: number): void => {
    clock = T0 + seconds * 1000;
  };
  /** The processor's pace of 1 s of work per second of audio: 25 s to the first 30 s, then 30 s per 30 s. */
  const slowRun = (w: ReturnType<typeof watch>): void => {
    at(25);
    w.onStdout(stretch(0, 30));
    at(55);
    w.onStdout(stretch(30, 60));
  };

  it("lists the run as starting, with the facts the app holds, and claims no time", () => {
    watch();
    expect(the()).toMatchObject({
      id: "whisper-w1",
      purpose: "index",
      label: "talk.mp4",
      spanS: 3600,
      phase: "starting",
      stop: null,
      startedAt: T0,
      firstWordsAt: null,
      doneS: 0,
      rate: null,
      etaS: null,
      facts: { backend: "cpu", gpuHeld: false, noGpu: false, threads: 6, exportsBusy: false },
    });
    const cores = Number(globalThis.navigator?.hardwareConcurrency);
    expect(the().facts.cores).toBe(Number.isFinite(cores) && cores > 0 ? cores : null);
  });

  it("names what it knows about the chip and nothing it does not: the hold, a retry after a crash, an unknown backend", () => {
    watch({ cpuOnly: false });
    expect(the().facts).toMatchObject({ backend: null, gpuHeld: false, noGpu: false });
    __resetSpeechJobs();
    holdCpuOnly(-1073740791, Date.now());
    watch({ cpuOnly: true });
    expect(the().facts).toMatchObject({ backend: "cpu", gpuHeld: true });
    __resetSpeechJobs();
    localStorage.clear();
    watch({ cpuOnly: true, afterCrash: true });
    expect(the().facts).toMatchObject({ backend: "cpu", gpuHeld: true });
    __resetSpeechJobs();
    // Allowed the chip, no hold, and this PC's last run was on its processor: the app knows it has no usable chip.
    recordSpeechRun(120, 50, "cpu");
    watch({ cpuOnly: false });
    expect(the().facts).toMatchObject({ backend: null, gpuHeld: false, noGpu: true });
  });

  it("tells the list what the monitor learns as the output arrives, and a time only once it is measured", () => {
    const w = watch();
    at(25);
    w.onStdout(stretch(0, 30));
    expect(the()).toMatchObject({
      phase: "running",
      firstWordsAt: T0 + 25_000,
      doneS: 30,
      rate: null,
      etaS: null,
    });
    at(55);
    w.onStdout(stretch(30, 60));
    expect(the().rate).toBeCloseTo(1, 9);
    expect(the().etaS).toBeCloseTo(3540, 6);
    expect(the().doneS).toBe(60);
  });

  it("ends the run in the list however it ends, and is gone for Cancel once it has ended", () => {
    for (const [code, by, phase] of [
      [0, null, null],
      [1, null, null],
      [-1, "person", "cancelled"],
      [-1, "too_slow", "too_slow"],
      [0, "person", null], // Cancel came after the run had finished: it finished
    ] as const) {
      __resetSpeechJobs();
      const w = watch();
      w.finish(code, by);
      if (phase === null) expect(listed()).toEqual([]);
      else expect(the()).toMatchObject({ phase: "stopped", stop: phase, etaS: null });
      expect(cancelSpeechJob("whisper-w1"), `${code}/${by}`).toBe(false);
    }
  });

  it("has its Cancel call stop with the person's reason, for this run", () => {
    watch();
    expect(cancelSpeechJob("whisper-w1")).toBe(true);
    expect(stop).toHaveBeenCalledExactlyOnceWith("person");
  });

  it("follows an export starting and ending while the run goes on, and stops listening when the run ends", () => {
    const w = watch();
    expect(the().facts.exportsBusy).toBe(false);
    setExportsBusy(true);
    expect(the().facts.exportsBusy).toBe(true);
    setExportsBusy(false);
    expect(the().facts.exportsBusy).toBe(false);
    w.finish(-1, "person");
    setExportsBusy(true);
    expect(the().facts.exportsBusy, "a stopped run is not told about later exports").toBe(false);
    setExportsBusy(false);
  });

  it("reads no position from a run over several files: their clocks restart at 0", () => {
    const w = watch({ several: true });
    slowRun(w);
    expect(the()).toMatchObject({ phase: "starting", doneS: 0, rate: null, etaS: null });
    expect(w.finish(0, null).startupS).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it("hands back the start-up it measured, corrected for the work behind the first words, and none before a speed is known", () => {
    const w = watch();
    at(25);
    w.onStdout(stretch(0, 30));
    expect(w.finish(0, null).startupS).toBeNull();
    const again = watch();
    slowRun(again);
    // 25 s to the first words, of which the first 30 s of audio took 30 s at this pace: no start-up is left.
    expect(again.finish(0, null).startupS).toBeNull();
    const fast = watch();
    at(25);
    fast.onStdout(stretch(0, 30));
    at(35);
    fast.onStdout(stretch(30, 60));
    expect(fast.finish(0, null).startupS).toBeCloseTo(15, 6);
  });

  it("reads the backend from the head of the engine's log once audio has moved, never before and never more than twice", async () => {
    const readLog = vi.fn(async () => GPU_LOG);
    const w = watch({ cpuOnly: false, readLog });
    expect(readLog).not.toHaveBeenCalled();
    at(25);
    w.onStdout(stretch(0, 30));
    await vi.waitFor(() => expect(the().facts.backend).toBe("gpu"));
    expect(the().facts.noGpu).toBe(false);
    expect(readLog).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      at(30 + i * 10);
      w.onStdout(stretch(30 + i * 30, 60 + i * 30));
    }
    expect(readLog, "known now: not asked again").toHaveBeenCalledTimes(1);
  });

  it("says the PC has no usable chip when the engine's log says so, and asks twice at most when the log is not there yet", async () => {
    const readLog = vi.fn(async () => "");
    const w = watch({ cpuOnly: false, readLog });
    slowRun(w);
    await Promise.resolve();
    for (let i = 0; i < 4; i++) {
      at(60 + i * 30);
      w.onStdout(stretch(60 + i * 30, 90 + i * 30));
    }
    expect(readLog.mock.calls.length).toBeLessThanOrEqual(2);
    expect(the().facts.backend).toBeNull();
    const late = vi.fn(async () => NO_GPU_LOG);
    __resetSpeechJobs();
    const w2 = watch({ cpuOnly: false, readLog: late });
    at(25);
    w2.onStdout(stretch(0, 30));
    await vi.waitFor(() => expect(the().facts).toMatchObject({ backend: "cpu", noGpu: true }));
  });

  it("is not troubled by a log that cannot be read", async () => {
    const readLog = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const w = watch({ cpuOnly: false, readLog });
    at(25);
    w.onStdout(stretch(0, 30));
    await new Promise((r) => setTimeout(r, 5));
    expect(the()).toMatchObject({ phase: "running", doneS: 30 });
  });

  describe("stops a run that is too slow (S2-02)", () => {
    it("once its time so far plus its time left, at the speed measured, passes twice the cap, and not before", () => {
      const w = watch({ spanS: 3600 });
      at(25);
      w.onStdout(stretch(0, 30));
      expect(stop, "no speed yet: nothing is claimed, nothing is stopped").not.toHaveBeenCalled();
      at(55);
      w.onStdout(stretch(30, 60));
      expect(stop).toHaveBeenCalledExactlyOnceWith("too_slow");
      const end = w.finish(-1, "too_slow");
      expect(end.liveProjectedS).toBeCloseTo(55 + 3540, 6);
      expect(recentPlans()).toMatchObject([
        { plan: "ondemand", why: "cap", where: "live", backend: "cpu", file: "talk.mp4" },
      ]);
    });

    it("exactly at twice the cap: a run that will take 1,199 s goes on, one that will take 1,201 s is stopped", () => {
      // 55 s so far, then (span - 60) s at 1 s per audio second: the total is span - 5.
      const goes = watch({ spanS: 1204 });
      slowRun(goes);
      expect(stop).not.toHaveBeenCalled();
      const stopped = watch({ spanS: 1206 });
      slowRun(stopped);
      expect(stop).toHaveBeenCalledExactlyOnceWith("too_slow");
    });

    it("never with the switch off: 0.27.0 lets it run", () => {
      __setExportFlag("speech_cpu_cap", false);
      slowRun(watch());
      expect(stop).not.toHaveBeenCalled();
      expect(recentPlans()).toEqual([]);
    });

    it("never for a run that is not the background's whole file: a request's own run goes on until it is done or Cancelled (S2-13)", () => {
      slowRun(watch({ liveStop: false, purpose: "captions" }));
      expect(stop).not.toHaveBeenCalled();
    });

    it("never for a run on the graphics chip: the engine says it is using one", async () => {
      const readLog = vi.fn(async () => GPU_LOG);
      const w = watch({ cpuOnly: false, readLog });
      at(25);
      w.onStdout(stretch(0, 30));
      await vi.waitFor(() => expect(the().facts.backend).toBe("gpu"));
      at(55);
      w.onStdout(stretch(30, 60));
      expect(stop).not.toHaveBeenCalled();
    });

    it("never when it cannot tell which backend runs it: no log, no history", () => {
      slowRun(watch({ cpuOnly: false }));
      expect(stop).not.toHaveBeenCalled();
    });

    it("on a PC whose last run was on its processor, with the chip allowed and no log to read, it is the processor", () => {
      recordSpeechRun(120, 50, "cpu");
      slowRun(watch({ cpuOnly: false }));
      expect(stop).toHaveBeenCalledExactlyOnceWith("too_slow");
    });

    it("once, however many more chunks arrive while the process is being stopped", () => {
      const w = watch();
      slowRun(w);
      at(60);
      w.onStdout(stretch(60, 90));
      at(70);
      w.onStdout(stretch(90, 120));
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("an observer that fails changes nothing", () => {
    it("the store throwing on every call, the stop throwing, and garbage on stdout: the watcher still answers", () => {
      const state = useSpeechJobs.getState();
      vi.spyOn(state, "add").mockImplementation(() => {
        throw new Error("store down");
      });
      vi.spyOn(state, "patch").mockImplementation(() => {
        throw new Error("store down");
      });
      vi.spyOn(state, "end").mockImplementation(() => {
        throw new Error("store down");
      });
      stop.mockImplementation(() => {
        throw new Error("cannot stop");
      });
      const w = watch();
      expect(() => {
        w.onStdout("\u0000\uffff[[[ not a segment");
        slowRun(w);
        w.finish(-1, "too_slow");
      }).not.toThrow();
      stop.mockReset();
    });
  });
});

describe("a run of the real engine", () => {
  let jobs: FakeJobs;
  beforeEach(() => {
    jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  });
  const whisperJobs = (): JobSpec[] => jobs.submitted.filter((s) => s.program === "whisper-cli");
  async function until(pred: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !pred(); i++) await new Promise((r) => setTimeout(r, 2));
    expect(pred()).toBe(true);
  }
  const at = (seconds: number): void => void vi.setSystemTime(T0 + seconds * 1000);
  const flagArg = (spec: JobSpec, flag: string): string => spec.args[spec.args.indexOf(flag) + 1];
  const exits = (rig: ReturnType<typeof speechRig>, spec: JobSpec, stderr: string): void => {
    const json = `${flagArg(spec, "-of")}.json`;
    rig.files.add(json);
    rig.texts.set(
      json,
      '{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":900},"text":" hi","tokens":[{"text":" hi","offsets":{"from":0,"to":900},"p":0.9}]}]}',
    );
    jobs.exit(spec.id, 0, stderr);
  };

  it("titles each run by what it is for, names the file, reads its length from the audio it was given, and says how many threads it has", async () => {
    const rig = speechRig({ audioSeconds: 90 });
    const index = runWhisper(
      rig.ctx({ background: true }),
      `/media/${freshSource().split("/").pop()}`,
    );
    await until(() => whisperJobs().length === 1);
    expect(the()).toMatchObject({ purpose: "index", spanS: 90, phase: "starting" });
    expect(the().label).toMatch(/^rig-\d+\.mp4$/);
    expect(the().facts.threads).toBe(Number(flagArg(whisperJobs()[0], "-t")));
    exits(rig, whisperJobs()[0], "");
    await index;
    expect(listed()).toEqual([]);

    const look = runWhisper(rig.ctx(), freshSource());
    await until(() => whisperJobs().length === 2);
    expect(the().purpose).toBe("look");
    exits(rig, whisperJobs()[1], "");
    await look;

    const span = transcribeSpan({ ...rig.ctx(), speechPurpose: "captions" }, freshSource(), {
      start: 10,
      end: 40,
    });
    await until(() => whisperJobs().length === 3);
    expect(the()).toMatchObject({ purpose: "captions" });
    exits(rig, whisperJobs()[2], "");
    await span;

    const timeline = JSON.stringify({
      canvas: { width: 1080, height: 1920, fps: 30 },
      tracks: [
        {
          id: "a1",
          kind: "audio",
          clips: [
            {
              id: "c1",
              media_ref: freshSource(),
              source_in: 0,
              source_out: 300,
              timeline_in: 0,
              timeline_out: 300,
            },
          ],
        },
      ],
    });
    rig.texts.set("C:/data/projects/p1/internals/timeline.json", timeline);
    rig.files.add("C:/data/projects/p1/internals/timeline.json");
    const transcript = getTranscriptTool({}, rig.ctx()) as Promise<unknown>;
    await until(() => whisperJobs().length === 4);
    expect(the().purpose).toBe("transcript");
    exits(rig, whisperJobs()[3], "");
    await transcript;
  });

  it("keeps the start-up it measured with the pace sample of the run, in the sample's own format", async () => {
    const rig = speechRig({ audioSeconds: 120 });
    holdCpuOnly(-1073740791, Date.now()); // the processor, so the run is `-ng` and the engine's log says so
    const run = runWhisper(rig.ctx({ background: true }), freshSource());
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    expect(spec.args).toContain("-ng");
    at(25);
    jobs.stdout(spec.id, stretch(0, 30));
    at(35);
    jobs.stdout(spec.id, stretch(30, 60));
    at(60);
    exits(
      rig,
      spec,
      "whisper_backend_init_gpu: no GPU found\n" +
        "main: processing 'x.wav' (1920000 samples, 120.0 sec), 8 threads, 1 processors, 5 beams\n" +
        "whisper_print_timings:    total time = 50000.00 ms\n",
    );
    await run;
    const samples = readPace();
    expect(samples).toHaveLength(1);
    expect(samples[0].slice(0, 3)).toEqual([120, 50, "cpu"]);
    expect(samples[0][3]).toBeCloseTo(15, 6);
    // The format the existing readers know: three numbers and a backend, or those and a start-up.
    expect(JSON.parse(localStorage.getItem("artdaddy.speech_pace.v2")!)).toEqual([
      [120, 50, "cpu", samples[0][3]],
    ]);
  });

  it("records no start-up when the run was too short to measure a speed: the sample is the plain one", async () => {
    const rig = speechRig({ audioSeconds: 20 });
    const run = runWhisper(rig.ctx({ background: true }), freshSource());
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    at(8);
    jobs.stdout(spec.id, stretch(0, 20));
    at(12);
    exits(
      rig,
      spec,
      "whisper_backend_init_gpu: using Vulkan0 backend\n" +
        "main: processing 'x.wav' (320000 samples, 20.0 sec), 8 threads, 1 processors, 5 beams\n" +
        "whisper_print_timings:    total time = 11000.00 ms\n",
    );
    await run;
    expect(readPace()).toEqual([[20, 11, "gpu"]]);
  });

  it("stops a whole file the background started, on the processor, once its measured pace makes it too slow: the answer is the deferral", async () => {
    const rig = speechRig({ audioSeconds: 7200 });
    holdCpuOnly(-1073740791, Date.now());
    const run = runWhisper(rig.ctx({ background: true }), freshSource()).catch((e: unknown) => e);
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    at(25);
    jobs.stdout(spec.id, stretch(0, 30));
    expect(jobs.killed, "not before the speed is measured").toEqual([]);
    at(55);
    jobs.stdout(spec.id, stretch(30, 60));
    const error = (await run) as { code?: string; stopped?: boolean; message?: string };
    expect(jobs.killed).toEqual([spec.id]);
    expect(error).toMatchObject({ code: "speech_deferred", stopped: true });
    expect(error.message).toMatch(/was stopped/);
    expect(whisperJobs(), "stopped, not retried").toHaveLength(1);
    expect(listed().map((j) => [j.phase, j.stop])).toEqual([["stopped", "too_slow"]]);
    expect(recentPlans().map((r) => [r.where, r.plan, r.why])).toEqual([
      ["boundary", "whole", "gpu_held"],
      ["live", "ondemand", "cap"],
    ]);
    expect(reportAppError, "a deferral is nobody's failure").not.toHaveBeenCalled();
    expect(cpuOnlyNow(), "and says nothing about the chip").toBe(true);
    expect(readPace(), "a stopped run is not a speed").toEqual([]);
  });

  it("goes on with the same slow run when a request made it, when it is a stretch, and with the switch off", async () => {
    for (const variant of ["foreground", "window", "switch off"]) {
      __resetSpeechJobs();
      __resetExportFlags();
      jobs = new FakeJobs();
      __setJobSupervisor(jobs);
      holdCpuOnly(-1073740791, Date.now());
      if (variant === "switch off") __setExportFlag("speech_cpu_cap", false);
      const rig = speechRig({ audioSeconds: 7200 });
      const ctx = variant === "foreground" ? rig.ctx() : rig.ctx({ background: true });
      const run =
        variant === "window"
          ? runWhisper(ctx, freshSource(), "small", undefined, { start: 0, end: 7200 })
          : runWhisper(ctx, freshSource());
      await until(() => jobs.submitted.some((s) => s.program === "whisper-cli"));
      const spec = jobs.submitted.find((s) => s.program === "whisper-cli")!;
      at(25);
      jobs.stdout(spec.id, stretch(0, 30));
      at(55);
      jobs.stdout(spec.id, stretch(30, 60));
      at(85);
      jobs.stdout(spec.id, stretch(60, 90));
      expect(jobs.killed, variant).toEqual([]);
      expect(the().rate, `${variant}: the speed is still measured and shown`).toBeCloseTo(1, 6);
      exits(rig, spec, "");
      await run;
    }
  });

  it("does not let a store that fails fail the transcription", async () => {
    const state = useSpeechJobs.getState();
    for (const name of ["add", "patch", "end"] as const)
      vi.spyOn(state, name).mockImplementation(() => {
        throw new Error("store down");
      });
    const rig = speechRig({ audioSeconds: 60 });
    const run = runWhisper(rig.ctx({ background: true }), freshSource());
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    at(10);
    jobs.stdout(spec.id, stretch(0, 30));
    exits(rig, spec, "");
    expect((await run).words.map((w) => w.word)).toEqual(["hi"]);
  });
});
