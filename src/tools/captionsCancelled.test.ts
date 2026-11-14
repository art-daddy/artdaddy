// add_captions when the person stopped the transcription on the top-bar chip (S2-05): the answer carries the
// reason and the advice, nothing is placed, nothing is called "in progress" and nothing is reported as a tool
// failure. The transcriber is the real one except that a test says what the stretch's run ends with.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addCaptionsTool } from "./captions";
import type { ClientToolContext } from "./context";
import { SpeechCancelledError } from "./speechFailure";
import { joinPath } from "./store";
import { transcribeSpan } from "./transcribe";
import { resetLiveWait } from "../store/liveWait";
import { applyOp, loadTimeline } from "../timeline/engine";
import type { Clip } from "../timeline/model";
import { CachingMemFs, DIR, resetTestDocuments, seededCtx as kitCtx } from "../test/timelineKit";

vi.mock("./transcribe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcribe")>();
  return { ...actual, transcribeSpan: vi.fn(actual.transcribeSpan) };
});

type Any = Record<string, unknown>;

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

describe("add_captions after the person stopped the transcription", () => {
  beforeEach(async () => {
    await resetTestDocuments();
    resetLiveWait();
  });
  afterEach(() => vi.mocked(transcribeSpan).mockReset());

  it("says the person stopped it and what to do about it, adds nothing, and does not call it a failure or a wait", async () => {
    const ctx = (await kitCtx(undefined, DIR, new CachingMemFs())).ctx;
    await withAudio(ctx, "library/talk.m4a", "a1");
    vi.mocked(transcribeSpan).mockImplementationOnce(async () => {
      throw new SpeechCancelledError();
    });
    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(r).toMatchObject({ ok: false, reason: "cancelled" });
    expect(String(r.error)).toMatch(/Captions were NOT added/);
    expect(String(r.error)).toMatch(
      /person stopped this transcription in the app\. Do not start it again unless they ask/,
    );
    expect(String(r.error)).not.toMatch(
      /tool failure|still being transcribed|call add_captions again/i,
    );
    expect(r.pending).toBeUndefined();
    expect(r.status).toBeUndefined();
    expect(
      (await loadTimeline(ctx.store)).tracks
        .flatMap((t) => t.clips ?? [])
        .filter((c) => c.kind === "text"),
    ).toEqual([]);
  });

  it("is still a failure, in the old words, when the run failed for any other reason", async () => {
    const ctx = (await kitCtx(undefined, DIR, new CachingMemFs())).ctx;
    await withAudio(ctx, "library/talk.m4a", "a1");
    vi.mocked(transcribeSpan).mockImplementationOnce(async () => {
      throw new Error("the engine fell over");
    });
    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(r.reason).toBeUndefined();
    expect(String(r.error)).toMatch(/transcription failed for all 1 audio clip/);
  });

  // The person pressed Cancel on the run of the first window. The next window must not start at once, in
  // the face of their click (F6a); and every clip is told they stopped it, so the assistant does not start it.
  it("does not start the other windows after the person stopped the first: three windows, one run, the cancel's answer for all three", async () => {
    const ctx = (await kitCtx(undefined, DIR, new CachingMemFs())).ctx;
    await withAudio(ctx, "library/one.m4a", "a1");
    await withAudio(ctx, "library/two.m4a", "a2");
    await withAudio(ctx, "library/three.m4a", "a3");
    vi.mocked(transcribeSpan).mockImplementation(async () => {
      throw new SpeechCancelledError();
    });
    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(
      vi.mocked(transcribeSpan),
      "no run was started after the person stopped one",
    ).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, reason: "cancelled" });
    expect(String(r.error)).toMatch(
      /person stopped this transcription in the app\. Do not start it again/,
    );
    expect((r.failed as Array<{ clip_id: string }>).map((f) => f.clip_id).sort()).toEqual([
      "au-a1",
      "au-a2",
      "au-a3",
    ]);
    expect(
      (await loadTimeline(ctx.store)).tracks
        .flatMap((t) => t.clips ?? [])
        .filter((c) => c.kind === "text"),
    ).toEqual([]);
  });

  it("does not start the second window of the same file either when the first was stopped", async () => {
    const ctx = (await kitCtx(undefined, DIR, new CachingMemFs())).ctx;
    await withAudio(ctx, "library/talk.m4a", "a1");
    // A second clip of the same file, far from the first: its own window, and a run of its own
    await applyOp(ctx.store, "seed", (tl) => {
      tl.tracks[tl.tracks.length - 1].clips!.push({
        id: "au-a1-late",
        kind: "audio",
        media_ref: "library/talk.m4a",
        timeline_in: 400,
        timeline_out: 500,
        source_in: 1000,
        source_out: 1100,
      } as Clip);
    });
    vi.mocked(transcribeSpan).mockImplementation(async () => {
      throw new SpeechCancelledError();
    });
    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(vi.mocked(transcribeSpan)).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, reason: "cancelled" });
    expect(r.pending).toBeUndefined();
  });
});
