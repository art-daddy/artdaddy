import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addCaptionsTool } from "./captions";
import { CACHE_READ_FLOOR_MS, pendingCaptionsResult } from "./captionTranscript";
import type { ClientToolContext } from "./context";
import { joinPath } from "./store";
import {
  ensureTranscript,
  parseWhisperCppJson,
  transcribeSpan,
  TRANSCRIPT_WAIT_MS,
} from "./transcribe";
import { __resetExportFlags, __setExportFlag } from "../api/exportFlags";
import { resetLiveWait, useLiveWait } from "../store/liveWait";
import { applyOp, loadTimeline } from "../timeline/engine";
import type { Clip } from "../timeline/model";
import { CachingMemFs, DIR, resetTestDocuments, seededCtx as kitCtx } from "../test/timelineKit";

// The real transcriber, except where a test says a transcription never finishes.
vi.mock("./transcribe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcribe")>();
  return {
    ...actual,
    ensureTranscript: vi.fn(actual.ensureTranscript),
    transcribeSpan: vi.fn(actual.transcribeSpan),
  };
});
// Loaded before any test turns the clock off: loading a module needs it running.
const actual = await vi.importActual<typeof import("./transcribe")>("./transcribe");

type Any = Record<string, unknown>;
const seededCtx = () => kitCtx(undefined, DIR, new CachingMemFs());

/** The transcript cache slot for `ref`, filled with whisper's own JSON, so the real
 *  transcriber finds it and never shells out. */
async function seedTranscript(
  ctx: ClientToolContext,
  ref: string,
  words: Array<[string, number, number]>,
): Promise<void> {
  const { transcriptCacheSlot } = await import("./transcribe");
  const src = await ctx.store.resolveRef(ref);
  const slot = await transcriptCacheSlot(ctx, String(src), "small", undefined);
  const cache = await ctx.store.appCache();
  if (!src || !slot.key || !cache) throw new Error(`cannot seed a transcript for ${ref}`);
  const ms = (s: number): number => Math.round(s * 1000);
  await cache.put(slot.namespace, slot.key, {
    result: { language: "en" },
    transcription: [
      {
        offsets: { from: ms(words[0][1]), to: ms(words[words.length - 1][2]) },
        text: words.map(([w]) => ` ${w}`).join(""),
        tokens: words.map(([w, start, end]) => ({
          text: ` ${w}`,
          offsets: { from: ms(start), to: ms(end) },
          p: 1,
        })),
      },
    ],
  });
}

async function withAudio(ctx: ClientToolContext, ref: string, trackId: string): Promise<void> {
  await ctx.store.writeText(joinPath(DIR, ref), "fake-media");
  await applyOp(ctx.store, "seed", (tl) => {
    tl.tracks.push({
      id: trackId,
      kind: "audio",
      z: tl.tracks.length,
      clips: [
        {
          id: `au-${trackId}`,
          kind: "audio",
          media_ref: ref,
          timeline_in: 0,
          timeline_out: 300,
          source_in: 0,
          source_out: 300,
        } as Clip,
      ],
    });
  });
}

const captionClips = async (ctx: ClientToolContext): Promise<Clip[]> =>
  ((await loadTimeline(ctx.store)).tracks ?? [])
    .flatMap((t) => t.clips ?? [])
    .filter((c) => c.kind === "text");

const SPEECH: Array<[string, number, number]> = [
  ["hello", 0.2, 0.6],
  ["there", 0.7, 1.1],
  ["captions", 1.3, 1.9],
];

// A transcription that has not finished, whatever is slow underneath it (a long file, a machine
// with no GPU, the speech model still downloading).
const neverFinishes = (): Promise<never> => new Promise<never>(() => undefined);

