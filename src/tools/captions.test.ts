// add_captions places clips a viewer will read, so these assert the CLIPS on the timeline —
// their words, their frames, their group — not that the tool was called.
//
// Transcription is stubbed by seeding its on-disk cache, which is the same door a real second
// run comes through. That keeps whisper out of the test without faking the module boundary.
import { beforeEach, describe, expect, it } from "vitest";

import { addCaptionsTool } from "./captions";
import { loadTimeline, applyOp } from "../timeline/engine";
import { DIR, resetTestDocuments, seededCtx } from "../test/timelineKit";
import { joinPath } from "./store";
import type { ClientToolContext } from "./context";
import type { Clip } from "../timeline/model";

type Any = Record<string, unknown>;
const FPS = 30;

/** Seed the transcript cache for `ref` so ensureTranscript never shells out to whisper. */
async function seedTranscript(
  ctx: ClientToolContext,
  ref: string,
  words: Array<[string, number, number]>,
  language = "",
): Promise<void> {
  // Mirrors canonicalTranscriptRel: hash(canonicalRef|size[|lang]).
  const { shortHash } = await import("./media");
  const rel = `transcripts/${shortHash(`${ref}|small${language ? `|${language}` : ""}`)}.json`;
  const path = await ctx.store.prepareArtifact(rel);
  await ctx.store.writeText(
    path,
    JSON.stringify({
      transcription: {
        language: language || "en",
        duration_seconds: 10,
        segments: [],
        words: words.map(([word, start, end], i) => ({
          word_id: i,
          segment_id: 0,
          index_in_segment: i,
          word,
          start_seconds: start,
          end_seconds: end,
          start_timestamp: "00:00:00",
          end_timestamp: "00:00:00",
          probability: 1,
        })),
      },
    }),
  );
}

/** A timeline with one audio clip covering [0, durFrames) that references `ref`. The media file
 *  is created too: ensureTranscript resolves the source BEFORE consulting its cache, so a ref
 *  that does not resolve never reaches the seeded transcript. */
async function withAudio(
  ctx: ClientToolContext,
  ref = "library/speech.m4a",
  durFrames = 300,
  trackId = "a1",
  createFile = true,
): Promise<void> {
  if (createFile) await ctx.store.writeText(joinPath(DIR, ref), "fake-media");
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
          timeline_out: durFrames,
          source_in: 0,
          source_out: durFrames,
        } as Clip,
      ],
    });
  });
}

const captions = (tl: Any): Clip[] =>
  ((tl.tracks as Any[]) ?? [])
    .flatMap((t) => (t.clips as Clip[]) ?? [])
    .filter((c) => c.kind === "text")
    .sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));

const textOf = (c: Clip): string =>
  Array.isArray(c.content) ? c.content.map((r) => r.text).join(" ") : String(c.content ?? "");

