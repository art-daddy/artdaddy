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
      work: [{ source: "C:/media/talk.mp4", language: "", window: null }],
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
  /** The processor's pace of 1 s of work per second of audio: 25 s to the first 30 s, then 30 s per 30 s,
   *  for `windows` windows. The live check reads nothing before 90 s of audio are measured and wants a
   *  second reading after it, so a run that is too slow is stopped at its fifth window. */
  const slowRun = (w: ReturnType<typeof watch>, windows = 8): void => {
    for (let k = 0; k < windows; k++) {
      at(25 + 30 * k);
      w.onStdout(stretch(30 * k, 30 * (k + 1)));
    }
  };

  it("lists the run as starting, with the facts the app holds, and claims no time", () => {
    watch();
    expect(the()).toMatchObject({
      id: "whisper-w1",
      purpose: "index",
      label: "talk.mp4",
      work: [{ source: "C:/media/talk.mp4", language: "", window: null }],
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

  it("keeps no pace for a run the person stopped, or that failed: only a run the live check stopped has shown a speed worth keeping", () => {
    for (const [code, by] of [
      [-1, "person"],
      [1, null],
    ] as const) {
      const w = watch({ liveStop: false });
      slowRun(w);
      w.finish(code, by);
    }
    expect(readPace()).toEqual([]);
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
    it("once its time so far plus its time left, at the speed measured, passes twice the cap on two readings in a row: at its second reading, and not before", () => {
      const w = watch({ spanS: 3600 });
      // 25 s to the first 30 s of audio, then 30 s per 30 s: the speed rests on the audio since the first
      // burst, so the first reading is at 120 s of audio (90 s measured) and the second at 150 s.
      for (let k = 0; k < 4; k++) {
        at(25 + 30 * k);
        w.onStdout(stretch(30 * k, 30 * (k + 1)));
      }
      expect(stop, "one reading over the cap is not enough").not.toHaveBeenCalled();
      at(145);
      w.onStdout(stretch(120, 150));
      expect(stop).toHaveBeenCalledExactlyOnceWith("too_slow");
      const end = w.finish(-1, "too_slow");
      expect(end.liveProjectedS).toBeCloseTo(145 + 3450, 6);
      expect(readPace(), "what the run showed of this PC's pace is kept").toEqual([
        [150, 145, "cpu"],
      ]);
      expect(recentPlans()).toMatchObject([
        { plan: "ondemand", why: "cap", where: "live", backend: "cpu", file: "talk.mp4" },
      ]);
    });

    it("never from the speed of one or two windows: nothing is stopped until 90 s of audio are measured, however slow they were", () => {
      // 100 s of work for each 30 s of audio: 3.3 times real time, over the cap for any long file.
      const w = watch({ spanS: 36_000 });
      for (let k = 0; k < 3; k++) {
        at(100 * (k + 1));
        w.onStdout(stretch(30 * k, 30 * (k + 1)));
      }
      expect(stop).not.toHaveBeenCalled();
      at(400);
      w.onStdout(stretch(90, 120)); // 90 s measured: the first reading
      expect(stop).not.toHaveBeenCalled();
      at(500);
      w.onStdout(stretch(120, 150));
      expect(stop).toHaveBeenCalledExactlyOnceWith("too_slow");
    });

    it("waits for the second reading to be at least 20 s of the run's own time after the first, however many outputs come in between", () => {
      // 30 s of audio every 10 s of work: three times real time, but over the cap for a very long file.
      const w = watch({ spanS: 100_000 });
      const burst = (k: number): void => {
        at(10 + 10 * k);
        w.onStdout(stretch(30 * k, 30 * (k + 1)));
      };
      for (let k = 0; k < 4; k++) burst(k); // the fourth is the first reading: 90 s measured
      burst(4); // 10 s later
      expect(stop, "10 s after the first reading").not.toHaveBeenCalled();
      burst(5); // 20 s later
      expect(stop).toHaveBeenCalledExactlyOnceWith("too_slow");
    });

    it("is not set off by one reading over the cap: the run that gets faster is not stopped", () => {
      // 1 s of work per second of audio, then the next window takes only 10 s: the first reading is over
      // the cap (1,395 s), the second is not (1,166 s), so there are not two in a row.
      const w = watch({ spanS: 1400 });
      slowRun(w, 4);
      at(115 + 10);
      w.onStdout(stretch(120, 150));
      for (let k = 5; k < 46; k++) {
        at(125 + 10 * (k - 4));
        w.onStdout(stretch(30 * k, 30 * (k + 1)));
      }
      expect(stop).not.toHaveBeenCalled();
      expect(readPace()).toEqual([]);
    });

    it("never when less than a minute is left, however long the run has taken: it is almost done", () => {
      // A steady 1 s per second of audio for a 1,200 s file, then the last windows take 100 s each: the run
      // has taken more than twice the cap when it is nearly read, and killing it loses all its work.
      const w = watch({ spanS: 1200 });
      slowRun(w, 37); // audio 1,110 s at 1,105 s: 1,195 s in all, under the cap
      expect(stop).not.toHaveBeenCalled();
      at(1205);
      w.onStdout(stretch(1110, 1140)); // 63.8 s left: the one reading that is over
      expect(stop, "a single reading").not.toHaveBeenCalled();
      at(1305);
      w.onStdout(stretch(1140, 1170)); // 33.7 s left: too little left to stop for
      at(1405);
      w.onStdout(stretch(1170, 1200));
      expect(stop).not.toHaveBeenCalled();
      expect(readPace()).toEqual([]);
    });

    describe("is not set off by time the engine did not spend (F1)", () => {
      it("a sleep: two bursts 30 s of audio apart and 30 minutes apart on the clock give no stop and no sample, however the run goes on", () => {
        const w = watch({ spanS: 900 });
        at(25);
        w.onStdout(stretch(0, 30));
        at(25 + 1800);
        w.onStdout(stretch(30, 60)); // the PC slept for half an hour
        // ...and then the run goes on at the pace it had, 30 s of audio every 30 s: 925 s in all
        for (let k = 2; k < 20; k++) {
          at(25 + 1800 + 30 * (k - 1));
          w.onStdout(stretch(30 * k, 30 * (k + 1)));
        }
        expect(stop).not.toHaveBeenCalled();
        w.finish(0, null);
        expect(readPace()).toEqual([]);
        expect(recentPlans()).toEqual([]);
      });

      it("a sleep before the readings, and again after them: still no stop for a run that fits", () => {
        const w = watch({ spanS: 900 });
        slowRun(w, 5); // 150 s of audio at 145 s
        at(145 + 4000);
        w.onStdout(stretch(150, 180)); // slept
        for (let k = 6; k < 12; k++) {
          at(4145 + 30 * (k - 5));
          w.onStdout(stretch(30 * k, 30 * (k + 1)));
        }
        at(4145 + 3600 * 5);
        w.onStdout(stretch(360, 390)); // slept again
        for (let k = 13; k < 20; k++) {
          at(4145 + 3600 * 5 + 30 * (k - 12));
          w.onStdout(stretch(30 * k, 30 * (k + 1)));
        }
        expect(stop).not.toHaveBeenCalled();
      });

      it("a sleep delays the stop of a run that really is too slow; it never cancels it, and no pace is kept from a run that had a gap", () => {
        const w = watch({ spanS: 3600 });
        slowRun(w, 2);
        at(55 + 1800);
        w.onStdout(stretch(60, 90)); // slept
        // the speed is read again from here: 90 s of audio, then a second reading
        for (let k = 3; k < 6; k++) {
          at(1855 + 30 * (k - 2));
          w.onStdout(stretch(30 * k, 30 * (k + 1)));
        }
        expect(stop, "only the readings after the sleep count").not.toHaveBeenCalled();
        at(1855 + 30 * 4);
        w.onStdout(stretch(180, 210));
        expect(stop).toHaveBeenCalledExactlyOnceWith("too_slow");
        const end = w.finish(-1, "too_slow");
        // 25 s to start, 30 s, the sleep as the 120 s it is counted for, and 4 windows of 30 s; 3,390 s left
        expect(end.liveProjectedS, "the sleep is not in the time the run would take").toBeCloseTo(
          25 + 30 + 120 + 120 + 3390,
          6,
        );
        expect(readPace(), "a run that had a gap in it shows nothing of the PC's pace").toEqual([]);
        expect(recentPlans()).toMatchObject([{ plan: "ondemand", where: "live" }]);
      });
    });

    it("exactly at twice the cap: a run that will take 1,199 s goes on, one that will take 1,201 s is stopped", () => {
      // 25 s to the first window, then 1 s of work per second of audio: the total is span - 5.
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
      for (let k = 1; k < 8; k++) {
        at(25 + 30 * k);
        w.onStdout(stretch(30 * k, 30 * (k + 1)));
      }
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
      expect(stop).toHaveBeenCalledTimes(1);
      at(265);
      w.onStdout(stretch(240, 270));
      at(295);
      w.onStdout(stretch(270, 300));
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
    const indexSrc = `/media/${freshSource().split("/").pop()}`;
    const index = runWhisper(rig.ctx({ background: true }), indexSrc);
    await until(() => whisperJobs().length === 1);
    expect(the()).toMatchObject({ purpose: "index", spanS: 90, phase: "starting" });
    expect(the().label).toMatch(/^rig-\d+\.mp4$/);
    // what the run reads, so that work somebody asked for can be matched to it (local, never sent)
    expect(the().work).toEqual([{ source: indexSrc, language: "", window: null }]);
    expect(the().facts.threads).toBe(Number(flagArg(whisperJobs()[0], "-t")));
    exits(rig, whisperJobs()[0], "");
    await index;
    expect(listed()).toEqual([]);

    const lookSrc = freshSource();
    const look = runWhisper(rig.ctx(), lookSrc, undefined, "es");
    await until(() => whisperJobs().length === 2);
    expect(the().purpose).toBe("look");
    expect(the().work).toEqual([{ source: lookSrc, language: "es", window: null }]);
    exits(rig, whisperJobs()[1], "");
    await look;

    const spanSrc = freshSource();
    const span = transcribeSpan({ ...rig.ctx(), speechPurpose: "captions" }, spanSrc, {
      start: 10,
      end: 40,
    });
    await until(() => whisperJobs().length === 3);
    expect(the()).toMatchObject({ purpose: "captions" });
    expect(the().work).toEqual([{ source: spanSrc, language: "", window: { start: 10, end: 40 } }]);
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
    for (let k = 0; k < 4; k++) {
      at(25 + 30 * k);
      jobs.stdout(spec.id, stretch(30 * k, 30 * (k + 1)));
    }
    expect(jobs.killed, "not on one reading").toEqual([]);
    at(145);
    jobs.stdout(spec.id, stretch(120, 150));
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
    // A stopped run reports no timings of its own, so what it showed of the pace is kept: 150 s of audio in
    // the 145 s since launch. The next file is judged by it, and not started only to be stopped again.
    expect(readPace()).toEqual([[150, 145, "cpu"]]);
  });

  it("is not killed by a sleep of the PC, and keeps no pace from the run: 30 s of audio, then half an hour", async () => {
    const rig = speechRig({ audioSeconds: 900 });
    holdCpuOnly(-1073740791, Date.now());
    const run = runWhisper(rig.ctx({ background: true }), freshSource());
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    at(25);
    jobs.stdout(spec.id, stretch(0, 30));
    at(25 + 1800);
    jobs.stdout(spec.id, stretch(30, 60));
    for (let k = 2; k < 20; k++) {
      at(1825 + 30 * (k - 1));
      jobs.stdout(spec.id, stretch(30 * k, 30 * (k + 1)));
    }
    expect(jobs.killed, "the run is a normal one that slept").toEqual([]);
    expect(readPace(), "and a sleep is not a pace").toEqual([]);
    expect(recentPlans().map((r) => r.where)).not.toContain("live");
    exits(rig, spec, "");
    await run;
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
      for (let k = 0; k < 8; k++) {
        at(25 + 30 * k);
        jobs.stdout(spec.id, stretch(30 * k, 30 * (k + 1)));
      }
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
