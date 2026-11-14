// The background indexer's admission of a whole file it would start by itself (S2-02), as outcomes: what
// reaches the engine, what is counted against the file or the engine (nothing, for a deferral), what
// the queue does with the file left for the cap (leaves it, never spins, looks again only when the facts
// the planner reads have changed), and what a session remembers about a file the person stopped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexCoordinator } from "./indexCoordinator";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import {
  __resetSpeechSession,
  SpeechDeferredError,
  wasCancelledByPerson,
} from "../tools/speechAdmission";
import { GPU_RETRY_AFTER_MS, holdCpuOnly } from "../tools/speechBackend";
import { SpeechCancelledError } from "../tools/speechFailure";
import { recordSpeechRun } from "../tools/speechPace";
import { __resetPlanLog, recentPlans } from "../tools/speechPlanLog";
import { prioritizeTranscript } from "../tools/transcriptQueue";
import { __resetWorkGate, lookWhisper, setExportsBusy } from "../tools/workGate";
import { __resetSpeechJobs, useSpeechJobs } from "./speechJobs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const {
  processImportedMedia,
  clearSourceUrlCache,
  ensureTranscript,
  ensureTranscripts,
  runWhisper,
  adoptTranscriptions,
  measureLoudness,
  reportAppError,
  sourceHasAudio,
  sourceDurationSeconds,
} = vi.hoisted(() => ({
  processImportedMedia: vi.fn(async () => false),
  clearSourceUrlCache: vi.fn(),
  ensureTranscript: vi.fn(async (..._a: unknown[]) => ({ parsed: {}, existed: false })),
  ensureTranscripts: vi.fn(
    async (_ctx: unknown, refs: readonly string[], ..._rest: unknown[]) =>
      refs.map(() => ({ ok: true as const, existed: false })) as Array<
        { ok: true; existed: boolean } | { ok: false; error: unknown }
      >,
  ),
  runWhisper: vi.fn(async (..._a: unknown[]) => ({})),
  adoptTranscriptions: vi.fn(async () => 0),
  measureLoudness: vi.fn(async (..._a: unknown[]): Promise<object> => ({})),
  reportAppError: vi.fn(),
  sourceHasAudio: vi.fn(async () => true),
  sourceDurationSeconds: vi.fn(async (..._a: unknown[]) => 0),
}));

class FakeEngineDown extends Error {
  readonly code = "speech_engine_unavailable";
}
vi.mock("../preview/mediaProxy", () => ({ processImportedMedia }));
vi.mock("../preview/resolve", () => ({ clearSourceUrlCache }));
vi.mock("../tools/transcribe", () => ({
  ensureTranscript,
  ensureTranscripts,
  runWhisper,
  isSpeechEngineUnavailable: (e: unknown) => e instanceof FakeEngineDown,
  adoptTranscriptions,
}));
vi.mock("../tools/loudness", () => ({ measureLoudness }));
vi.mock("../timeline/placement", () => ({ sourceHasAudio, sourceDurationSeconds }));
vi.mock("../api/appEvents", () => ({ reportAppError }));