describe("add_captions", () => {
  beforeEach(async () => {
    await resetTestDocuments();
  });

  it("turns spoken words into caption clips at the frames they are spoken", async () => {
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [
      ["hello", 0, 0.5],
      ["world", 0.5, 1.0],
    ]);

    const r = (await addCaptionsTool({ max_words: 2, max_gap_seconds: 0 }, ctx)) as Any;
    expect(r.ok).toBe(true);

    const caps = captions(await loadTimeline(store));
    expect(caps.length).toBe(1);
    expect(textOf(caps[0])).toBe("hello world");
    // 0s..1s at 30fps, mapped through the clip's trim/position.
    expect([caps[0].timeline_in, caps[0].timeline_out]).toEqual([0, FPS]);
  });

  // A card collapsed to ONE run is why word-by-word / word-highlight / karaoke rendered
  // statically and why animation.emphasis had nothing to mark: those builds animate per chunk,
  // and one chunk cannot animate. The per-word timings were computed and then thrown away.
  it("emits one timed run PER WORD, so a word build has something to animate", async () => {
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [
      ["hello", 0, 0.5],
      ["world", 0.5, 1.0],
    ]);

    await addCaptionsTool({ max_words: 2, max_gap_seconds: 0 }, ctx);
    const runs = (captions(await loadTimeline(store))[0].content ?? []) as Any[];
    expect(runs.length).toBe(2); // not one joined string
    expect(runs.map((r) => r.text)).toEqual(["hello", "world"]);
    // The whole point is that they do not share a time: a build that reveals per word needs the
    // second word to start after the first.
    expect(runs[1].t_in).toBeGreaterThan(Number(runs[0].t_in));
    expect(runs[0].t_in).toBe(0); // relative to the card, not the timeline
    // The card still reads as its full sentence for anything that joins the runs.
    expect(textOf(captions(await loadTimeline(store))[0])).toBe("hello world");
  });

  it("marks exactly ONE hero run, and picks the longest word", async () => {
    // `animation.emphasis` styles a run with `emphasis:true` (assCaption's runOverride). Without a
    // hero flag it had no target, so "one yellow word in a white caption" was unbuildable.
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [
      ["find", 0, 0.5],
      ["tracks", 0.5, 1.0],
    ]);

    await addCaptionsTool({ max_words: 2, max_gap_seconds: 0, hero: "longest" }, ctx);
    const runs = (captions(await loadTimeline(store))[0].content ?? []) as Any[];
    expect(runs.filter((r) => r.emphasis === true).length).toBe(1);
    expect(runs.find((r) => r.emphasis === true)?.text).toBe("tracks");
  });

  it("emphasises nothing by default, so existing captions are unchanged", async () => {
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [
      ["find", 0, 0.5],
      ["tracks", 0.5, 1.0],
    ]);

    await addCaptionsTool({ max_words: 2, max_gap_seconds: 0 }, ctx);
    const runs = (captions(await loadTimeline(store))[0].content ?? []) as Any[];
    expect(runs.some((r) => r.emphasis === true)).toBe(false);
  });

  it("splits at the caps instead of emitting one long clip", async () => {
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(
      ctx,
      "library/speech.m4a",
      ["one", "two", "three", "four"].map((w, i): [string, number, number] => [w, i, i + 0.9]),
    );

    await addCaptionsTool({ max_words: 2, max_gap_seconds: 0 }, ctx);
    const caps = captions(await loadTimeline(store));
    expect(caps.map(textOf)).toEqual(["one two", "three four"]);
  });

  it("groups everything it created so the set can be restyled in one call", async () => {
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [
      ["a", 0, 0.4],
      ["b", 2, 2.4],
    ]);

    const r = (await addCaptionsTool({ max_words: 1, max_gap_seconds: 0 }, ctx)) as Any;
    const caps = captions(await loadTimeline(store));
    expect(caps.length).toBe(2);
    expect(new Set(caps.map((c) => c.caption_group)).size).toBe(1);
    expect(caps[0].caption_group).toBe(r.caption_group);
    expect(String(r.caption_group ?? "")).not.toBe("");
  });

  it("never places overlapping captions, because the timeline would refuse them", async () => {
    // Two words close enough that naive rounding collides.
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [
      ["tight", 0, 0.9],
      ["packed", 0.5, 1.2],
    ]);

    expect(((await addCaptionsTool({ max_words: 1, max_gap_seconds: 0 }, ctx)) as Any).ok).toBe(
      true,
    );
    const caps = captions(await loadTimeline(store));
    for (let i = 1; i < caps.length; i++) {
      expect(Number(caps[i].timeline_in)).toBeGreaterThanOrEqual(Number(caps[i - 1].timeline_out));
    }
  });

  it("captions the track with the most speech, not the first one it finds", async () => {
    // The failure direction: picking track order would caption a stray music bed over dialogue.
    const { ctx, store } = await seededCtx();
    await withAudio(ctx, "library/bed.m4a", 300, "a1");
    await withAudio(ctx, "library/dialogue.m4a", 300, "a2");
    await seedTranscript(ctx, "library/bed.m4a", [["la", 0, 0.4]]);
    await seedTranscript(
      ctx,
      "library/dialogue.m4a",
      ["so", "here", "is", "the", "thing"].map((w, i): [string, number, number] => [
        w,
        i * 0.5,
        i * 0.5 + 0.4,
      ]),
    );

    const r = (await addCaptionsTool({ max_words: 1, max_gap_seconds: 0 }, ctx)) as Any;
    expect(r.source_track).toBe("a2");
    expect(captions(await loadTimeline(store)).map(textOf)).toEqual([
      "so",
      "here",
      "is",
      "the",
      "thing",
    ]);
  });

  it("holds a caption across a short gap rather than blinking off", async () => {
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [
      ["first", 0, 0.4],
      ["second", 0.7, 1.1],
    ]);

    await addCaptionsTool({ max_words: 1, max_gap_seconds: 0.5 }, ctx);
    const caps = captions(await loadTimeline(store));
    expect(Number(caps[0].timeline_out)).toBe(Number(caps[1].timeline_in));
  });

  it("applies casing to what the viewer reads", async () => {
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [["shout", 0, 0.5]]);

    await addCaptionsTool({ case: "upper", max_gap_seconds: 0 }, ctx);
    expect(textOf(captions(await loadTimeline(store))[0])).toBe("SHOUT");
  });

  it("adds no styling of its own when none was asked for", async () => {
    // The app's default look must come from the renderer's defaults, not from the tool
    // inventing a font the user never chose.
    const { ctx, store } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [["plain", 0, 0.5]]);

    await addCaptionsTool({ max_gap_seconds: 0 }, ctx);
    const cap = captions(await loadTimeline(store))[0];
    expect(cap.style).toBeUndefined();
    expect(cap.animation).toBeUndefined();
  });

  it("refuses an audio track that does not exist rather than captioning a different one", async () => {
    const { ctx } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [["hi", 0, 0.4]]);

    const r = (await addCaptionsTool({ track_id: "nope" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("nope");
  });

  it("says there is no speech rather than silently succeeding with nothing", async () => {
    const { ctx } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", []);

    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/no speech/i);
  });

  it("reports an unreadable source as a failure, not as silence", async () => {
    // A broken transcriber that reads as "no speech" is how footage gets shipped uncaptioned.
    const { ctx } = await seededCtx();
    await withAudio(ctx, "library/missing.m4a", 300, "a1", false);
    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/NOT an absence of speech/i);
  });

  it("refuses a timeline with no audio at all", async () => {
    const { ctx } = await seededCtx();
    const r = (await addCaptionsTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/no audio/i);
  });

  it("rejects an out-of-range hold instead of clamping it silently", async () => {
    const { ctx } = await seededCtx();
    await withAudio(ctx);
    await seedTranscript(ctx, "library/speech.m4a", [["hi", 0, 0.4]]);
    const r = (await addCaptionsTool({ max_gap_seconds: 5 }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("max_gap_seconds");
  });
});

