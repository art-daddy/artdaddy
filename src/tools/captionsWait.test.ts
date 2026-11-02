import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addCaptionsTool } from "./captions";
import { CACHE_READ_FLOOR_MS, pendingCaptionsResult } from "./captionTranscript";
import type { ClientToolContext } from "./context";
import { joinPath } from "./store";
import { ensureTranscript, TRANSCRIPT_WAIT_MS } from "./transcribe";
import { resetLiveWait, useLiveWait } from "../store/liveWait";
import { applyOp, loadTimeline } from "../timeline/engine";
import type { Clip } from "../timeline/model";
import { CachingMemFs, DIR, resetTestDocuments, seededCtx as kitCtx } from "../test/timelineKit";

// The real transcriber, except where a test says a transcription never finishes.
vi.mock("./transcribe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcribe")>();
  return { ...actual, ensureTranscript: vi.fn(actual.ensureTranscript) };
});
// Loaded before any test turns the clock off: loading a module needs it running.
const actual = await vi.importActual<typeof import("./transcribe")>("./transcribe");

type Any = Record<string, unknown>;
const seededCtx = () => kitCtx(undefined, DIR, new CachingMemFs());

/** The transcript cache slot for `ref`, filled with whisper's own JSON, so the real
 *  ensureTranscript finds it and never shells out. */
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
    vi.mocked(ensureTranscript).mockImplementationOnce(neverFinishes);
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
    vi.mocked(ensureTranscript).mockImplementationOnce(neverFinishes);

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
    vi.mocked(ensureTranscript).mockImplementation(neverFinishes);

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
    vi.mocked(ensureTranscript).mockImplementation(async (c, ref, size, language) => {
      if (String(ref).endsWith("slow.m4a")) return neverFinishes();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return actual.ensureTranscript(c, ref, size, language);
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
    vi.mocked(ensureTranscript).mockImplementationOnce(neverFinishes);
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
    vi.mocked(ensureTranscript).mockImplementationOnce(async () => {
      throw new Error("the engine fell over");
    });

    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(r.pending).toBeUndefined();
    expect(String(r.error)).toMatch(/transcription failed for all 1 audio clip/);
    expect(String(r.error)).toMatch(/engine fell over/);
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
});
