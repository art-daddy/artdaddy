// The whole path of a whole-file run on a PC slower than its pace says (S2-02), through the REAL indexer, the
// REAL transcription path and the real chip store, with only the app process faked: the file is admitted (its
// projected time on the pace this PC has is inside the cap), runs, and the live check stops it once its own
// measured speed says it will take more than twice the cap. What is checked is the EFFECT each step is for:
// the process was killed, nothing is counted against the file or the engine, the file is not started again by
// the indexer this session, and the pace the stopped run showed makes the next such file wait at admission.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportAppError, reportTranscription, sourceDurationSeconds } = vi.hoisted(() => ({
  reportAppError: vi.fn(),
  reportTranscription: vi.fn(),
  sourceDurationSeconds: vi.fn(async (..._a: unknown[]) => 0),
}));
vi.mock("../api/appEvents", async (orig) => ({
  ...(await orig<object>()),
  reportAppError,
  reportTranscription,
}));
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "C:/res/fonts" }));
vi.mock("../preview/mediaProxy", () => ({ processImportedMedia: async () => false }));
vi.mock("../preview/resolve", () => ({ clearSourceUrlCache: () => undefined }));
vi.mock("../tools/loudness", () => ({ measureLoudness: async () => ({}) }));
vi.mock("../timeline/placement", () => ({
  sourceHasAudio: async () => true,
  sourceDurationSeconds,
}));

