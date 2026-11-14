// The boundary every whole-file speech start passes (S2-02), through the REAL transcription path with a
// fake engine: a file this PC would take longer than the cap for is left alone BEFORE any audio is read
// or any engine is started; a request is never planned away; and with the switch off nothing is decided.
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

import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { __resetSpeechJobs, useSpeechJobs, type SpeechJob } from "../store/speechJobs";
import { FakeJobs } from "../test/fakeJobs";
import { freshSource, flagValues, speechRig } from "../test/speechRig";
import { __resetJobSupervisor, __setJobSupervisor } from "./jobSupervisor";
import {
  __resetSpeechSession,
  isSpeechDeferred,
  noteAudioLength,
  SpeechDeferredError,
} from "./speechAdmission";
import { holdCpuOnly } from "./speechBackend";
import { recordSpeechRun } from "./speechPace";
import { __resetPlanLog, recentPlans } from "./speechPlanLog";
import { ensureTranscripts, peekTranscript, runWhisper } from "./transcribe";
import { __resetWorkGate } from "./workGate";

const HOURS_3 = 3 * 3600;

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetPlanLog();
  __resetSpeechSession();
  __resetWorkGate();
  reportAppError.mockClear();
  reportTranscription.mockClear();
});
afterEach(() => __resetJobSupervisor());

/** A PC whose chip crashed, so the processor runs at the pace of a PC that has measured nothing (3.7 s of
 *  work per second of audio, 20 s to begin). */
const heldProcessor = (): void => holdCpuOnly(-1073740791, Date.now());
/** A PC whose latest runs were on its chip. */
const chipPc = (): void => {
  recordSpeechRun(60, 10, "gpu");
  recordSpeechRun(60, 11, "gpu");
};

describe("a whole file in the background, over the cap on this PC", () => {
  it("is not started: the audio is never read and no engine is launched, and the answer is a typed deferral", async () => {
    heldProcessor();
    const src = freshSource();
    noteAudioLength(src, HOURS_3);
    const jobs = new FakeJobs();
    __setJobSupervisor(jobs);
    const rig = speechRig();
    const error = await runWhisper(rig.ctx({ background: true }), src).catch((e: unknown) => e);
    expect(isSpeechDeferred(error)).toBe(true);
    expect(error).toBeInstanceOf(SpeechDeferredError);
    // The rule, not the instruction: nothing the run would have done was done.
    expect(rig.programs, "no ffmpeg, no engine in the page").toEqual([]);
    expect(jobs.submitted, "no engine job in the app process").toEqual([]);
    expect(rig.leftovers(), "no audio extract, no scratch").toEqual([]);
    expect(await peekTranscript(rig.ctx(), src)).toBeNull();
    expect(recentPlans()).toMatchObject([
      { file: src.split("/").pop(), plan: "ondemand", why: "cap", where: "boundary", held: true },
    ]);
  });

  it("is a deferral whatever the length of what is asked for next: the same file asked for again is left alone again, and no run is ever left in the join", async () => {
    heldProcessor();
    const src = freshSource();
    noteAudioLength(src, HOURS_3);
    const rig = speechRig();
    for (let i = 0; i < 3; i++)
      await expect(runWhisper(rig.ctx({ background: true }), src)).rejects.toMatchObject({
        code: "speech_deferred",
      });
    expect(rig.programs).toEqual([]);
  });

  it("is run on a PC whose graphics chip does the work, and its length is never asked for", async () => {
    chipPc();
    const src = freshSource();
    noteAudioLength(src, HOURS_3);
    const rig = speechRig();
    const t = await runWhisper(rig.ctx({ background: true }), src);
    expect(t.words.length).toBeGreaterThan(0);
    expect(rig.programs).toEqual(["ffmpeg", "whisper-cli"]);
    expect(recentPlans()).toMatchObject([{ plan: "whole", why: "ok", backend: "gpu" }]);
  });

  it("is run when it fits the cap on the processor, and run when this PC never measured its length", async () => {
    heldProcessor();
    const inside = freshSource();
    noteAudioLength(inside, 120); // 20 + 3.7 x 120 = 464 s
    const unknown = freshSource();
    const rig = speechRig();
    await runWhisper(rig.ctx({ background: true }), inside);
    await runWhisper(rig.ctx({ background: true }), unknown);
    expect(rig.programs.filter((p) => p === "whisper-cli")).toHaveLength(2);
    expect(recentPlans().map((r) => [r.plan, r.why, r.projectedS === null])).toEqual([
      ["whole", "gpu_held", false],
      ["whole", "gpu_held", true],
    ]);
  });

  it("is run as it always was with the switch off: the same file, the same PC, 0.27.0", async () => {
    heldProcessor();
    __setExportFlag("speech_cpu_cap", false);
    const src = freshSource();
    noteAudioLength(src, HOURS_3);
    const rig = speechRig();
    const t = await runWhisper(rig.ctx({ background: true }), src);
    expect(t.words.length).toBeGreaterThan(0);
    expect(rig.programs).toEqual(["ffmpeg", "whisper-cli"]);
    expect(recentPlans()).toEqual([]);
  });
});

