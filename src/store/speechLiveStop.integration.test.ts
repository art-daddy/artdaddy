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
import { readPace, SPEECH_PACE_KEY } from "../tools/speechPace";
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

describe("a long file on a processor slower than the pace this PC has been assumed to have", () => {
  it("is admitted, stopped once it is measured to be too slow, never started again by the indexer, and teaches the next admission", async () => {
    // A PC whose chip crashed, so the processor runs at the default pace of 3.7 s of work per second of audio
    // and 20 s to begin: 150 s of audio is projected at 575 s, inside the cap of 600.
    holdCpuOnly(-1073740791, Date.now());
    sourceDurationSeconds.mockImplementation(async (_runner: unknown, abs: unknown) =>
      String(abs).startsWith("library/slow") ? 150 : 0,
    );
    const rig = speechRig({ audioSeconds: 150 });
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

    // This PC is really 9 s of work per second of audio, not 3.7: 290 s to the first 30 s of audio (20 s to
    // begin, then the 30 s window), and 270 s for the next 30.
    at(290);
    jobs.stdout(spec.id, stretch(0, 30));
    expect(jobs.killed, "no speed is measured from one burst").toEqual([]);
    at(560);
    jobs.stdout(spec.id, stretch(30, 60));

    await until(() => jobs.killed.length === 1);
    expect(jobs.killed).toEqual([spec.id]);
    await until(() => useSpeechJobs.getState().jobs.some((j) => j.stop === "too_slow"));
    await quiet();
    expect(reportAppError, "a deferral is nobody's failure").not.toHaveBeenCalled();
    expect(whisperJobs(), "stopped, not retried").toHaveLength(1);
    expect(recentPlans().map((r) => r.where)).toContain("live");

    // What the stopped run showed of this PC is kept (60 s of audio, 560 s since launch, 20 s to begin).
    expect(readPace()).toEqual([[60, 560, "cpu", expect.closeTo(20, 6)]]);

    // The indexer does not start it again by itself, in the project that is open or in one reopened. The pace
    // the stopped run showed is put aside for this part, so that only what the session remembers can keep the
    // file out (at the default pace it would be admitted again).
    const learned = localStorage.getItem(SPEECH_PACE_KEY)!;
    localStorage.removeItem(SPEECH_PACE_KEY);
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
});