const HOURS_3 = 3 * 3600;
const runner = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as Any;
const makeRunner = async () => runner as Any;
const store = (): Any => ({
  projectDir: "C:/p",
  listClips: vi.fn(async () => []),
  resolveRef: vi.fn(async (r: string) => (/^[A-Za-z]:\//.test(r) ? r : `C:/p/${r}`)),
  offlineMedia: vi.fn(async () => null),
});
const coordinator = (): IndexCoordinator =>
  new IndexCoordinator(store(), makeRunner, vi.fn(), vi.fn());

async function settle(pred: () => boolean, ms = 1500): Promise<void> {
  // Not Date: a test fakes it to move the hold on the chip.
  const t0 = performance.now();
  while (!pred() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}
/** Let everything that is going to happen, happen. */
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 80));

/** How long each clip is (keyed by its library name); any other is of unknown length. */
const lengths = (secondsOf: Record<string, number>): void => {
  sourceDurationSeconds.mockImplementation(
    async (_runner: unknown, abs: unknown) => secondsOf[String(abs).replace("C:/p/", "")] ?? 0,
  );
};
const started = (): string[] =>
  ensureTranscript.mock.calls.map((c) => (c as unknown[])[1] as string);

/** A PC whose chip crashed: the processor runs at the pace of a PC that has measured nothing. */
const heldProcessor = (): void => holdCpuOnly(-1073740791, Date.now());
const chipPc = (): void => {
  recordSpeechRun(60, 10, "gpu");
  recordSpeechRun(60, 11, "gpu");
};

beforeEach(() => {
  localStorage.clear();
  __resetExportFlags();
  __resetPlanLog();
  __resetSpeechSession();
  __resetSpeechJobs();
  __resetWorkGate();
  for (const spy of [ensureTranscript, ensureTranscripts, runWhisper, reportAppError])
    spy.mockClear();
  ensureTranscript.mockResolvedValue({ parsed: {}, existed: false });
  sourceDurationSeconds.mockReset();
  sourceDurationSeconds.mockResolvedValue(0);
  sourceHasAudio.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe("a 3-hour file on a processor at its default pace", () => {
  it("is not started, is no failure and no strike, and the next small file still runs", async () => {
    heldProcessor();
    lengths({ "library/long.mp4": HOURS_3, "library/short.mp3": 20 });
    const c = coordinator();
    c.indexSource("library/long.mp4");
    c.indexSource("library/short.mp3");
    await settle(() => started().includes("library/short.mp3"));
    await quiet();
    expect(started()).toEqual(["library/short.mp3"]);
    expect(ensureTranscripts).not.toHaveBeenCalled();
    expect(reportAppError, "a deferral is nobody's failure").not.toHaveBeenCalled();
    const plans = recentPlans();
    expect(plans.find((p) => p.file === "long.mp4")).toMatchObject({
      plan: "ondemand",
      why: "cap",
      where: "indexer",
      backend: "cpu",
      held: true,
    });
    expect(plans.find((p) => p.file === "short.mp3")).toMatchObject({ plan: "whole" });
    c.dispose();
  });

  it("does not block the files behind it, however many of them are left for the cap", async () => {
    heldProcessor();
    const long = Array.from({ length: 6 }, (_, i) => `library/long${i}.mp4`);
    lengths({ ...Object.fromEntries(long.map((n) => [n, HOURS_3])), "library/ok.mp3": 20 });
    const c = coordinator();
    for (const n of long) c.indexSource(n);
    c.indexSource("library/ok.mp3");
    await settle(() => started().includes("library/ok.mp3"));
    expect(started()).toEqual(["library/ok.mp3"]);
    c.dispose();
  });

  it("is not started again in a loop: left alone, the queue is quiet and asks nothing more about it", async () => {
    heldProcessor();
    lengths({ "library/long.mp4": HOURS_3 });
    const c = coordinator();
    c.indexSource("library/long.mp4");
    await quiet();
    const probes = sourceDurationSeconds.mock.calls.length;
    const records = recentPlans().length;
    await quiet();
    await quiet();
    expect(sourceDurationSeconds.mock.calls.length).toBe(probes);
    expect(recentPlans()).toHaveLength(records);
    expect(started()).toEqual([]);
    // Another file arriving drains again, but nothing about the planner has changed: it is not planned again.
    c.indexSource("library/other.mp3");
    await settle(() => started().length === 1);
    await quiet();
    expect(recentPlans().filter((p) => p.file === "long.mp4")).toHaveLength(1);
    c.dispose();
  });

  it("is started on a PC whose chip does the work", async () => {
    chipPc();
    lengths({ "library/long.mp4": HOURS_3 });
    const c = coordinator();
    c.indexSource("library/long.mp4");
    await settle(() => started().length === 1);
    expect(started()).toEqual(["library/long.mp4"]);
    expect(recentPlans()).toMatchObject([{ plan: "whole", why: "ok" }]);
    c.dispose();
  });

  it("is started as it always was with the switch off, and nothing is written", async () => {
    heldProcessor();
    __setExportFlag("speech_cpu_cap", false);
    lengths({ "library/long.mp4": HOURS_3 });
    const c = coordinator();
    c.indexSource("library/long.mp4");
    await settle(() => started().length === 1);
    expect(started()).toEqual(["library/long.mp4"]);
    expect(recentPlans()).toEqual([]);
    c.dispose();
  });
});

describe("what makes the planner look at a file left for the cap again", () => {
  it("is the hold on the chip lapsing: the next drain runs it on the chip", async () => {
    chipPc();
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 14, 12), toFake: ["Date"] });
    heldProcessor();
    lengths({ "library/long.mp4": HOURS_3 });
    const c = coordinator();
    c.indexSource("library/long.mp4");
    await quiet();
    expect(started()).toEqual([]);
    vi.setSystemTime(Date.now() + GPU_RETRY_AFTER_MS - 1);
    c.indexSource("library/a.mp3");
    await settle(() => started().length === 1);
    await quiet();
    expect(started(), "never before six hours: only the new file").toEqual(["library/a.mp3"]);
    vi.setSystemTime(Date.now() + 1);
    c.indexSource("library/b.mp3");
    await settle(() => started().includes("library/long.mp4"));
    expect(started()).toContain("library/long.mp4");
    expect(
      recentPlans()
        .filter((p) => p.file === "long.mp4")
        .map((p) => p.plan),
    ).toEqual(["ondemand", "whole"]);
    c.dispose();
  });

  it("is a faster pace this PC measured: a processor that proved quick takes the file it would not", async () => {
    heldProcessor();
    // 90 minutes: 20 + 3.7 x 5,400 = 20,000 s at the default pace; 20 + 0.05 x 5,400 = 290 s once measured.
    lengths({ "library/long.mp4": 5400 });
    const c = coordinator();
    c.indexSource("library/long.mp4");
    await quiet();
    expect(started()).toEqual([]);
    recordSpeechRun(600, 50, "cpu", undefined, 20); // 600 s of audio in 50 s of work: 0.05 s per audio second
    c.indexSource("library/a.mp3");
    await settle(() => started().includes("library/long.mp4"));
    expect(started()).toContain("library/long.mp4");
    c.dispose();
  });

  it("is the switch turned off remotely: 0.27.0 starts it", async () => {
    heldProcessor();
    lengths({ "library/long.mp4": HOURS_3 });
    const c = coordinator();
    c.indexSource("library/long.mp4");
    await quiet();
    expect(started()).toEqual([]);
    __setExportFlag("speech_cpu_cap", false);
    c.indexSource("library/a.mp3");
    await settle(() => started().includes("library/long.mp4"));
    expect(started()).toContain("library/long.mp4");
    c.dispose();
  });
});

