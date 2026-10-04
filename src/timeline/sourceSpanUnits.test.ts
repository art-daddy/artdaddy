import { beforeEach, describe, expect, it } from "vitest";

import { makeRunner, seededCtx } from "../test/timelineKit";
import { loadTimeline } from "./engine";
import {
  addClipsTool,
  clearDurationCache,
  clearHasAudioCache,
  clearHasVideoCache,
  insertClipsTool,
} from "./placement";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// `source_span` is the ONE time argument measured in seconds; timeline_in / timeline_out /
// duration in the very same entry are frames. A real user spent ~$0.80 on three rejected
// add_clips calls asking to start 4938s into a 3828s video â€” 4938 FRAMES is 164s, comfortably
// inside it. The refusal told them the start was past the end and nothing about the unit.
//
// The quiet case matters more: when both numbers happen to land inside the media there is no
// error at all and the clip is ~fps times too long. These assert the OUTCOME (refused vs
// placed, and the clip's real length) rather than that a checker ran.

const FPS = 30;
const MEDIA_SECONDS = 600;

/** ffprobe that reports a real duration, so the EOF paths actually engage. */
const timedRunner = makeRunner((p, a) => {
  if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
  if (a.includes("-select_streams")) {
    return { code: 0, stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "", stderr: "" };
  }
  return { code: 0, stdout: `${MEDIA_SECONDS}\n`, stderr: "" };
});

beforeEach(() => {
  clearHasAudioCache();
  clearHasVideoCache();
  clearDurationCache();
});

async function ctxWithMedia() {
  return seededCtx(timedRunner);
}

async function clipLengths(store: Any): Promise<number[]> {
  const tl = await loadTimeline(store);
  return tl.tracks.flatMap((t) =>
    (t.clips ?? []).map((c) => (c.timeline_out as number) - (c.timeline_in as number)),
  );
}

describe("source_span: frames passed where seconds are expected", () => {
  // The reported failure. Nothing lands, and the message has to carry the UNIT â€” "past the
  // end" alone sent the model back to guess a different number three times.
  it("names the unit and converts when the start is past the end of the media", async () => {
    const { ctx, store } = await ctxWithMedia();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "clip.mp4", timeline_in: 0, source_span: [4938, 4950] }] },
      ctx,
    )) as Any;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/source_span is in SECONDS/);
    expect(String(r.error)).toMatch(/4938 FRAMES/);
    expect(String(r.error)).toMatch(/164\.60/); // 4938 / 30
    expect(await clipLengths(store)).toEqual([]);
  });

  // The silent one: both numbers are inside the media, so nothing used to complain and the
  // clip came out 30x too long. Detectable only because the entry ALSO states its frame length.
  it("refuses a span whose raw numbers are the frame length the entry also asks for", async () => {
    const { ctx, store } = await ctxWithMedia();
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "clip.mp4", timeline_in: 0, timeline_out: 600, source_span: [300, 900] },
        ],
      },
      ctx,
    )) as Any;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/look like FRAMES/);
    expect(String(r.error)).toMatch(/\[10\.00, 30\.00\]/); // the same span, in seconds
    expect(await clipLengths(store)).toEqual([]);
  });

  it("refuses the same mix-up on insert_clips", async () => {
    const { ctx } = await ctxWithMedia();
    const r = (await insertClipsTool(
      {
        at: 0,
        entries: [{ media_ref: "clip.mp4", duration: 600, source_span: [300, 900] }],
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/look like FRAMES/);
  });

  // The guard must not fire on correct input. A 20s span with a matching 600-frame timeline
  // length is the NORMAL way to call this, and refusing it would break every good caller.
  it("accepts a correct seconds span that agrees with the frame length", async () => {
    const { ctx, store } = await ctxWithMedia();
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "clip.mp4", timeline_in: 0, timeline_out: 600, source_span: [10, 30] },
        ],
      },
      ctx,
    )) as Any;

    expect(r.ok).toBe(true);
    expect(await clipLengths(store)).toEqual([600]);
  });

  // Disagreeing lengths are long-standing ACCEPTED behaviour (source_span wins, with a note).
  // Only the fps-ratio case is a refusal; turning every disagreement into one would be a
  // regression dressed up as a fix.
  it("still only NOTES an ordinary length disagreement", async () => {
    const { ctx, store } = await ctxWithMedia();
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "clip.mp4", timeline_in: 0, timeline_out: 600, source_span: [10, 25] },
        ],
      },
      ctx,
    )) as Any;

    expect(r.ok).toBe(true);
    expect(String((r.notes ?? []).join(" "))).toMatch(/source_span/);
    expect(await clipLengths(store)).toEqual([450]); // 15s at 30fps â€” the span won
  });
});