describe("add_captions waits for words only as long as get_transcript does", () => {
  beforeEach(async () => {
    await resetTestDocuments();
    resetLiveWait();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("tells the chat it is waiting for speech while it waits, so the line says so, and not after", async () => {
    const { ctx } = await seededCtx();
    await withAudio(ctx, "library/talk.m4a", "a1");
    vi.mocked(transcribeSpan).mockImplementationOnce(neverFinishes);
    const waiting = (): string[] => useLiveWait.getState().speechWaits.map((w) => w.tool);

    let answer: Any | undefined;
    void addCaptionsTool({}, ctx).then((r) => (answer = r as Any));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(answer).toBeUndefined();
    expect(waiting()).toEqual(["add_captions"]);

    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS);
    expect(answer).toMatchObject({ pending: true });
    expect(waiting()).toEqual([]);
  });

  it("answers within the limit with what is pending, adds nothing, and the next call finishes the job", async () => {
    const { ctx } = await seededCtx();
    await withAudio(ctx, "library/talk.m4a", "a1");
    vi.mocked(transcribeSpan).mockImplementationOnce(neverFinishes);

    let answer: Any | undefined;
    void addCaptionsTool({}, ctx).then((r) => (answer = r as Any));
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS - 1);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(answer).toMatchObject({
      ok: false,
      pending: true,
      status: "in_progress",
      in_progress: [{ clip_id: "au-a1", track_id: "a1" }],
    });
    expect(String(answer?.error)).toMatch(/NOT added/);
    expect(String(answer?.error)).toMatch(/call add_captions again/);
    expect(await captionClips(ctx)).toEqual([]);

    // The words are made meanwhile; the same call now places the captions at once.
    await seedTranscript(ctx, "library/talk.m4a", SPEECH);
    const second = (await addCaptionsTool({}, ctx)) as Any;
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect((await captionClips(ctx)).length).toBeGreaterThan(0);
  });

  it("spends the limit once for the whole call, however many clips are waiting", async () => {
    const { ctx } = await seededCtx();
    for (const [i, ref] of ["a.m4a", "b.m4a", "c.m4a"].entries())
      await withAudio(ctx, `library/${ref}`, `a${i + 1}`);
    vi.mocked(transcribeSpan).mockImplementation(neverFinishes);

    const started = Date.now();
    let answer: Any | undefined;
    void addCaptionsTool({}, ctx).then((r) => (answer = r as Any));
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS + 3 * CACHE_READ_FLOOR_MS + 50);
    expect(answer?.pending).toBe(true);
    expect((answer?.in_progress as unknown[]).length).toBe(3);
    // Three waits of a minute each would be three minutes; the limit is one minute in all.
    expect(Date.now() - started).toBeLessThanOrEqual(
      TRANSCRIPT_WAIT_MS + 3 * CACHE_READ_FLOOR_MS + 50,
    );
  });

  it("does not call a cached transcript pending when it sits beside one that is not ready, and places nothing until both are", async () => {
    const { ctx } = await seededCtx();
    await withAudio(ctx, "library/slow.m4a", "a1");
    await withAudio(ctx, "library/ready.m4a", "a2");
    await seedTranscript(ctx, "library/ready.m4a", SPEECH);
    // A read of the cache is real I/O: it takes a little time, and no wait at all would beat it.
    vi.mocked(transcribeSpan).mockImplementation(async (c, ref, window, language, size) => {
      if (String(ref).endsWith("slow.m4a")) return neverFinishes();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return actual.transcribeSpan(c, ref, window, language, size);
    });

    let answer: Any | undefined;
    void addCaptionsTool({}, ctx).then((r) => (answer = r as Any));
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS + 3 * CACHE_READ_FLOOR_MS);
    expect(answer?.in_progress).toEqual([{ clip_id: "au-a1", track_id: "a1" }]);
    expect(answer?.failed).toBeUndefined(); // the ready clip was read, not failed
    expect(await captionClips(ctx)).toEqual([]);

    // Its words are good: asked about on their own, they become captions.
    let alone: Any | undefined;
    void addCaptionsTool({ track_id: "a2" }, ctx).then((r) => (alone = r as Any));
    await vi.advanceTimersByTimeAsync(CACHE_READ_FLOOR_MS);
    expect(alone?.ok, JSON.stringify(alone)).toBe(true);
    expect((await captionClips(ctx)).length).toBeGreaterThan(0);
  });

  it("ends at once when the person presses Stop, and leaves no timer behind", async () => {
    const { ctx } = await seededCtx();
    await withAudio(ctx, "library/talk.m4a", "a1");
    vi.mocked(transcribeSpan).mockImplementationOnce(neverFinishes);
    const stop = new AbortController();

    let answer: Any | undefined;
    void addCaptionsTool({}, { ...ctx, signal: stop.signal }).then((r) => (answer = r as Any));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(answer).toBeUndefined();
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toEqual({ ok: false, error: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    expect(await captionClips(ctx)).toEqual([]);
  });

  it("still reports a transcription that FAILED as a failure with its reason, never as pending or as silence", async () => {
    const { ctx } = await seededCtx();
    await withAudio(ctx, "library/talk.m4a", "a1");
    vi.mocked(transcribeSpan).mockImplementationOnce(async () => {
      throw new Error("the engine fell over");
    });

    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(r.pending).toBeUndefined();
    expect(String(r.error)).toMatch(/transcription failed for all 1 audio clip/);
    expect(String(r.error)).toMatch(/engine fell over/);
  });
});