import { __resetExportFlags } from "../api/exportFlags";
import { __resetSpeechJobs, useSpeechJobs } from "../store/speechJobs";
import { FakeJobs } from "../test/fakeJobs";
import { speechRig } from "../test/speechRig";
import { __resetJobSupervisor, __setJobSupervisor, type JobSpec } from "../tools/jobSupervisor";
import { __resetSpeechSession } from "../tools/speechAdmission";
import { holdCpuOnly } from "../tools/speechBackend";
import { readPace, recordSpeechRun, SPEECH_PACE_KEY } from "../tools/speechPace";
import { __resetPlanLog, recentPlans } from "../tools/speechPlanLog";
import { __resetWorkGate } from "../tools/workGate";
import { IndexCoordinator } from "./indexCoordinator";

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const stamp = (s: number): string => {
  const whole = Math.floor(s);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}.000`;
};
const stretch = (from: number, to: number): string =>
  `[${stamp(from)} --> ${stamp(to)}]  some words\n`;

let jobs: FakeJobs;
const whisperJobs = (): JobSpec[] => jobs.submitted.filter((s) => s.program === "whisper-cli");
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 1500 && !pred(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(pred()).toBe(true);
}
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 80));
const at = (seconds: number): void => void vi.setSystemTime(T0 + seconds * 1000);

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetPlanLog();
  __resetSpeechSession();
  __resetSpeechJobs();
  __resetWorkGate();
  reportAppError.mockClear();
  reportTranscription.mockClear();
  sourceDurationSeconds.mockReset();
  jobs = new FakeJobs();
  __setJobSupervisor(jobs);
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  __resetJobSupervisor();
});

describe("a long file on a processor slower than the pace this PC measured before", () => {
  it("is admitted, stopped once it is measured to be too slow, never started again by the indexer, and teaches the next admission", async () => {
    // A PC whose chip crashed, so the processor does the work. It once did 600 s of audio in 50 s of work (a
    // quiet moment), so a file of an hour is projected at 20 + 0.05 x 3,600 = 200 s, inside the cap of 600.
    holdCpuOnly(-1073740791, Date.now());
    recordSpeechRun(600, 50, "cpu", undefined, 20);
    const fast = localStorage.getItem(SPEECH_PACE_KEY)!;
    sourceDurationSeconds.mockImplementation(async (_runner: unknown, abs: unknown) =>
      String(abs).startsWith("library/slow") ? 3600 : 0,
    );
    const rig = speechRig({ audioSeconds: 3600 });
    const c = new IndexCoordinator(
      rig.store as never,
      async () => rig.runner as never,
      () => undefined,
      () => undefined,
    );
    c.indexSource("library/slow1.mp4");
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    expect(spec.args, "the processor, because the chip is held").toContain("-ng");
    expect(recentPlans().map((r) => [r.where, r.plan, r.why])).toEqual([
      ["indexer", "whole", "gpu_held"],
      ["boundary", "whole", "gpu_held"],
    ]);

    // The PC is busy now: 2 s of work per second of audio, not 0.05. 20 s to begin, then 60 s for each 30 s
    // of audio. The check reads nothing before 90 s of audio are measured, and wants a second reading.
    for (let k = 0; k < 4; k++) {
      at(80 + 60 * k);
      jobs.stdout(spec.id, stretch(30 * k, 30 * (k + 1)));
    }
    await quiet();
    expect(jobs.killed, "no stop on the first reading").toEqual([]);
    at(320);
    jobs.stdout(spec.id, stretch(120, 150));

    await until(() => jobs.killed.length === 1);
    expect(jobs.killed).toEqual([spec.id]);
    await until(() => useSpeechJobs.getState().jobs.some((j) => j.stop === "too_slow"));
    await quiet();
    expect(reportAppError, "a deferral is nobody's failure").not.toHaveBeenCalled();
    expect(whisperJobs(), "stopped, not retried").toHaveLength(1);
    expect(recentPlans().map((r) => r.where)).toContain("live");

    // What the stopped run showed of this PC is kept beside what it showed before (150 s of audio, 320 s of
    // the run, 20 s to begin).
    expect(readPace()).toEqual([
      [600, 50, "cpu", 20],
      [150, 320, "cpu", expect.closeTo(20, 6)],
    ]);

    // The indexer does not start it again by itself, in the project that is open or in one reopened. The
    // pace the stopped run showed is put aside for this part, so that only what the session remembers can
    // keep the file out (at the pace it had before, it is admitted again).
    const learned = localStorage.getItem(SPEECH_PACE_KEY)!;
    localStorage.setItem(SPEECH_PACE_KEY, fast);
    const reopened = new IndexCoordinator(
      rig.store as never,
      async () => rig.runner as never,
      () => undefined,
      () => undefined,
    );
    reopened.indexSource("library/slow1.mp4");
    c.indexSource("library/slow1.mp4");
    await quiet();
    expect(whisperJobs(), "the file never reached the engine a second time").toHaveLength(1);
    localStorage.setItem(SPEECH_PACE_KEY, learned);

    // ...and the pace it showed makes the next file like it wait at admission, not be started to be stopped.
    c.indexSource("library/slow2.mp4");
    await quiet();
    const slow2 = recentPlans().filter((r) => r.file === "slow2.mp4");
    expect(slow2.map((r) => [r.where, r.plan, r.why])).toEqual([["indexer", "ondemand", "cap"]]);
    expect(whisperJobs(), "only the first file ever reached the engine").toHaveLength(1);
    expect(reportAppError).not.toHaveBeenCalled();
    c.dispose();
    reopened.dispose();
  });

  it("is not stopped by the PC's sleep, in the real indexer and the real engine path, and keeps no pace from it", async () => {
    holdCpuOnly(-1073740791, Date.now());
    recordSpeechRun(600, 50, "cpu", undefined, 20);
    const before = readPace();
    sourceDurationSeconds.mockImplementation(async () => 900);
    const rig = speechRig({ audioSeconds: 900 });
    const c = new IndexCoordinator(
      rig.store as never,
      async () => rig.runner as never,
      () => undefined,
      () => undefined,
    );
    c.indexSource("library/slept.mp4");
    await until(() => whisperJobs().length === 1);
    const [spec] = whisperJobs();
    // a normal run of 1 s of work per second of audio (925 s in all), but the PC slept for 30 minutes after
    // the first 60 s of audio
    at(25);
    jobs.stdout(spec.id, stretch(0, 30));
    at(55);
    jobs.stdout(spec.id, stretch(30, 60));
    at(55 + 1800);
    jobs.stdout(spec.id, stretch(60, 90));
    for (let k = 3; k < 20; k++) {
      at(1855 + 30 * (k - 2));
      jobs.stdout(spec.id, stretch(30 * k, 30 * (k + 1)));
    }
    await quiet();
    expect(jobs.killed, "the run was only asleep").toEqual([]);
    expect(readPace(), "and a sleep is not a pace").toEqual(before);
    expect(recentPlans().map((r) => r.where)).not.toContain("live");
    c.dispose();
  });
});