describe("the plan is read again where the run can still be left undone (F5)", () => {
  it("a file whose length nobody could measure but whose audio is 3 hours is left for the cap once the audio is read, and no engine is launched", async () => {
    heldProcessor();
    const src = freshSource(); // nobody measured it: the first look cannot tell
    const rig = speechRig({ audioSeconds: HOURS_3 });
    const error = await runWhisper(rig.ctx({ background: true }), src).catch((e: unknown) => e);
    expect(isSpeechDeferred(error)).toBe(true);
    expect(error).toBeInstanceOf(SpeechDeferredError);
    // The rule, not the instruction: the audio was read (that is how its length was known) and the engine
    // was never started.
    expect(rig.programs, "the audio was extracted, and nothing else was run").toEqual(["ffmpeg"]);
    expect(rig.launches, "no engine").toEqual([]);
    expect(rig.leftovers(), "the audio that was read is not left behind").toEqual([]);
    expect(await peekTranscript(rig.ctx(), src)).toBeNull();
    // The first look let it through (its length was not known); the second one, which knew, said no.
    const plans = recentPlans();
    expect(plans.map((r) => [r.where, r.plan, r.projectedS === null])).toEqual([
      ["boundary", "whole", true],
      ["boundary", "ondemand", false],
    ]);
    expect(plans[1].projectedS).toBeCloseTo(20 + 3.7 * HOURS_3, 6);
  });

  it("what the audio measures wins over what was measured before: a probe that said 1 minute for 3 hours of audio", async () => {
    heldProcessor();
    const src = freshSource();
    noteAudioLength(src, 60);
    const rig = speechRig({ audioSeconds: HOURS_3 });
    await expect(runWhisper(rig.ctx({ background: true }), src)).rejects.toMatchObject({
      code: "speech_deferred",
    });
    expect(rig.launches).toEqual([]);
  });

  it("runs a file whose length was unknown and whose audio turns out short, and logs nothing more for it than before", async () => {
    heldProcessor();
    const src = freshSource();
    const rig = speechRig({ audioSeconds: 60 }); // 20 + 3.7 x 60 = 242 s
    const t = await runWhisper(rig.ctx({ background: true }), src);
    expect(t.words.length).toBeGreaterThan(0);
    expect(rig.launches).toHaveLength(1);
    expect(recentPlans().map((r) => [r.where, r.plan, r.projectedS === null])).toEqual([
      ["boundary", "whole", true],
    ]);
  });

  it("is not a reason to leave a request alone: a look asking for the same file and a window from the queue both run", async () => {
    heldProcessor();
    const rig = speechRig({ audioSeconds: HOURS_3 });
    await runWhisper(rig.ctx(), freshSource());
    await runWhisper(rig.ctx({ background: true }), freshSource(), "small", undefined, {
      start: 0,
      end: 600,
    });
    expect(rig.launches).toHaveLength(2);
    expect(recentPlans()).toEqual([]);
  });

  it("does nothing with the switch off: the file runs as it did in 0.27.0 and nothing is logged", async () => {
    heldProcessor();
    __setExportFlag("speech_cpu_cap", false);
    const rig = speechRig({ audioSeconds: HOURS_3 });
    const t = await runWhisper(rig.ctx({ background: true }), freshSource());
    expect(t.words.length).toBeGreaterThan(0);
    expect(rig.launches).toHaveLength(1);
    expect(recentPlans()).toEqual([]);
  });

  it("is the same on a PC whose chip does the work: the file is run, whatever the length of its audio", async () => {
    chipPc();
    const rig = speechRig({ audioSeconds: HOURS_3 });
    const t = await runWhisper(rig.ctx({ background: true }), freshSource());
    expect(t.words.length).toBeGreaterThan(0);
    expect(rig.launches).toHaveLength(1);
  });
});