/** An audio clip on its own track that plays `seconds` of its file from `from`, at the test timeline's 30 fps. */
async function withLongAudio(
  ctx: ClientToolContext,
  ref: string,
  trackId: string,
  seconds: number,
  from = 0,
): Promise<void> {
  await ctx.store.writeText(joinPath(DIR, ref), "fake-media");
  await applyOp(ctx.store, "seed", (tl) => {
    tl.tracks.push({
      id: trackId,
      kind: "audio",
      z: tl.tracks.length,
      clips: [
        {
          id: `au-${trackId}`,
          kind: "audio",
          media_ref: ref,
          timeline_in: 0,
          timeline_out: seconds * 30,
          source_in: from * 30,
          source_out: (from + seconds) * 30,
        } as Clip,
      ],
    });
  });
}

describe("add_captions asks for what the clips play, and says the time first (S2-10, S2-13)", () => {
  beforeEach(async () => {
    await resetTestDocuments();
    resetLiveWait();
    vi.useFakeTimers();
    vi.mocked(transcribeSpan).mockClear();
    vi.mocked(ensureTranscript).mockClear();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    __resetExportFlags();
  });

  it("asks for the stretch the clip plays and a second either side, never the whole file", async () => {
    const { ctx } = await seededCtx();
    // 2 minutes of a file, from its 10-minute mark.
    await withLongAudio(ctx, "library/talk.m4a", "a1", 120, 600);
    vi.mocked(transcribeSpan).mockImplementationOnce(neverFinishes);
    void addCaptionsTool({}, ctx);
    await vi.advanceTimersByTimeAsync(CACHE_READ_FLOOR_MS);
    expect(vi.mocked(transcribeSpan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeSpan).mock.calls[0][2]).toEqual({ start: 599, end: 721 });
    expect(vi.mocked(ensureTranscript)).not.toHaveBeenCalled();
  });

  it("answers a clip longer than this PC can do in ten minutes at once, with the time it will take, and the work goes on", async () => {
    const { ctx } = await seededCtx();
    // 40 minutes of speech: far past ten minutes of work on a PC with no history of its own.
    await withLongAudio(ctx, "library/long.m4a", "a1", 40 * 60);
    vi.mocked(transcribeSpan).mockImplementationOnce(neverFinishes);

    let answer: Any | undefined;
    void addCaptionsTool({}, ctx).then((r) => (answer = r as Any));
    await vi.advanceTimersByTimeAsync(CACHE_READ_FLOOR_MS + 50);

    // Not after the minute every other clip is given: now, so the assistant can tell the person first.
    expect(answer).toMatchObject({ ok: false, pending: true, status: "in_progress" });
    expect(typeof answer?.eta_s).toBe("number");
    expect(Number(answer?.eta_s)).toBeGreaterThan(600);
    expect(String(answer?.error)).toMatch(/tell the user the time/);
    expect(await captionClips(ctx)).toEqual([]);
  });

  it("gives a clip that fits the ordinary minute, not an instant answer", async () => {
    const { ctx } = await seededCtx();
    await withLongAudio(ctx, "library/short.m4a", "a1", 20);
    vi.mocked(transcribeSpan).mockImplementationOnce(neverFinishes);

    let answer: Any | undefined;
    void addCaptionsTool({}, ctx).then((r) => (answer = r as Any));
    await vi.advanceTimersByTimeAsync(CACHE_READ_FLOOR_MS + 50);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS);
    expect(answer).toMatchObject({ pending: true });
  });

  it("makes one window of two clips of one file that overlap once padded, so one run serves both", async () => {
    const { ctx } = await seededCtx();
    await withLongAudio(ctx, "library/talk.m4a", "a1", 10, 100);
    await withLongAudio(ctx, "library/talk.m4a", "a2", 10, 110);
    vi.mocked(transcribeSpan).mockImplementation(neverFinishes);
    void addCaptionsTool({}, ctx);
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS);
    const windows = vi.mocked(transcribeSpan).mock.calls.map((c) => c[2]);
    expect(windows).toEqual([
      { start: 99, end: 121 },
      { start: 99, end: 121 },
    ]);
  });

  it("is 0.27.0 with the remote switch speech_cpu_cap off: the whole file's words, asked for as before", async () => {
    const { ctx } = await seededCtx();
    await withLongAudio(ctx, "library/talk.m4a", "a1", 120, 600);
    __setExportFlag("speech_cpu_cap", false);
    vi.mocked(ensureTranscript).mockImplementationOnce(neverFinishes);
    void addCaptionsTool({}, ctx);
    await vi.advanceTimersByTimeAsync(CACHE_READ_FLOOR_MS);
    expect(vi.mocked(ensureTranscript)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeSpan)).not.toHaveBeenCalled();
  });
});

