import { beforeEach, describe, expect, it, vi } from "vitest";

import { IndexCoordinator } from "./indexCoordinator";
import type { Timeline } from "../timeline/model";
import { backgroundLoudness, prioritizeTranscript } from "../tools/transcriptQueue";
import { setExportsBusy } from "../tools/workGate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Mocks must be hoisted so the vi.mock factories can reference them.
const FIGURES = { integrated_lufs: -23, true_peak_dbtp: -23, rms_dbfs: -26 };
const {
  processImportedMedia,
  clearSourceUrlCache,
  ensureTranscript,
  runWhisper,
  measureLoudness,
  reportAppError,
  sourceHasAudio,
} = vi.hoisted(() => ({
  processImportedMedia: vi.fn(async () => false),
  clearSourceUrlCache: vi.fn(),
  ensureTranscript: vi.fn(async () => ({ path: "t.json", parsed: {}, existed: false })),
  runWhisper: vi.fn(async (..._a: unknown[]) => ({})),
  measureLoudness: vi.fn(async (..._a: unknown[]): Promise<object> => ({
    integrated_lufs: -23,
    true_peak_dbtp: -23,
    rms_dbfs: -26,
  })),
  reportAppError: vi.fn(),
  sourceHasAudio: vi.fn(async () => true),
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
  runWhisper,
  isSpeechEngineUnavailable,
}));
vi.mock("../tools/loudness", () => ({ measureLoudness }));
vi.mock("../timeline/placement", () => ({ sourceHasAudio }));
vi.mock("../api/appEvents", () => ({ reportAppError }));

/** The sources handed to the transcript pass, in order. */
const transcribed = (): string[] =>
  ensureTranscript.mock.calls.map((c) => (c as unknown[])[1] as string);
/** The [path, start, end] handed to the loudness pass, in order. */
const measured = (): unknown[][] => measureLoudness.mock.calls.map((c) => c.slice(1, 4));

const runner = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) } as Any;
const makeRunner = async () => runner as Any;
const fakeStore = (
  clips: { path: string; status?: string; id?: string }[] = [],
  offline: Set<string> = new Set(),
): Any => ({
  projectDir: "C:/p",
  listClips: vi.fn(async () => clips),
  resolveRef: vi.fn(async (r: string) =>
    offline.has(r) ? null : /^[A-Za-z]:\//.test(r) ? r : `C:/p/${r}`,
  ),
  offlineMedia: vi.fn(async (r: string) => (offline.has(r) ? { id: r, path: r } : null)),
});

function tl(clips: { media_ref: string; kind?: string }[]): Timeline {
  return {
    canvas: { width: 1, height: 1, fps: 30 },
    tracks: [
      {
        id: "v",
        clips: clips.map((c, i) => ({ id: `c${i}`, ...c, timeline_in: 0, timeline_out: 1 })),
      },
    ],
  } as Any;
}

async function settle(pred: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  processImportedMedia.mockReset();
  processImportedMedia.mockResolvedValue(false);
  clearSourceUrlCache.mockReset();
  ensureTranscript.mockReset();
  ensureTranscript.mockResolvedValue({ path: "t.json", parsed: {}, existed: false });
  runWhisper.mockReset();
  runWhisper.mockResolvedValue({});
  measureLoudness.mockReset();
  measureLoudness.mockResolvedValue(FIGURES);
  reportAppError.mockReset();
  sourceHasAudio.mockReset();
  sourceHasAudio.mockResolvedValue(true);
});