describe("a deferral at the boundary, after the run was admitted", () => {
  it("is the same as one at admission: no strike, no report, the file left for later, the engine not marked down", async () => {
    // Many files that each come back as left for the cap: three strikes would have disabled the engine.
    ensureTranscript.mockRejectedValue(
      new SpeechDeferredError({ why: "cap", projectedS: 5000, capS: 600 }),
    );
    const c = coordinator();
    for (let i = 0; i < 5; i++) c.indexSource(`library/f${i}.mp4`);
    await settle(() => started().length >= 5);
    await quiet();
    expect(started()).toHaveLength(5);
    expect(reportAppError).not.toHaveBeenCalled();
    ensureTranscript.mockResolvedValue({ parsed: {}, existed: false });
    c.indexSource("library/after.mp3");
    await settle(() => started().includes("library/after.mp3"));
    expect(started()).toContain("library/after.mp3");
    c.dispose();
  });

  it("is, when the live check stopped the run, a file this session does not start again by itself", async () => {
    ensureTranscript.mockRejectedValueOnce(
      new SpeechDeferredError({ why: "cap", projectedS: 5000, capS: 600 }, { stopped: true }),
    );
    const c = coordinator();
    c.indexSource("library/slow.mp4");
    await settle(() => started().length === 1);
    await quiet();
    // The facts the planner reads change, and a new project is opened: neither restarts it.
    chipPc();
    c.indexSource("library/a.mp3");
    await settle(() => started().includes("library/a.mp3"));
    const reopened = coordinator();
    reopened.indexSource("library/slow.mp4");
    await quiet();
    expect(started().filter((s) => s === "library/slow.mp4")).toHaveLength(1);
    expect(reportAppError).not.toHaveBeenCalled();
    c.dispose();
    reopened.dispose();
  });
});