/** One audio track whose clips play stretches of ONE file: `from` to `to` seconds of it, placed at `at`
 *  seconds of the timeline (30 fps). */
async function withClips(
  ctx: ClientToolContext,
  ref: string,
  trackId: string,
  clips: Array<{ id: string; from: number; to: number; at: number }>,
): Promise<void> {
  await ctx.store.writeText(joinPath(DIR, ref), "fake-media");
  await applyOp(ctx.store, "seed", (tl) => {
    tl.tracks.push({
      id: trackId,
      kind: "audio",
      z: tl.tracks.length,
      clips: clips.map(
        (c) =>
          ({
            id: c.id,
            kind: "audio",
            media_ref: ref,
            timeline_in: c.at * 30,
            timeline_out: (c.at + c.to - c.from) * 30,
            source_in: c.from * 30,
            source_out: c.to * 30,
          }) as Clip,
      ),
    });
  });
}

/** The speech engine's stand-in at the module boundary (below add_captions, above whisper): the file
 *  speaks the word w<k> at second 5k for 80 minutes and the engine hears only the stretch it is asked
 *  for. Returns every stretch that was asked of it, in order. */
function fakeEngine(): Array<[number, number]> {
  const asked: Array<[number, number]> = [];
  const hear = (from: number, to: number) =>
    parseWhisperCppJson(
      JSON.stringify({
        result: { language: "en" },
        transcription: Array.from({ length: 960 }, (_, k) => k * 5)
          .filter((t) => t >= from && t + 0.5 <= to)
          .map((t) => ({
            offsets: { from: t * 1000, to: (t + 0.5) * 1000 },
            text: ` w${t / 5}`,
            tokens: [
              { text: ` w${t / 5}`, offsets: { from: t * 1000, to: (t + 0.5) * 1000 }, p: 0.9 },
            ],
          })),
      }),
    );
  vi.mocked(transcribeSpan).mockImplementation(async (_ctx, _ref, window) => {
    asked.push([window.start, window.end]);
    return { parsed: hear(window.start, window.end), existed: false };
  });
  let whole = false;
  vi.mocked(ensureTranscript).mockImplementation(async () => {
    if (!whole) asked.push([0, 4800]); // the whole file is asked for once, then it is kept
    whole = true;
    return { parsed: hear(0, 4800), existed: false };
  });
  return asked;
}

const cards = async (ctx: ClientToolContext): Promise<Array<[string, number, number]>> =>
  (await captionClips(ctx))
    .map((c): [string, number, number] => [
      (c.content as Array<{ text: string }>).map((r) => r.text).join(" "),
      Number(c.timeline_in),
      Number(c.timeline_out),
    ])
    .sort((a, b) => a[1] - b[1]);