describe("source_span: a span running past the end is reported, not just shortened", () => {
  it("places the clip AND says it came back shorter than asked", async () => {
    const { ctx, store } = await ctxWithMedia();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "clip.mp4", timeline_in: 0, source_span: [590, 900] }] },
      ctx,
    )) as Any;

    expect(r.ok).toBe(true);
    // 590s..600s survives; the 300s the caller asked for beyond EOF does not.
    expect(await clipLengths(store)).toEqual([(MEDIA_SECONDS - 590) * FPS]);
    expect(String((r.notes ?? []).join(" "))).toMatch(/past the media/);
    expect(String((r.notes ?? []).join(" "))).toMatch(/300 frames, not 9300/);
  });

  it("says nothing when the span fits", async () => {
    const { ctx } = await ctxWithMedia();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "clip.mp4", timeline_in: 0, source_span: [10, 30] }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(String((r.notes ?? []).join(" "))).not.toMatch(/past the media/);
  });
});

// Boundaries mutation testing found unpinned (2026-09-27): each of these survived a mutant.
describe("source_span: exact boundaries", () => {
  it("refuses a start exactly AT the end of the media, not just past it", async () => {
    const { ctx, store } = await ctxWithMedia();
    const r = (await addClipsTool(
      {
        entries: [
          {
            media_ref: "clip.mp4",
            timeline_in: 0,
            source_span: [MEDIA_SECONDS, MEDIA_SECONDS + 5],
          },
        ],
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/at\/after the media's end \(600\.00s\)/);
    expect(await clipLengths(store)).toEqual([]);
  });

  it("an end exactly AT the end of the media is not shortened and not noted", async () => {
    const { ctx, store } = await ctxWithMedia();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "clip.mp4", timeline_in: 0, source_span: [590, MEDIA_SECONDS] }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(await clipLengths(store)).toEqual([10 * FPS]);
    expect(String((r.notes ?? []).join(" "))).not.toMatch(/past the media/);
  });

  it("the clamp note reports the seconds and frames actually involved", async () => {
    const { ctx } = await ctxWithMedia();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "clip.mp4", timeline_in: 0, source_span: [590, 700] }] },
      ctx,
    )) as Any;
    const note = String((r.notes ?? []).join(" "));
    expect(note).toMatch(/asked for 700\.00s, media ends at 600\.00s/);
    expect(note).toMatch(/300 frames, not 3300/);
  });

  // The frames reading may be off by one frame (rounding) and still be the mix-up; exactly two
  // frames off is an ordinary disagreement and must only be NOTED, as before.
  it("still recognises frames passed as seconds when the lengths differ by one frame", async () => {
    const { ctx } = await ctxWithMedia();
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "clip.mp4", timeline_in: 0, timeline_out: 601, source_span: [300, 900] },
        ],
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/look like FRAMES/);
  });

  it("treats a two-frame difference as an ordinary disagreement", async () => {
    const { ctx } = await ctxWithMedia();
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "clip.mp4", timeline_in: 0, timeline_out: 602, source_span: [300, 900] },
        ],
      },
      ctx,
    )) as Any;
    expect(String(r.error ?? "")).not.toMatch(/look like FRAMES/);
  });

  it("the unit hint gives the frame-to-seconds conversion, with the real numbers", async () => {
    const { ctx } = await ctxWithMedia();
    const past = (await addClipsTool(
      { entries: [{ media_ref: "clip.mp4", timeline_in: 0, source_span: [4938, 4950] }] },
      ctx,
    )) as Any;
    expect(String(past.error)).toMatch(/if you meant 4938 FRAMES, pass 164\.60/);

    const silent = (await addClipsTool(
      {
        entries: [
          { media_ref: "clip.mp4", timeline_in: 0, timeline_out: 600, source_span: [300, 900] },
        ],
      },
      ctx,
    )) as Any;
    expect(String(silent.error)).toMatch(/they would cut 18000 frames/);
  });

  // A start past the end whose frames reading is ALSO past the end is not a unit mix-up, and the
  // message must not claim it might be.
  it("offers no frames conversion when that reading would be past the end too", async () => {
    const { ctx } = await ctxWithMedia();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "clip.mp4", timeline_in: 0, source_span: [30000, 30010] }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).not.toMatch(/FRAMES/);
  });
});