describe("a request is never planned away", () => {
  it("a look, captions or get_transcript asking for a whole file runs it, over the cap or not", async () => {
    heldProcessor();
    const src = freshSource();
    noteAudioLength(src, HOURS_3);
    const rig = speechRig();
    const t = await runWhisper(rig.ctx(), src); // not the background: someone is waiting
    expect(t.words.length).toBeGreaterThan(0);
    expect(rig.programs).toEqual(["ffmpeg", "whisper-cli"]);
    expect(recentPlans()).toEqual([]);
  });

  it("a stretch asked for from the background's own queue runs: only a whole file is planned", async () => {
    heldProcessor();
    const src = freshSource();
    noteAudioLength(src, HOURS_3);
    const rig = speechRig();
    const t = await runWhisper(rig.ctx({ background: true }), src, "small", undefined, {
      start: 600,
      end: 4200,
    });
    expect(t.words.length).toBeGreaterThan(0);
    expect(rig.programs).toEqual(["ffmpeg", "whisper-cli"]);
    expect(recentPlans()).toEqual([]);
  });

  // The opposite ordering: the request arrives in the same moment as the background's run of the same file,
  // joins it, and the background's run is then left for the cap. The request must not inherit that.
  it("a request that joined the background's run just before it was left for the cap makes its own run", async () => {
    heldProcessor();
    const src = freshSource();
    noteAudioLength(src, HOURS_3);
    const rig = speechRig();
    const background = runWhisper(rig.ctx({ background: true }), src).catch((e: unknown) => e);
    const request = runWhisper(rig.ctx(), src);
    expect(isSpeechDeferred(await background)).toBe(true);
    const t = await request;
    expect(t.words.length).toBeGreaterThan(0);
    expect(rig.programs.filter((p) => p === "whisper-cli")).toHaveLength(1);
  });
});

describe("a batch that holds a file left for the cap", () => {
  it("runs the others in ONE process and leaves that one out, without failing the batch", async () => {
    heldProcessor();
    const [a, b, c] = [freshSource(), freshSource(), freshSource()];
    noteAudioLength(a, 60); // 20 + 3.7 x 60 = 242 s
    noteAudioLength(b, HOURS_3);
    noteAudioLength(c, 60);
    const rig = speechRig();
    const outcomes = await ensureTranscripts(rig.ctx({ background: true }), [a, b, c]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    const left = outcomes[1];
    expect(left.ok === false && isSpeechDeferred(left.error)).toBe(true);
    // One engine process over the two files that were let through, and not a word of the third.
    expect(rig.launches).toHaveLength(1);
    const inputs = flagValues(rig.launches[0], "-f").map((wav) => rig.sourceOf(wav));
    expect(inputs.sort()).toEqual([a, c].sort());
    expect(rig.programs.filter((p) => p === "ffmpeg")).toHaveLength(2);
    expect(await peekTranscript(rig.ctx(), b)).toBeNull();
    expect(recentPlans().map((r) => r.plan)).toEqual(["whole", "ondemand", "whole"]);
  });

  it("lists the one process over several files as ONE job that names every file it reads", async () => {
    __resetSpeechJobs();
    const [a, b] = [freshSource(), freshSource()];
    let seen: readonly SpeechJob[] = [];
    const rig = speechRig({
      engine: async () => {
        seen = [...useSpeechJobs.getState().jobs];
        return { code: 0 };
      },
    });
    await ensureTranscripts(rig.ctx({ background: true }), [a, b], "small", "es");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ purpose: "index", spanS: null, phase: "starting" });
    expect(
      [...seen[0].work].sort((x, y) => x.source.localeCompare(y.source)),
      "what the run reads, so that work asked for can be matched to it",
    ).toEqual([a, b].sort().map((source) => ({ source, language: "es", window: null })));
    expect(useSpeechJobs.getState().jobs, "the run is gone from the list when it ends").toEqual([]);
  });

  it("runs the one file left alone when the other is deferred, and when every file is", async () => {
    heldProcessor();
    const [a, b, c] = [freshSource(), freshSource(), freshSource()];
    noteAudioLength(a, 60);
    noteAudioLength(b, HOURS_3);
    noteAudioLength(c, HOURS_3);
    const rig = speechRig();
    const mixed = await ensureTranscripts(rig.ctx({ background: true }), [a, b]);
    expect(mixed.map((o) => o.ok)).toEqual([true, false]);
    expect(rig.launches).toHaveLength(1);
    const all = await ensureTranscripts(rig.ctx({ background: true }), [b, c]);
    expect(all.every((o) => !o.ok && isSpeechDeferred(o.error))).toBe(true);
    expect(rig.launches, "nothing more was launched").toHaveLength(1);
  });

  it("is untouched with the switch off", async () => {
    heldProcessor();
    __setExportFlag("speech_cpu_cap", false);
    const [a, b] = [freshSource(), freshSource()];
    noteAudioLength(a, 60);
    noteAudioLength(b, HOURS_3);
    const rig = speechRig();
    const outcomes = await ensureTranscripts(rig.ctx({ background: true }), [a, b]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    expect(rig.launches).toHaveLength(1);
    expect(flagValues(rig.launches[0], "-f")).toHaveLength(2);
  });
});