describe("a file the person stopped", () => {
  it("is no failure and no report, and is not started again by the indexer, in this project or a reopened one", async () => {
    ensureTranscript.mockRejectedValueOnce(new SpeechCancelledError());
    const c = coordinator();
    c.indexSource("library/talk.mp4");
    await settle(() => started().length === 1);
    await quiet();
    expect(reportAppError).not.toHaveBeenCalled();
    expect(wasCancelledByPerson("transcript\u0000library/talk.mp4")).toBe(true);
    // The sweep sees it again and does nothing; a reopened project's indexer does not start it either.
    c.indexSource("library/talk.mp4");
    const reopened = coordinator();
    reopened.indexSource("library/talk.mp4");
    reopened.indexSource("library/next.mp3");
    await settle(() => started().includes("library/next.mp3"));
    await quiet();
    expect(started()).toEqual(["library/talk.mp4", "library/next.mp3"]);
    c.dispose();
    reopened.dispose();
  });

  it("is restarted by a request for a part of it, and only that part", async () => {
    ensureTranscript.mockRejectedValueOnce(new SpeechCancelledError());
    const c = coordinator();
    c.indexSource("library/talk.mp4");
    await settle(() => started().length === 1);
    await quiet();
    expect(
      prioritizeTranscript("C:/p", "C:/p/library/talk.mp4", "", { start: 100, end: 160 }),
    ).toBe(true);
    await settle(() => runWhisper.mock.calls.length === 1);
    const call = runWhisper.mock.calls[0] as unknown[];
    expect(call[1]).toBe("C:/p/library/talk.mp4");
    expect(call[4]).toEqual({ start: 100, end: 160 });
    expect(started(), "the whole file was not started again").toEqual(["library/talk.mp4"]);
    c.dispose();
  });

  it("a batch the person stopped marks every file in it, and none of them is a failure", async () => {
    lengths({ "library/a.mp3": 1, "library/b.mp3": 1 });
    // Two tiny files share one run; the person stops it.
    ensureTranscripts.mockImplementationOnce(async (_ctx, refs) =>
      refs.map(() => ({ ok: false as const, error: new SpeechCancelledError() })),
    );
    recordSpeechRun(100, 53, "gpu", undefined, 3);
    const c = coordinator();
    c.indexSource("library/a.mp3");
    c.indexSource("library/b.mp3");
    await settle(() => ensureTranscripts.mock.calls.length === 1);
    await quiet();
    expect(reportAppError).not.toHaveBeenCalled();
    expect(wasCancelledByPerson("transcript\u0000library/a.mp3")).toBe(true);
    expect(wasCancelledByPerson("transcript\u0000library/b.mp3")).toBe(true);
    c.dispose();
  });
});

describe("a file waiting for its turn", () => {
  it("is shown to the chip while an EXPORT is what it waits for, as waiting and not slow, and is gone the moment the export ends", async () => {
    setExportsBusy(true);
    const c = coordinator();
    c.indexSource("library/talk.mp4");
    await settle(() => useSpeechJobs.getState().jobs.length === 1);
    const [job] = useSpeechJobs.getState().jobs;
    expect(job).toMatchObject({
      purpose: "index",
      label: "talk.mp4",
      phase: "waiting",
      startedAt: null,
      doneS: 0,
      rate: null,
      etaS: null,
      facts: { exportsBusy: true },
    });
    await quiet();
    expect(started(), "an export holds the turn").toEqual([]);
    setExportsBusy(false);
    await settle(() => started().length === 1);
    expect(useSpeechJobs.getState().jobs).toEqual([]);
    expect(started()).toEqual(["library/talk.mp4"]);
    c.dispose();
  });

  it("is not shown while a look or another transcription is what it waits for", async () => {
    let finishLook!: () => void;
    const look = lookWhisper(() => new Promise<void>((r) => (finishLook = r)));
    const c = coordinator();
    c.indexSource("library/talk.mp4");
    await quiet();
    expect(started()).toEqual([]);
    expect(useSpeechJobs.getState().jobs).toEqual([]);
    finishLook();
    await look;
    await settle(() => started().length === 1);
    c.dispose();
  });

  it("is taken off the chip when the project closes while it waits for the export", async () => {
    setExportsBusy(true);
    const c = coordinator();
    c.indexSource("library/talk.mp4");
    await settle(() => useSpeechJobs.getState().jobs.length === 1);
    c.dispose();
    await settle(() => useSpeechJobs.getState().jobs.length === 0);
    expect(useSpeechJobs.getState().jobs).toEqual([]);
    expect(started()).toEqual([]);
  });

  it("is not made worse by a list that cannot be written: the file is still transcribed when its turn comes", async () => {
    setExportsBusy(true);
    const state = useSpeechJobs.getState();
    const add = vi.spyOn(state, "add").mockImplementation(() => {
      throw new Error("list down");
    });
    const c = coordinator();
    c.indexSource("library/talk.mp4");
    await quiet();
    setExportsBusy(false);
    await settle(() => started().length === 1);
    expect(started()).toEqual(["library/talk.mp4"]);
    add.mockRestore();
    c.dispose();
  });
});