describe("add_captions hands the engine what the clips play, and the captions are the same (S2-10)", () => {
  beforeEach(async () => {
    await resetTestDocuments();
    resetLiveWait();
    vi.mocked(transcribeSpan).mockReset();
    vi.mocked(ensureTranscript).mockReset();
  });
  afterEach(() => __resetExportFlags());

  it("asks for the stretch each clip plays and a second either side, never the file; with the switch off it asks for the whole file as 0.27.0 did, and the captions are identical", async () => {
    const clips = [
      { id: "c1", from: 60, to: 75, at: 0 },
      { id: "c2", from: 600, to: 610, at: 15 },
    ];
    const bySpan = await seededCtx();
    await withClips(bySpan.ctx, "library/talk.m4a", "a1", clips);
    const askedBySpan = fakeEngine();
    const placed = (await addCaptionsTool({}, bySpan.ctx)) as Any;
    expect(placed.ok, JSON.stringify(placed)).toBe(true);
    expect(askedBySpan).toEqual([
      [59, 76],
      [599, 611],
    ]);
    const spanCards = await cards(bySpan.ctx);

    __setExportFlag("speech_cpu_cap", false);
    const whole = await seededCtx();
    await withClips(whole.ctx, "library/talk.m4a", "a1", clips);
    const askedWhole = fakeEngine();
    expect(((await addCaptionsTool({}, whole.ctx)) as Any).ok).toBe(true);
    expect(askedWhole).toEqual([[0, 4800]]);
    // The same captions, word for word and frame for frame, whichever way the words were asked for.
    expect(await cards(whole.ctx)).toEqual(spanCards);
    const said = spanCards.map(([text]) => text);
    expect(said).toEqual(expect.arrayContaining(["w12", "w13", "w14", "w121"]));
    // nothing from outside the stretches the clips play is captioned
    for (const outside of ["w11", "w16", "w119", "w123"]) expect(said).not.toContain(outside);
  });

  it("makes one run for two clips that play neighbouring stretches of one file", async () => {
    const { ctx } = await seededCtx();
    await withClips(ctx, "library/talk.m4a", "a1", [
      { id: "c1", from: 60, to: 70, at: 0 },
      { id: "c2", from: 70, to: 80, at: 10 },
    ]);
    const asked = fakeEngine();
    expect(((await addCaptionsTool({}, ctx)) as Any).ok).toBe(true);
    expect(asked).toEqual([
      [59, 81],
      [59, 81],
    ]); // the same window twice: the real engine runs it once and the second ask joins it
  });
});

describe("what the model is told when captions wait for words", () => {
  const waiting = [{ clip_id: "au-a1", track_id: "a1" }];

  it("says nothing was added, that the work goes on, to try again, and when to stop trying", () => {
    const r = pendingCaptionsResult(waiting, {
      status: "in_progress",
      stage: "transcribing",
      waited_s: 60,
      note: "ignored",
    });
    expect(r.ok).toBe(false);
    expect(r.pending).toBe(true);
    expect(r.in_progress).toEqual(waiting);
    const words = String(r.error);
    expect(words).toMatch(/NOT added/);
    expect(words).toMatch(/background/);
    expect(words).toMatch(/call add_captions again/);
    expect(words).toMatch(/two or three tries/);
  });

  it("names a model download and how far it is, because that is what the person is waiting for", () => {
    const r = pendingCaptionsResult(waiting, {
      status: "in_progress",
      stage: "downloading_speech_model",
      waited_s: 60,
      progress_pct: 37,
      note: "ignored",
    });
    expect(r.progress_pct).toBe(37);
    expect(String(r.error)).toMatch(/speech model is still downloading \(37%\)/);
  });

  it("tells the time first when it knows it (S2-13), and says nothing about time when it does not", () => {
    const known = pendingCaptionsResult(waiting, {
      status: "in_progress",
      stage: "transcribing",
      waited_s: 1,
      eta_s: 4800,
      note: "ignored",
    });
    expect(known.eta_s).toBe(4800);
    expect(String(known.error)).toMatch(/about 1 hour 20 minutes more/);
    expect(String(known.error)).toMatch(/tell the user the time/);
    const unknown = pendingCaptionsResult(waiting, {
      status: "in_progress",
      stage: "transcribing",
      waited_s: 60,
      note: "ignored",
    });
    expect(unknown.eta_s).toBeUndefined();
    expect(String(unknown.error)).not.toMatch(/should take about/);
  });
});