describe("IndexCoordinator", () => {
  // UJ-012: a look at a long file does not wait for its transcript. It puts the file at the FRONT
  // of this queue (still one whisper at a time) and tells the model to come back.
  describe("a look's transcript jumps the queue", () => {
    /** A coordinator whose transcriptions wait at a gate, with the first one already running. */
    async function busy(): Promise<{ c: IndexCoordinator; release: () => Promise<void> }> {
      const gates: Array<() => void> = [];
      (ensureTranscript as Any).mockImplementation(async () => {
        await new Promise<void>((r) => gates.push(r));
        return { path: "t.json", parsed: {}, existed: false };
      });
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      for (const s of ["library/a.mp3", "library/b.mp3", "library/c.mp3"]) c.indexSource(s);
      await settle(() => gates.length > 0);
      const release = async (): Promise<void> => {
        const before = ensureTranscript.mock.calls.length;
        gates.shift()?.();
        await settle(() => ensureTranscript.mock.calls.length > before || gates.length > 0, 200);
      };
      return { c, release };
    }

    it("runs the asked-for file right after the one already running", async () => {
      const { c, release } = await busy();
      expect(prioritizeTranscript("C:/p", "C:/media/talk.mp4", "")).toBe(true);
      await release();
      await settle(() => ensureTranscript.mock.calls.length >= 2);
      expect(transcribed().slice(0, 2)).toEqual(["library/a.mp3", "C:/media/talk.mp4"]);
      for (let i = 0; i < 3; i++) await release();
      expect(transcribed()).toEqual([
        "library/a.mp3",
        "C:/media/talk.mp4",
        "library/b.mp3",
        "library/c.mp3",
      ]);
      c.dispose();
    });

    it("transcribes in the language the look asked for", async () => {
      const { c, release } = await busy();
      prioritizeTranscript("C:/p", "C:/media/charla.mp4", "es");
      await release();
      await settle(() => ensureTranscript.mock.calls.length >= 2);
      const call = ensureTranscript.mock.calls[1] as unknown[];
      expect(call[1]).toBe("C:/media/charla.mp4");
      expect(call[3]).toBe("es"); // ensureTranscript(ctx, ref, size, language)
      c.dispose();
    });

    it("moves a queued file forward instead of queueing it twice, and never re-queues the running one", async () => {
      const { c, release } = await busy();
      expect(prioritizeTranscript("C:/p", "library/c.mp3", "")).toBe(true);
      expect(prioritizeTranscript("C:/p", "library/a.mp3", "")).toBe(true); // running now
      for (let i = 0; i < 4; i++) await release();
      expect(transcribed()).toEqual(["library/a.mp3", "library/c.mp3", "library/b.mp3"]);
      c.dispose();
    });

    it("refuses once the project is closed, and a reopened project's queue is the one reached", async () => {
      const old = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      const reopened = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      old.dispose(); // the old session finishes closing AFTER the reopen
      expect(prioritizeTranscript("C:/p", "C:/media/talk.mp4", "")).toBe(true);
      await settle(() => ensureTranscript.mock.calls.length > 0);
      expect(transcribed()).toEqual(["C:/media/talk.mp4"]);
      reopened.dispose();
      expect(prioritizeTranscript("C:/p", "C:/media/other.mp4", "")).toBe(false);
      expect(prioritizeTranscript("C:/elsewhere", "C:/media/talk.mp4", "")).toBe(false);
    });
  });

  // 4h: get_transcript hands the background only the stretches of a file the clips play.
  it("transcribes a window it is handed as that window, apart from the whole file, once", async () => {
    runWhisper.mockReset();
    runWhisper.mockResolvedValue({});
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    const talk = "C:/media/talk.mp4";
    const window = { start: 59, end: 91 };
    const asks: Array<[string, string, { start: number; end: number } | undefined]> = [
      [talk, "", window],
      [talk, "", { ...window }], // the same window: the same job
      [talk, "", { start: 10, end: 91 }], // the same end, another start
      [talk, "", { start: 59, end: 120 }], // the same start, another end
      ["library/a.mp3", "", window], // a library path, read where it lies
      [talk, "", undefined], // the whole file: a job of its own
      [talk, "es", undefined], // ...and in each language asked for
      [talk, "de", undefined],
    ];
    for (const [source, language, w] of asks)
      expect(prioritizeTranscript("C:/p", source, language, w)).toBe(true);
    await settle(
      () => runWhisper.mock.calls.length >= 4 && ensureTranscript.mock.calls.length >= 3,
    );
    await new Promise((r) => setTimeout(r, 20));
    const ran = (calls: unknown[][]): string[] => calls.map((k) => JSON.stringify(k)).sort();
    expect(ran(runWhisper.mock.calls.map((k) => [k[1], k[3], k[4]]))).toEqual(
      ran([
        [talk, undefined, window],
        [talk, undefined, { start: 10, end: 91 }],
        [talk, undefined, { start: 59, end: 120 }],
        ["C:/p/library/a.mp3", undefined, window],
      ]),
    );
    expect(
      ran(ensureTranscript.mock.calls.map((k) => [(k as unknown[])[1], (k as unknown[])[3]])),
    ).toEqual(
      ran([
        [talk, undefined],
        [talk, "es"],
        [talk, "de"],
      ]),
    );
    c.dispose();
  });

  // The seen-set is permanent, so indexing a file that does not exist yet burns that asset's
  // ONLY chance at a proxy and a transcript — it would never be retried.
  it("skips media that is still generating, then indexes it once it lands", async () => {
    const store = fakeStore([
      { id: "media_gen_a", path: "library/media_gen_a.mp4", status: "generating" },
    ]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([{ media_ref: "media_gen_a" }]));
    await settle(() => processImportedMedia.mock.calls.length > 0, 60);
    expect(processImportedMedia).not.toHaveBeenCalled();
    expect(ensureTranscript).not.toHaveBeenCalled();

    // It landed: the row loses its status, and the NEXT sweep must pick it up.
    store.listClips = vi.fn(async () => [{ id: "media_gen_a", path: "library/media_gen_a.mp4" }]);
    await c.sweep(tl([{ media_ref: "media_gen_a" }]));
    await settle(() => processImportedMedia.mock.calls.length > 0);
    expect(processImportedMedia).toHaveBeenCalledTimes(1);
    await settle(() => ensureTranscript.mock.calls.length > 0);
    expect(ensureTranscript).toHaveBeenCalledTimes(1);
  });

  // The poster IS the library tile and the timeline thumbnail. Placing a clip must not be
  // what earns one: an asset imported by the agent, generated, or left over when the queue
  // never drained sat in the library with a blank tile forever, because `seen` is permanent
  // and only the timeline loop enqueued the proxy pass.
  it("gives a library video a poster even though it is on NO track", async () => {
    const store = fakeStore([{ id: "media_x", path: "library/media_x.mp4" }]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([])); // empty timeline: nothing placed

    await settle(() => processImportedMedia.mock.calls.length > 0);
    expect(
      processImportedMedia,
      "an unplaced library video must still get its poster pass",
    ).toHaveBeenCalledTimes(1);
  });

  it("does not run the poster pass on audio, which has no frame to extract", async () => {
    const store = fakeStore([{ id: "media_a", path: "library/media_a.wav" }]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([]));
    await settle(() => ensureTranscript.mock.calls.length > 0);
    expect(processImportedMedia).not.toHaveBeenCalled();
    // ...but audio is exactly what the transcript pass exists for.
    expect(transcribed()).toEqual(["library/media_a.wav"]);
  });

  it("never indexes media whose generation failed", async () => {
    const store = fakeStore([
      { id: "media_gen_b", path: "library/media_gen_b.mp3", status: "failed" },
    ]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([{ media_ref: "media_gen_b", kind: "audio" }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(processImportedMedia).not.toHaveBeenCalled();
    expect(ensureTranscript).not.toHaveBeenCalled();
  });

  it("transcribes every audio/video asset and nothing else", async () => {
    const c = new IndexCoordinator(
      fakeStore([
        { id: "m1", path: "library/clip.mp4" },
        { id: "m2", path: "library/song.mp3" },
        { id: "m3", path: "library/still.png" },
      ]),
      makeRunner,
      vi.fn(),
      vi.fn(),
    );

    await c.sweep(tl([]));
    await settle(() => ensureTranscript.mock.calls.length >= 2);
    await new Promise((r) => setTimeout(r, 20));

    expect(transcribed().sort()).toEqual(["library/clip.mp4", "library/song.mp3"]);
  });

  it("transcribes a just-dropped file before it reaches the timeline", async () => {
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/dropped.wav");
    await settle(() => ensureTranscript.mock.calls.length > 0);
    expect(transcribed()).toEqual(["library/dropped.wav"]);
  });

  // whisper maps the whole ~465 MiB model per process. Two at once is the memory profile that
  // took macOS down, arriving by a different door.
  it("never runs two transcriptions at once", async () => {
    let live = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    (ensureTranscript as Any).mockImplementation(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise<void>((r) => gates.push(r));
      live -= 1;
      return { path: "t.json", parsed: {}, existed: false };
    });
    const c = new IndexCoordinator(
      fakeStore([
        { id: "m1", path: "library/a.mp3" },
        { id: "m2", path: "library/b.mp3" },
        { id: "m3", path: "library/c.mp3" },
      ]),
      makeRunner,
      vi.fn(),
      vi.fn(),
    );

    await c.sweep(tl([]));
    for (let i = 0; i < 3; i++) {
      await settle(() => gates.length > 0);
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(peak).toBe(1);
    expect(ensureTranscript).toHaveBeenCalledTimes(3); // serial, but all of them
  });

  // Preview latency beats a background index nobody asked for. Sharing one pool, two queued
  // transcriptions occupied both workers and a poster sat behind minutes of whisper.
  it("starts a poster while transcriptions are still running", async () => {
    let releaseTx!: () => void;
    const txGate = new Promise<void>((r) => (releaseTx = r));
    (ensureTranscript as Any).mockImplementation(async () => {
      await txGate;
      return { path: "t.json", parsed: {}, existed: false };
    });
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());

    c.indexSource("library/one.mp3");
    c.indexSource("library/two.mp3");
    await settle(() => ensureTranscript.mock.calls.length > 0);

    c.indexSource("library/late.mp4");
    await settle(() => processImportedMedia.mock.calls.length > 0);

    expect(processImportedMedia, "the poster must not wait on whisper").toHaveBeenCalledTimes(1);
    releaseTx();
  });

  // A swallowed failure is indistinguishable from footage with no speech, which is how a
  // broken transcriber stayed invisible until a user's first caption request timed out.
  it("reports a transcript failure and retries it on a later sweep, but not forever", async () => {
    (ensureTranscript as Any).mockRejectedValue(new Error("whisper boom"));
    const store = fakeStore([{ id: "m1", path: "library/a.mp3" }]);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([]));
    await settle(() => reportAppError.mock.calls.length > 0);
    expect(String(reportAppError.mock.calls[0][0])).toContain("whisper boom");

    for (let i = 0; i < 4; i++) {
      await c.sweep(tl([]));
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ensureTranscript.mock.calls.length).toBe(3); // MAX_ATTEMPTS, then it gives up
  });

  it("indexes a timeline video for both preview and transcript", async () => {
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => processImportedMedia.mock.calls.length > 0);
    expect(processImportedMedia).toHaveBeenCalledTimes(1);
    await settle(() => ensureTranscript.mock.calls.length > 0);
    expect(transcribed()).toEqual(["library/a.mp4"]);
  });

  // Her footage included silent video. ffmpeg is asked for an audio-only output, says "Output
  // file does not contain any stream" and exits EINVAL -- which read as a broken transcriber.
  it("never transcribes media that has no audio track", async () => {
    sourceHasAudio.mockResolvedValue(false);
    const c = new IndexCoordinator(
      fakeStore([{ id: "m1", path: "library/silent.mp4" }]),
      makeRunner,
      vi.fn(),
      vi.fn(),
    );

    await c.sweep(tl([]));
    await settle(() => sourceHasAudio.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20));

    expect(ensureTranscript).not.toHaveBeenCalled();
    // Nothing to transcribe is not a failure, so it must not be reported or retried.
    expect(reportAppError).not.toHaveBeenCalled();
  });

  it("still transcribes when the audio probe cannot answer", async () => {
    sourceHasAudio.mockRejectedValue(new Error("ffprobe exploded"));
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/a.mp3");
    await settle(() => ensureTranscript.mock.calls.length > 0);
    expect(transcribed()).toEqual(["library/a.mp3"]);
  });

  // A machine missing the VC++ runtime cannot START whisper. That is the machine's state, not
  // the file's, so per-asset retries just repeat it: one user logged 56 identical failures.
  it("gives up after 3 engine failures and reports once, however many assets are queued", async () => {
    ensureTranscript.mockRejectedValue(new FakeEngineDown("0xC0000135"));
    const clips = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      path: `library/a${i}.mp3`,
    }));
    const c = new IndexCoordinator(fakeStore(clips), makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([]));
    await settle(() => reportAppError.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 30));

    expect(ensureTranscript.mock.calls.length).toBe(3);
    expect(reportAppError).toHaveBeenCalledTimes(1);
    expect(String(reportAppError.mock.calls[0][0])).toMatch(/speech engine unavailable/i);

    // ...and it stays given up: a later sweep must not start the same doomed run again.
    await c.sweep(tl([{ media_ref: "library/late.mp3", kind: "audio" }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(ensureTranscript.mock.calls.length).toBe(3);
    // The speech engine says nothing about loudness: every file is still measured.
    await settle(() => measureLoudness.mock.calls.length >= 13);
    expect(measureLoudness).toHaveBeenCalledTimes(13);
  });

  // The opposite direction. Giving up is only right when the ENGINE cannot start; a file that
  // fails on its own (corrupt audio, a bad codec) says nothing about the next one. However many
  // of those pile up, every queued asset must still be attempted.
  it("never gives up on ordinary per-file failures, however many there are", async () => {
    const clips = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      path: `library/bad${i}.mp3`,
    }));
    ensureTranscript.mockImplementation((async (_ctx: unknown, src: string) => {
      if (src.includes("bad")) throw new Error("whisper-cli failed (code=1): invalid data");
      return { path: "t.json", parsed: { segments: [] }, existed: false };
    }) as never);
    const c = new IndexCoordinator(fakeStore(clips), makeRunner, vi.fn(), vi.fn());

    await c.sweep(tl([]));
    await settle(() => ensureTranscript.mock.calls.length >= 12);
    c.indexSource("library/good.mp3");
    await settle(() => transcribed().includes("library/good.mp3"));

    expect(transcribed()).toHaveLength(13);
    const disabled = reportAppError.mock.calls.some((c) =>
      /speech engine unavailable/i.test(String(c[0])),
    );
    expect(disabled).toBe(false);
  });

  // Gaps mutation testing found (2026-09-27).
  it("an engine failure that lands after the project closed disables and reports nothing", async () => {
    let fail!: (e: unknown) => void;
    ensureTranscript.mockImplementation((() => new Promise((_res, rej) => (fail = rej))) as never);
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    for (let i = 0; i < 3; i++) c.indexSource(`library/a${i}.mp3`);
    await settle(() => ensureTranscript.mock.calls.length > 0);
    c.dispose();
    for (let i = 0; i < 3; i++) fail(new FakeEngineDown("0xC0000135"));
    await new Promise((r) => setTimeout(r, 30));
    expect(reportAppError).not.toHaveBeenCalled();
  });

  // A ref the store cannot resolve must still be handed to the transcriber, whose own error
  // names the missing file — probing it for audio first would hide that as "no audio".
  it("still attempts a source whose path cannot be resolved, so its real error surfaces", async () => {
    const store = fakeStore();
    store.resolveRef.mockResolvedValue(null);
    sourceHasAudio.mockResolvedValue(false);
    const c = new IndexCoordinator(store, makeRunner, vi.fn(), vi.fn());
    c.indexSource("library/missing.mp3");
    await settle(() => ensureTranscript.mock.calls.length > 0);
    expect(transcribed()).toEqual(["library/missing.mp3"]);
  });

  // UJ-014: a linked file the user moved or deleted is OFFLINE, not a failure. The user's indexer
  // failed on one twice in 43 minutes and reported each time. The library panel already shows it
  // offline with Relink, so the indexer's part is to stay out of the way: no attempt, no report,
  // and no attempt counted against it.
  describe("an offline linked file (UJ-014)", () => {
    const GONE = "D:/Downloads/gone.mp3";
    const lib = [{ id: "m1", path: GONE }];

    it("is never attempted or reported, however many sweeps pass", async () => {
      const c = new IndexCoordinator(fakeStore(lib, new Set([GONE])), makeRunner, vi.fn(), vi.fn());
      for (let i = 0; i < 4; i++) {
        await c.sweep(tl([{ media_ref: "m1", kind: "audio" }]));
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(ensureTranscript).not.toHaveBeenCalled();
      expect(processImportedMedia).not.toHaveBeenCalled();
      expect(measureLoudness).not.toHaveBeenCalled();
      expect(reportAppError).not.toHaveBeenCalled();
    });

    // The other half: parked is not forgotten. Relink, or the drive coming back, re-sweeps.
    it("is indexed once its file is back, with its full count of tries", async () => {
      const offline = new Set([GONE]);
      ensureTranscript.mockRejectedValue(new Error("whisper boom"));
      const c = new IndexCoordinator(fakeStore(lib, offline), makeRunner, vi.fn(), vi.fn());
      for (let i = 0; i < 3; i++) {
        await c.sweep(tl([]));
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(ensureTranscript).not.toHaveBeenCalled();

      offline.delete(GONE);
      for (let i = 0; i < 4; i++) {
        await c.sweep(tl([]));
        await new Promise((r) => setTimeout(r, 10));
      }
      // Its parked sweeps cost it nothing: it still gets every try a present file gets.
      expect(transcribed()).toEqual([GONE, GONE, GONE]);
    });

    // A file that vanishes BETWEEN the sweep and the run is the same fact, found later.
    it("is parked, not failed, when it goes missing while queued", async () => {
      const offline = new Set<string>();
      let release!: () => void;
      ensureTranscript.mockImplementationOnce((async () => {
        await new Promise<void>((r) => (release = r));
        return { path: "t.json", parsed: {}, existed: false };
      }) as never);
      const clips = [{ id: "m0", path: "D:/first.mp3" }, ...lib];
      const c = new IndexCoordinator(fakeStore(clips, offline), makeRunner, vi.fn(), vi.fn());
      await c.sweep(tl([]));
      await settle(() => ensureTranscript.mock.calls.length > 0);
      offline.add(GONE); // gone while it waited its turn
      release();
      await new Promise((r) => setTimeout(r, 30));

      expect(transcribed()).toEqual(["D:/first.mp3"]);
      expect(reportAppError).not.toHaveBeenCalled();
      offline.delete(GONE);
      await c.sweep(tl([]));
      await settle(() => transcribed().includes(GONE));
      expect(transcribed()).toEqual(["D:/first.mp3", GONE]);
    });

    // A video goes through the proxy pass too, which parks it the same way.
    it("parks a video's proxy pass too, and makes its proxy once the file is back", async () => {
      const VIDEO = "D:/Downloads/gone.mp4";
      const offline = new Set([VIDEO]);
      const c = new IndexCoordinator(
        fakeStore([{ id: "v1", path: VIDEO }], offline),
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      for (let i = 0; i < 3; i++) {
        await c.sweep(tl([{ media_ref: "v1", kind: "video" }]));
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(processImportedMedia).not.toHaveBeenCalled();
      expect(reportAppError).not.toHaveBeenCalled();

      offline.delete(VIDEO);
      await c.sweep(tl([{ media_ref: "v1", kind: "video" }]));
      await settle(() => processImportedMedia.mock.calls.length > 0);
      expect(processImportedMedia.mock.calls.map((k) => (k as unknown[])[2])).toEqual([VIDEO]);
    });

    // Gone DURING the run: the transcriber fails on it, and that failure is the same fact.
    it("does not report a run that failed because its file went offline mid-run", async () => {
      const offline = new Set<string>();
      let vanished = false;
      ensureTranscript.mockImplementation((async (_ctx: unknown, src: string) => {
        if (src === GONE && !vanished) {
          vanished = true;
          offline.add(GONE);
          throw new Error(`ENOENT: no such file or directory, open '${GONE}'`);
        }
        return { path: "t.json", parsed: {}, existed: false };
      }) as never);
      const c = new IndexCoordinator(fakeStore(lib, offline), makeRunner, vi.fn(), vi.fn());
      await c.sweep(tl([]));
      await settle(() => transcribed().length > 0);
      await new Promise((r) => setTimeout(r, 30));
      expect(reportAppError).not.toHaveBeenCalled();

      offline.delete(GONE);
      await c.sweep(tl([]));
      await settle(() => transcribed().length > 1);
      expect(transcribed()).toEqual([GONE, GONE]);
    });
  });

  it("the engine-down report carries the END of the error, where the NTSTATUS is", async () => {
    const long = `${"x".repeat(400)} exit code 0xC0000135`;
    ensureTranscript.mockRejectedValue(new FakeEngineDown(long));
    const clips = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, path: `library/a${i}.mp3` }));
    const c = new IndexCoordinator(fakeStore(clips), makeRunner, vi.fn(), vi.fn());
    await c.sweep(tl([]));
    await settle(() => reportAppError.mock.calls.length > 0);
    const msg = String(reportAppError.mock.calls[0][0]);
    expect(msg).toMatch(/0xC0000135$/);
    expect(msg.length).toBeLessThan(260);
  });

  it("clears the URL cache + bumps the preview when a new proxy lands", async () => {
    processImportedMedia.mockResolvedValue(true);
    const onProxy = vi.fn();
    const c = new IndexCoordinator(fakeStore(), makeRunner, onProxy, vi.fn());
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => onProxy.mock.calls.length > 0);
    expect(clearSourceUrlCache).toHaveBeenCalled();
    expect(onProxy).toHaveBeenCalled();
  });

  it("toggles the importing overlay around a proxy transcode", async () => {
    const setImporting = vi.fn();
    (processImportedMedia as Any).mockImplementation(
      async (_s: Any, _r: Any, _src: Any, mark?: () => void) => {
        mark?.();
        return true;
      },
    );
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), setImporting);
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => setImporting.mock.calls.length >= 2);
    expect(setImporting).toHaveBeenNthCalledWith(1, true);
    expect(setImporting).toHaveBeenLastCalledWith(false);
  });

  it("indexes previewable library assets off the timeline and dedups repeat sweeps", async () => {
    const c = new IndexCoordinator(
      fakeStore([{ path: "library/lib.mp4" }]),
      makeRunner,
      vi.fn(),
      vi.fn(),
    );
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => processImportedMedia.mock.calls.length >= 2);
    await c.sweep(tl([{ media_ref: "library/a.mp4" }])); // same media -> no new work
    await new Promise((r) => setTimeout(r, 20));
    expect(processImportedMedia).toHaveBeenCalledTimes(2); // timeline + library video
  });

  it("skips the proxy for audio-only clips and no-ops after dispose", async () => {
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    await c.sweep(tl([{ media_ref: "library/song.mp3", kind: "audio" }]));
    await settle(() => ensureTranscript.mock.calls.length > 0);
    expect(processImportedMedia).not.toHaveBeenCalled();
    c.dispose();
    c.indexSource("library/b.mp4");
    await new Promise((r) => setTimeout(r, 20));
    expect(processImportedMedia).not.toHaveBeenCalled();
    expect(transcribed()).toEqual(["library/song.mp3"]);
  });

  // 4g (owner decision 2026-10-04): every file with sound is measured whole in the background, so a
  // look at a long file finds its loudness kept; a look at a long uncached span is measured next.
  describe("loudness, measured in the background (4g)", () => {
    /** A coordinator whose measurements wait at a gate, with the first one already running. */
    async function busy(): Promise<{ c: IndexCoordinator; gates: Array<() => void> }> {
      const gates: Array<() => void> = [];
      measureLoudness.mockImplementation(async () => {
        await new Promise<void>((r) => gates.push(r));
        return FIGURES;
      });
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      for (const s of ["library/a.mp3", "library/b.mp3"]) c.indexSource(s);
      await settle(() => gates.length > 0);
      return { c, gates };
    }

    it("measures every audio and video file whole, once, and nothing else", async () => {
      const c = new IndexCoordinator(
        fakeStore([
          { id: "m1", path: "library/clip.mp4" },
          { id: "m2", path: "library/song.mp3" },
          { id: "m3", path: "library/still.png" },
        ]),
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      await c.sweep(tl([]));
      await settle(() => measureLoudness.mock.calls.length >= 2);
      await c.sweep(tl([{ media_ref: "m1" }]));
      await new Promise((r) => setTimeout(r, 20));
      expect(measured().sort()).toEqual([
        ["C:/p/library/clip.mp4", null, null],
        ["C:/p/library/song.mp3", null, null],
      ]);
      c.dispose();
    });

    it("measures a file the moment it is imported", async () => {
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      c.indexSource("library/dropped.wav");
      await settle(() => measureLoudness.mock.calls.length > 0);
      expect(measured()).toEqual([["C:/p/library/dropped.wav", null, null]]);
      c.dispose();
    });

    it("never measures a file with no sound, and does not call that a failure", async () => {
      sourceHasAudio.mockResolvedValue(false);
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      c.indexSource("library/silent.mp4");
      await settle(() => sourceHasAudio.mock.calls.length >= 2);
      await new Promise((r) => setTimeout(r, 20));
      expect(measureLoudness).not.toHaveBeenCalled();
      expect(reportAppError).not.toHaveBeenCalled();
      c.dispose();
    });

    it("measures one file at a time", async () => {
      const { c, gates } = await busy();
      c.indexSource("library/c.mp3");
      for (let i = 0; i < 3; i++) {
        expect(gates).toHaveLength(1);
        gates.shift()!();
        await settle(() => gates.length > 0, 200);
      }
      expect(measured().map((m) => m[0])).toEqual([
        "C:/p/library/a.mp3",
        "C:/p/library/b.mp3",
        "C:/p/library/c.mp3",
      ]);
      c.dispose();
    });

    it("runs a look's span next, and hands the look the figures once it has run", async () => {
      const { c, gates } = await busy();
      const look = backgroundLoudness("C:/p", "C:/media/talk.mp4", 0, 900)!;
      expect(look.first).toBe(true);
      // Asked again before it ran: the same measurement, which the second look waits on.
      const queued = backgroundLoudness("C:/p", "C:/media/talk.mp4", 0, 900)!;
      expect([queued.first, queued.result === look.result]).toEqual([false, true]);
      gates.shift()!();
      await settle(() => measureLoudness.mock.calls.length >= 2);
      expect(measured()[1]).toEqual(["C:/media/talk.mp4", 0, 900]);
      // ...and again while it runs.
      const running = backgroundLoudness("C:/p", "C:/media/talk.mp4", 0, 900)!;
      expect([running.first, running.result === look.result]).toEqual([false, true]);
      expect(gates).toHaveLength(1); // still one measurement at a time
      gates.shift()!();
      expect(await look.result).toEqual(FIGURES);
      await settle(() => gates.length > 0);
      gates.shift()!();
      expect(measured().map((m) => m[0])).toEqual([
        "C:/p/library/a.mp3",
        "C:/media/talk.mp4",
        "C:/p/library/b.mp3",
      ]);
      c.dispose();
    });

    it("hands a failure to the look waiting on it, reports it, and retries it boundedly", async () => {
      const boom = { error: "loudness could not be measured: boom" };
      measureLoudness.mockResolvedValue(boom);
      const c = new IndexCoordinator(
        fakeStore([{ id: "m1", path: "library/a.mp3" }]),
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      expect(await backgroundLoudness("C:/p", "C:/media/talk.mp4", null, null)!.result).toEqual(
        boom,
      );
      for (let i = 0; i < 4; i++) {
        await c.sweep(tl([]));
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(measured().filter((m) => m[0] === "C:/p/library/a.mp3")).toHaveLength(3);
      const reports = reportAppError.mock.calls.map((k) => String(k[0]));
      expect(reports.some((m) => /index loudness failed/.test(m) && m.includes("boom"))).toBe(true);
      c.dispose();
    });

    it("settles every waiting look when the project closes, and measures nothing more", async () => {
      const { c, gates } = await busy();
      const look = backgroundLoudness("C:/p", "C:/media/talk.mp4", null, null)!;
      c.dispose();
      expect(await look.result).toEqual({ error: expect.stringMatching(/closed/) });
      expect(backgroundLoudness("C:/p", "C:/media/talk.mp4", null, null)).toBeNull();
      expect(c.measureSoon("C:/media/talk.mp4", null, null)).toBeNull();
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 20));
      expect(measureLoudness).toHaveBeenCalledTimes(1);
      expect(reportAppError).not.toHaveBeenCalled();
    });

    it("measures each span of a file on its own, never one for another", async () => {
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      const spans: Array<[number | null, number | null]> = [
        [0, 900],
        [0, 1800],
        [900, 1800],
        [300, null],
        [null, null],
      ];
      const looks = spans.map(([a, b]) => backgroundLoudness("C:/p", "C:/media/talk.mp4", a, b)!);
      expect(looks.map((l) => l.first)).toEqual([true, true, true, true, true]);
      await Promise.all(looks.map((l) => l.result));
      expect(
        measured()
          .map((m) => [m[1], m[2]])
          .sort(),
      ).toEqual(spans.slice().sort());
      c.dispose();
    });

    // A LINKED file's catalog path is its absolute path, so the sweep's whole-file job and a look
    // at the whole file are the same job.
    it("a look at a whole file the sweep is measuring waits on that run, not a second one", async () => {
      const LINKED = "D:/media/long.mp3";
      const gates: Array<() => void> = [];
      measureLoudness.mockImplementation(async () => {
        await new Promise<void>((r) => gates.push(r));
        return FIGURES;
      });
      const c = new IndexCoordinator(
        fakeStore([{ id: "m1", path: LINKED }]),
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      await c.sweep(tl([]));
      await settle(() => gates.length > 0);
      const look = backgroundLoudness("C:/p", LINKED, null, null)!;
      expect(look.first).toBe(true);
      gates.shift()!();
      expect(await look.result).toEqual(FIGURES);
      await new Promise((r) => setTimeout(r, 20));
      expect(measured()).toEqual([[LINKED, null, null]]);
      c.dispose();
    });

    it("a look at a whole file the sweep has queued moves it forward, not a copy of it", async () => {
      const gates: Array<() => void> = [];
      measureLoudness.mockImplementation(async () => {
        await new Promise<void>((r) => gates.push(r));
        return FIGURES;
      });
      const lib = ["D:/a.mp3", "D:/b.mp3", "D:/c.mp3"].map((path, i) => ({ id: `m${i}`, path }));
      const c = new IndexCoordinator(fakeStore(lib), makeRunner, vi.fn(), vi.fn());
      await c.sweep(tl([]));
      await settle(() => gates.length > 0); // a runs; b is next, then c
      for (const next of ["D:/b.mp3", "D:/c.mp3"])
        expect(backgroundLoudness("C:/p", next, null, null)!.first).toBe(true);
      for (let i = 0; i < 4; i++) {
        gates.shift()?.();
        await settle(() => gates.length > 0, 100);
      }
      expect(measured().map((m) => m[0])).toEqual(["D:/a.mp3", "D:/c.mp3", "D:/b.mp3"]);
      c.dispose();
    });

    it("tells the look why a file was not measured: offline, or no sound", async () => {
      const offline = new Set(["D:/gone.mp3"]);
      const c = new IndexCoordinator(fakeStore([], offline), makeRunner, vi.fn(), vi.fn());
      expect(await backgroundLoudness("C:/p", "D:/gone.mp3", null, null)!.result).toEqual({
        error: expect.stringMatching(/offline/),
      });
      sourceHasAudio.mockResolvedValue(false);
      expect(await backgroundLoudness("C:/p", "D:/mute.mp4", null, null)!.result).toEqual({
        error: expect.stringMatching(/no sound/),
      });
      expect(measureLoudness).not.toHaveBeenCalled();
      expect(reportAppError).not.toHaveBeenCalled();
      c.dispose();
    });

    it("a measurement that throws reaches the look and is reported", async () => {
      measureLoudness.mockRejectedValue(new Error("kaboom"));
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      expect(await backgroundLoudness("C:/p", "D:/a.mp3", null, null)!.result).toEqual({
        error: expect.stringContaining("kaboom"),
      });
      expect(String(reportAppError.mock.calls[0]?.[0])).toMatch(/index loudness failed.*kaboom/);
      c.dispose();
    });

    // The web build has no runner. A look must hear so, not wait on a queue nothing drains; and a
    // runner that comes back later measures what is asked then.
    it("answers a look when there is no runner, and measures once there is one", async () => {
      let runnerUp = false;
      const c = new IndexCoordinator(
        fakeStore(),
        async () => {
          if (!runnerUp) throw new Error("no runner here");
          return runner;
        },
        vi.fn(),
        vi.fn(),
      );
      expect(await backgroundLoudness("C:/p", "D:/a.mp3", null, null)!.result).toEqual({
        error: expect.stringMatching(/cannot be measured/),
      });
      runnerUp = true;
      expect(await backgroundLoudness("C:/p", "D:/a.mp3", null, null)!.result).toEqual(FIGURES);
      c.dispose();
    });

    // The editor and the agent's tool host name the same project's folder in either slash, with or
    // without a trailing one.
    it("is reached by its project's folder however the folder is written", async () => {
      const c = new IndexCoordinator(
        { ...fakeStore(), projectDir: "C:\\p\\\\" },
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      expect(await backgroundLoudness("C:/p", "D:/a.mp3", null, null)!.result).toEqual(FIGURES);
      c.dispose();
    });
  });

  it("dispose() aborts the IN-FLIGHT proxy job, not just the queue", async () => {
    let captured: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (processImportedMedia as Any).mockImplementation(
      async (_s: Any, _r: Any, _src: Any, _mark: Any, signal?: AbortSignal) => {
        captured = signal;
        await gate; // stay in-flight (like a running ffmpeg) until released
        return false;
      },
    );
    const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
    await c.sweep(tl([{ media_ref: "library/a.mp4" }]));
    await settle(() => captured !== undefined);
    expect(captured?.aborted).toBe(false); // running, not yet disposed
    c.dispose();
    expect(captured?.aborted).toBe(true); // dispose kills the in-flight process' signal
    release();
    await new Promise((r) => setTimeout(r, 0)); // let the drain unwind
  });

  // 4i, Palmier's close (owner decision 2026-10-04): the file in progress finishes, into the app
  // cache; the queue behind it is dropped. Only the proxy, which writes into the project, is stopped.
  describe("closing the project (4i)", () => {
    const stopped = (signals: Array<AbortSignal | undefined>): boolean[] =>
      signals.map((s) => s?.aborted ?? false);

    it("lets the transcription in progress run to its end, and starts nothing queued behind it", async () => {
      const gates: Array<() => void> = [];
      const signals: Array<AbortSignal | undefined> = [];
      (ensureTranscript as Any).mockImplementation(async (ctx: Any) => {
        signals.push(ctx.signal);
        await new Promise<void>((r) => gates.push(r));
        return { path: "t.json", parsed: {}, existed: false };
      });
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      for (const s of ["library/a.mp3", "library/b.mp3"]) c.indexSource(s);
      await settle(() => gates.length > 0);
      c.dispose();
      expect(stopped(signals)).toEqual([false]);
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 20));
      expect(transcribed()).toEqual(["library/a.mp3"]);
      expect(stopped(signals)).toEqual([false]);
      expect(reportAppError).not.toHaveBeenCalled();
    });

    it("lets a window a look handed it run to its end too", async () => {
      runWhisper.mockReset();
      const gates: Array<() => void> = [];
      const signals: Array<AbortSignal | undefined> = [];
      runWhisper.mockImplementation(async (ctx: Any) => {
        signals.push(ctx.signal);
        await new Promise<void>((r) => gates.push(r));
        return {};
      });
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      prioritizeTranscript("C:/p", "C:/media/talk.mp4", "", { start: 59, end: 91 });
      prioritizeTranscript("C:/p", "C:/media/talk.mp4", "", { start: 300, end: 330 });
      await settle(() => gates.length > 0);
      c.dispose();
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 20));
      expect(stopped(signals)).toEqual([false]);
      expect(runWhisper).toHaveBeenCalledTimes(1);
    });

    it("lets the loudness measurement in progress run to its end, and starts nothing queued behind it", async () => {
      const gates: Array<() => void> = [];
      const signals: Array<AbortSignal | undefined> = [];
      (measureLoudness as Any).mockImplementation(async (ctx: Any) => {
        signals.push(ctx.signal);
        await new Promise<void>((r) => gates.push(r));
        return FIGURES;
      });
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      for (const s of ["library/a.mp3", "library/b.mp3"]) c.indexSource(s);
      await settle(() => gates.length > 0);
      c.dispose();
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 20));
      expect(stopped(signals)).toEqual([false]);
      expect(measured().map((m) => m[0])).toEqual(["C:/p/library/a.mp3"]);
    });

    it("says nothing when the transcription in progress fails after the close", async () => {
      let fail!: (e: Error) => void;
      (ensureTranscript as Any).mockImplementation(
        () => new Promise((_r, reject) => (fail = reject)),
      );
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      c.indexSource("library/a.mp3");
      await settle(() => fail !== undefined);
      c.dispose();
      fail(new Error("whisper-cli failed (code=1)"));
      await new Promise((r) => setTimeout(r, 20));
      expect(reportAppError).not.toHaveBeenCalled();
    });
  });

  // 4i: the indexer's work takes turns app-wide (workGate.ts): nothing starts while an export is
  // queued or running, and one transcription at a time across every project.
  describe("taking turns (4i)", () => {
    const counts = (): number[] => [
      ensureTranscript.mock.calls.length,
      measureLoudness.mock.calls.length,
    ];

    it("starts no transcription or measurement while an export runs, and both once it ends", async () => {
      setExportsBusy(true);
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      c.indexSource("library/a.mp3");
      await new Promise((r) => setTimeout(r, 20));
      expect(counts()).toEqual([0, 0]);
      setExportsBusy(false);
      await settle(() => counts().every((n) => n > 0));
      expect(counts()).toEqual([1, 1]);
      // Handed over as background work: its whisper does not queue among the looks'.
      expect((ensureTranscript.mock.calls[0] as Any[])[0].background).toBe(true);
      expect((measureLoudness.mock.calls[0] as Any[])[0].background).toBe(true);
      c.dispose();
    });

    it("drops a job still waiting for its turn when the project closes", async () => {
      setExportsBusy(true);
      const c = new IndexCoordinator(fakeStore(), makeRunner, vi.fn(), vi.fn());
      c.indexSource("library/a.mp3");
      prioritizeTranscript("C:/p", "C:/media/talk.mp4", "", { start: 59, end: 91 });
      await new Promise((r) => setTimeout(r, 10));
      c.dispose();
      setExportsBusy(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(counts()).toEqual([0, 0]);
      expect(runWhisper).not.toHaveBeenCalled();
    });

    it("runs one transcription at a time across two projects, a closed one's included", async () => {
      const gates: Array<() => void> = [];
      (ensureTranscript as Any).mockImplementation(async () => {
        await new Promise<void>((r) => gates.push(r));
        return { path: "t.json", parsed: {}, existed: false };
      });
      const a = new IndexCoordinator(
        { ...fakeStore(), projectDir: "C:/a" },
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      const b = new IndexCoordinator(
        { ...fakeStore(), projectDir: "C:/b" },
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      a.indexSource("library/a.mp3");
      await settle(() => gates.length > 0);
      a.dispose(); // its transcription in progress runs on, and keeps the turn
      b.indexSource("library/b.mp3");
      await new Promise((r) => setTimeout(r, 20));
      expect(transcribed()).toEqual(["library/a.mp3"]);
      gates.shift()!();
      await settle(() => gates.length > 0);
      expect(transcribed()).toEqual(["library/a.mp3", "library/b.mp3"]);
      gates.shift()!();
      b.dispose();
    });

    it("measures one file at a time across two projects", async () => {
      const gates: Array<() => void> = [];
      (measureLoudness as Any).mockImplementation(async () => {
        await new Promise<void>((r) => gates.push(r));
        return FIGURES;
      });
      const a = new IndexCoordinator(
        { ...fakeStore(), projectDir: "C:/a" },
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      const b = new IndexCoordinator(
        { ...fakeStore(), projectDir: "C:/b" },
        makeRunner,
        vi.fn(),
        vi.fn(),
      );
      a.indexSource("library/a.mp3");
      await settle(() => gates.length > 0);
      // Started once the first is measuring (two projects never load the indexer's modules at the
      // same moment: see `ready`).
      b.indexSource("library/b.mp3");
      await new Promise((r) => setTimeout(r, 20));
      expect(gates).toHaveLength(1);
      gates.shift()!();
      await settle(() => gates.length > 0);
      expect(measured().map((m) => m[0])).toEqual(["C:/p/library/a.mp3", "C:/p/library/b.mp3"]);
      gates.shift()!();
      a.dispose();
      b.dispose();
    });
  });
});