describe("add_captions from a subtitle file", () => {
  beforeEach(async () => {
    await resetTestDocuments();
  });

  const SRT =
    "1\n00:00:01,000 --> 00:00:02,000\nHello.\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld.\n";

  const writeSubs = async (ctx: ClientToolContext, body = SRT, name = "library/subs.srt") => {
    await ctx.store.writeText(joinPath(DIR, name), body);
    return name;
  };

  it("places cues at their AUTHORED timecodes, not re-chunked", async () => {
    const { ctx, store } = await seededCtx();
    const ref = await writeSubs(ctx);
    const r = (await addCaptionsTool({ subtitle_media_ref: ref }, ctx)) as Any;
    expect(r.ok).toBe(true);
    const caps = captions(await loadTimeline(store));
    expect(caps.map(textOf)).toEqual(["Hello.", "World."]);
    expect(caps.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [30, 60],
      [90, 120],
    ]);
  });

  it("groups them, so the imported set restyles in one call", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addCaptionsTool({ subtitle_media_ref: await writeSubs(ctx) }, ctx)) as Any;
    const caps = captions(await loadTimeline(store));
    expect(new Set(caps.map((c) => c.caption_group))).toEqual(new Set([r.caption_group]));
  });

  it("needs no audio on the timeline at all", async () => {
    // The whole point: this path never transcribes.
    const { ctx } = await seededCtx();
    const r = (await addCaptionsTool({ subtitle_media_ref: await writeSubs(ctx) }, ctx)) as Any;
    expect(r.ok).toBe(true);
  });

  it("refuses to be combined with options it would silently ignore", async () => {
    const { ctx } = await seededCtx();
    const ref = await writeSubs(ctx);
    const r = (await addCaptionsTool({ subtitle_media_ref: ref, max_words: 3 }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("max_words");
  });

  it("refuses a file that is not a subtitle", async () => {
    const { ctx } = await seededCtx();
    await ctx.store.writeText(joinPath(DIR, "library/clip.mp4"), "not really");
    const r = (await addCaptionsTool({ subtitle_media_ref: "library/clip.mp4" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/not a subtitle file/i);
  });

  it("reports a malformed file instead of adding nothing", async () => {
    const { ctx, store } = await seededCtx();
    const ref = await writeSubs(ctx, "garbage --> nonsense\nBroken.\n");
    const r = (await addCaptionsTool({ subtitle_media_ref: ref }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(captions(await loadTimeline(store))).toHaveLength(0);
  });

  it("never places overlapping captions from overlapping cues", async () => {
    const { ctx, store } = await seededCtx();
    const ref = await writeSubs(
      ctx,
      "1\n00:00:01,000 --> 00:00:04,000\nlong\n\n2\n00:00:02,000 --> 00:00:05,000\noverlapping\n",
    );
    expect(((await addCaptionsTool({ subtitle_media_ref: ref }, ctx)) as Any).ok).toBe(true);
    const caps = captions(await loadTimeline(store));
    for (let i = 1; i < caps.length; i++) {
      expect(Number(caps[i].timeline_in)).toBeGreaterThanOrEqual(Number(caps[i - 1].timeline_out));
    }
  });
});
