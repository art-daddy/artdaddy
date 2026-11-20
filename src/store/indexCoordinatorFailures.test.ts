// What the background indexer does with a transcript that failed (the status bar's list and its Retry), and what it
// can say of where a file stands in its queue (the assistant's `queue` field, the line on an agent's import).
// The engine is a mock that fails or waits at a gate; everything else is the indexer as it runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexCoordinator } from "./indexCoordinator";
import {
  __resetSpeechFailures,
  ENGINE_FAILURE_ID,
  retrySpeechFailures,
  useSpeechFailures,
} from "./speechFailures";
import { __resetSpeechJobs } from "./speechJobs";
import { indexImportedSource, transcriptQueueStatus } from "../tools/transcriptQueue";
import { __resetWorkGate, lookWhisper, setExportsBusy } from "../tools/workGate";
import type { Timeline } from "../timeline/model";

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
  ensureTranscript: vi.fn(async (..._a: unknown[]) => ({
    path: "t.json",
    parsed: {},
    existed: false,
  })),
  ensureTranscripts: vi.fn(async (_ctx: unknown, refs: readonly string[], ..._rest: unknown[]) =>
    refs.map(() => ({ ok: true as const, existed: false })),
  ),
  runWhisper: vi.fn(async (..._a: unknown[]) => ({})),
  adoptTranscriptions: vi.fn(async () => 0),
  measureLoudness: vi.fn(async (..._a: unknown[]): Promise<object> => ({
    integrated_lufs: -23,
    true_peak_dbtp: -23,
    rms_dbfs: -26,
  })),
  reportAppError: vi.fn(),
  sourceHasAudio: vi.fn(async () => true),
  // A length nobody could tell runs alone.
  sourceDurationSeconds: vi.fn(async (..._a: unknown[]) => 0),
}));

/** A speech engine that cannot start. Shape-compatible with the real typed error. */
class FakeEngineDown extends Error {
  readonly code = "speech_engine_unavailable";
}
const isSpeechEngineUnavailable = (e: unknown): boolean => e instanceof FakeEngineDown;

vi.mock("../preview/mediaProxy", () => ({ processImportedMedia }));
vi.mock("../preview/resolve", () => ({ clearSourceUrlCache }));
vi.mock("../tools/transcribe", () => ({
  ensureTranscript,
  ensureTranscripts,
  runWhisper,
  isSpeechEngineUnavailable,
  adoptTranscriptions,
}));
vi.mock("../tools/loudness", () => ({ measureLoudness }));
vi.mock("../timeline/placement", () => ({ sourceHasAudio, sourceDurationSeconds }));
vi.mock("../api/appEvents", () => ({ reportAppError }));

const OK = { path: "t.json", parsed: {}, existed: false };
const DIR = "C:/p";
const runner = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as Any;
const makeRunner = async () => runner as Any;
const fakeStore = (clips: { path: string; id?: string }[] = []): Any => ({
  projectDir: DIR,
  listClips: vi.fn(async () => clips),
  resolveRef: vi.fn(async (r: string) => (/^[A-Za-z]:\//.test(r) ? r : `${DIR}/${r}`)),
  offlineMedia: vi.fn(async () => null),
});
const empty = (): Timeline =>
  ({ canvas: { width: 1, height: 1, fps: 30 }, tracks: [{ id: "v", clips: [] }] }) as Any;

/** The sources handed to the transcript pass, in order. */
const transcribed = (): string[] =>
  ensureTranscript.mock.calls.map((c) => (c as unknown[])[1] as string);
const failures = () => useSpeechFailures.getState().failures;
const queue = (source: string) => transcriptQueueStatus(DIR, source, "");

async function settle(pred: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}

/** An engine whose runs wait at a gate: `gates[0]` is the run in progress. */
function gated(): { gates: Array<() => void>; release: () => Promise<void> } {
  const gates: Array<() => void> = [];
  ensureTranscript.mockImplementation(async () => {
    await new Promise<void>((r) => gates.push(r));
    return OK;
  });
  const release = async (): Promise<void> => {
    const before = ensureTranscript.mock.calls.length;
    gates.shift()?.();
    await settle(() => ensureTranscript.mock.calls.length > before || gates.length > 0, 200);
  };
  return { gates, release };
}

beforeEach(() => {
  for (const m of [
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
  ])
    m.mockReset();
  processImportedMedia.mockResolvedValue(false);
  ensureTranscript.mockResolvedValue(OK);
  ensureTranscripts.mockImplementation(async (_ctx, refs) =>
    refs.map(() => ({ ok: true as const, existed: false })),
  );
  runWhisper.mockResolvedValue({});
  adoptTranscriptions.mockResolvedValue(0);
  measureLoudness.mockResolvedValue({ integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 });
  sourceHasAudio.mockResolvedValue(true);
  sourceDurationSeconds.mockResolvedValue(0);
  __resetSpeechFailures();
  __resetSpeechJobs();
});
afterEach(() => {
  setExportsBusy(false);
  __resetWorkGate();
  __resetSpeechFailures();
  __resetSpeechJobs();
});

describe("a transcript that failed in the background", () => {
  it("is told to the person as well as to us: the list has the file and the exact error, and the same failure was reported", async () => {
    ensureTranscript.mockRejectedValue(new Error("whisper-cli failed (code=-1073741819)"));
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/interview.mp3");
    await settle(() => failures().length > 0);
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({
      label: "interview.mp3",
      reason: "engine_failed",
      attempts: 1,
      willRetry: true,
    });
    expect(failures()[0].message).toContain("whisper-cli failed (code=-1073741819)");
    // The rule: what the bar shows is also what was sent, one report for the one failure.
    expect(reportAppError).toHaveBeenCalledTimes(1);
    expect(String(reportAppError.mock.calls[0][0])).toContain("whisper-cli failed");
    c.dispose();
  });

  it("is not told when it is not a failure: a file the person stopped", async () => {
    const stopped = Object.assign(new Error("stopped"), { code: "speech_cancelled" });
    ensureTranscript.mockRejectedValue(stopped);
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    // Its own name: a file the person stopped is kept out of the indexer for the rest of the session.
    c.indexSource("library/stopped-by-person.mp3");
    await settle(() => ensureTranscript.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(failures()).toEqual([]);
    expect(reportAppError).not.toHaveBeenCalled();
    c.dispose();
  });

  it("goes when a later try works", async () => {
    ensureTranscript.mockRejectedValueOnce(new Error("network error"));
    const c = new IndexCoordinator(
      fakeStore([{ path: "library/a.mp3" }]),
      makeRunner,
      vi.fn(),
      vi.fn(),
    );
    await c.sweep(empty());
    await settle(() => failures().length === 1);
    expect(failures()).toHaveLength(1);
    await c.sweep(empty()); // a failed file is asked for again by the next sweep
    await settle(() => ensureTranscript.mock.calls.length >= 2);
    await settle(() => failures().length === 0);
    expect(failures()).toEqual([]);
    c.dispose();
  });

  it("says when the app has stopped trying: three tries and then no more by itself", async () => {
    ensureTranscript.mockRejectedValue(new Error("corrupt audio"));
    const c = new IndexCoordinator(
      fakeStore([{ path: "library/a.mp3" }]),
      makeRunner,
      vi.fn(),
      vi.fn(),
    );
    for (let sweep = 0; sweep < 5; sweep++) {
      await c.sweep(empty());
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({ attempts: 3, willRetry: false });
    expect(reportAppError).toHaveBeenCalledTimes(3); // one report for each try that was shown
    c.dispose();
  });

  it("Retry puts the file first in the queue, takes it off the list as it starts again, and it stays off when it works", async () => {
    ensureTranscript.mockRejectedValueOnce(new Error("whisper boom"));
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/a.mp3");
    await settle(() => failures().length === 1);
    const { gates, release } = gated();
    c.indexSource("library/b.mp3");
    c.indexSource("library/c.mp3");
    await settle(() => gates.length === 1); // b is running, c waits
    expect(retrySpeechFailures()).toBe(1);
    expect(failures()).toEqual([]);
    for (let i = 0; i < 3; i++) await release();
    // the failed one before the one that was only waiting, though it was asked for after it
    expect(transcribed()).toEqual([
      "library/a.mp3",
      "library/b.mp3",
      "library/a.mp3",
      "library/c.mp3",
    ]);
    expect(failures()).toEqual([]);
    c.dispose();
  });

  it("is shown again when the retry fails again, with the tries counted on and reported again", async () => {
    ensureTranscript.mockRejectedValue(new Error("boom"));
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/a.mp3");
    await settle(() => failures().length === 1);
    retrySpeechFailures();
    await settle(() => reportAppError.mock.calls.length >= 2);
    await settle(() => failures().length === 1 && failures()[0].attempts === 2);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].attempts).toBe(2);
    expect(String(reportAppError.mock.calls[1][0])).toMatch(/attempt 2/);
    c.dispose();
  });

  it("goes with its project: closing one takes away its failures and not another's", async () => {
    ensureTranscript.mockRejectedValue(new Error("boom"));
    const one = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    const two = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    one.indexSource("library/one.mp3");
    await settle(() => failures().length === 1);
    two.indexSource("library/two.mp3");
    await settle(() => failures().length === 2);
    expect(failures()).toHaveLength(2);
    one.dispose();
    expect(failures().map((f) => f.label)).toEqual(["two.mp3"]);
    two.dispose();
    expect(failures()).toEqual([]);
    expect(retrySpeechFailures()).toBe(0);
  });
});

describe("a speech engine that cannot start", () => {
  const files = ["a", "b", "c", "d", "e"].map((n) => `library/${n}.mp3`);

  async function down(): Promise<IndexCoordinator> {
    ensureTranscript.mockRejectedValue(new FakeEngineDown("0xC0000135"));
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    for (const f of files) c.indexSource(f);
    await settle(() => failures().some((f) => f.id === ENGINE_FAILURE_ID));
    return c;
  }

  it("is one failure on the list, not one for each file, and the same one that was reported once", async () => {
    const c = await down();
    expect(failures().map((f) => f.id)).toEqual([ENGINE_FAILURE_ID]);
    expect(failures()[0]).toMatchObject({ label: null, willRetry: false });
    expect(reportAppError).toHaveBeenCalledTimes(1);
    expect(String(reportAppError.mock.calls[0][0])).toMatch(/speech engine unavailable/i);
    expect(transcribed()).toEqual(files.slice(0, 3)); // three starts were tried, then no more
    c.dispose();
  });

  it("Retry gives the engine another chance and puts back every file it kept from running", async () => {
    const c = await down();
    ensureTranscript.mockClear();
    ensureTranscript.mockResolvedValue(OK);
    expect(retrySpeechFailures()).toBe(1);
    expect(failures()).toEqual([]);
    await settle(() => ensureTranscript.mock.calls.length >= files.length);
    // the three that failed to start and the two that were still waiting, each once
    expect([...transcribed()].sort()).toEqual([...files].sort());
    c.dispose();
  });

  it("is told again when it still cannot start after Retry", async () => {
    const c = await down();
    reportAppError.mockClear();
    retrySpeechFailures();
    await settle(() => failures().some((f) => f.id === ENGINE_FAILURE_ID));
    await settle(() => reportAppError.mock.calls.length > 0);
    expect(failures().map((f) => f.id)).toEqual([ENGINE_FAILURE_ID]);
    expect(reportAppError).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("is unavailable for every file, to a tool that asks", async () => {
    const c = await down();
    expect(queue("library/d.mp3")).toEqual({ state: "unavailable" });
    expect(queue("library/never-asked.mp3")).toEqual({ state: "unavailable" });
    c.dispose();
  });
});

describe("where a file stands in the queue", () => {
  async function busy(): Promise<{ c: IndexCoordinator; release: () => Promise<void> }> {
    const { gates, release } = gated();
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    for (const s of ["library/a.mp3", "library/b.mp3", "library/c.mp3"]) c.indexSource(s);
    await settle(() => gates.length > 0);
    return { c, release };
  }

  it("tells the one running from the ones that wait, and how many are ahead of each", async () => {
    const { c } = await busy();
    expect(queue("library/a.mp3")).toEqual({ state: "running" });
    expect(queue("library/b.mp3")).toEqual({ state: "queued", ahead: 1 });
    expect(queue("library/c.mp3")).toEqual({ state: "queued", ahead: 2 });
    expect(queue("library/never-asked.mp3")).toBeNull();
    c.dispose();
  });

  it("moves each file up as the one before it finishes, and knows nothing of one that is done", async () => {
    const { c, release } = await busy();
    await release();
    await settle(() => queue("library/b.mp3")?.state === "running");
    expect(queue("library/a.mp3")).toBeNull();
    expect(queue("library/b.mp3")).toEqual({ state: "running" });
    expect(queue("library/c.mp3")).toEqual({ state: "queued", ahead: 1 });
    c.dispose();
  });

  it("puts a file somebody asked for at the front, and says so", async () => {
    const { c } = await busy();
    c.prioritizeTranscript("library/c.mp3", "");
    expect(queue("library/c.mp3")).toEqual({ state: "queued", ahead: 1 });
    expect(queue("library/b.mp3")).toEqual({ state: "queued", ahead: 2 });
    c.dispose();
  });

  it("says what holds the turn back when it is not the work ahead: an export", async () => {
    setExportsBusy(true);
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/a.mp3");
    c.indexSource("library/b.mp3");
    await new Promise((r) => setTimeout(r, 30));
    expect(ensureTranscript).not.toHaveBeenCalled();
    expect(queue("library/a.mp3")).toEqual({ state: "queued", ahead: 0, held_by: "export" });
    expect(queue("library/b.mp3")).toEqual({ state: "queued", ahead: 1, held_by: "export" });
    setExportsBusy(false);
    await settle(() => ensureTranscript.mock.calls.length === 2);
    expect(transcribed()).toEqual(["library/a.mp3", "library/b.mp3"]);
    c.dispose();
  });

  it("says what holds the turn back when it is not the work ahead: a transcription somebody is waiting on", async () => {
    let done!: () => void;
    const look = lookWhisper(() => new Promise<void>((r) => (done = r)));
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/a.mp3");
    await new Promise((r) => setTimeout(r, 30));
    expect(ensureTranscript).not.toHaveBeenCalled();
    expect(queue("library/a.mp3")).toEqual({ state: "queued", ahead: 0, held_by: "look" });
    done();
    await look;
    await settle(() => ensureTranscript.mock.calls.length === 1);
    expect(transcribed()).toEqual(["library/a.mp3"]);
    c.dispose();
  });

  it("knows nothing once the project is closed, and a closed project is not handed anything", async () => {
    const { c } = await busy();
    c.dispose();
    expect(queue("library/b.mp3")).toBeNull();
    expect(indexImportedSource(DIR, "library/late.mp3")).toBe(false);
  });
});

describe("a file an agent imports is handed to the index at once", () => {
  it("is queued by the hand-over and not queued twice by the sweep that follows", async () => {
    const c = new IndexCoordinator(
      fakeStore([{ path: "library/x.mp3" }]),
      makeRunner,
      vi.fn(),
      vi.fn(),
    );
    expect(indexImportedSource(DIR, "library/x.mp3")).toBe(true);
    await settle(() => ensureTranscript.mock.calls.length > 0);
    await c.sweep(empty()); // the sweep the import's own announcement causes
    await new Promise((r) => setTimeout(r, 30));
    expect(transcribed()).toEqual(["library/x.mp3"]);
    c.dispose();
  });
});
