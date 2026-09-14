import { beforeEach, describe, expect, it } from "vitest";

import { audioRunner, findClipById, makeRunner, seededCtx, videoRunner } from "../test/timelineKit";
import {
  applyTransitionTool,
  duplicateClipsTool,
  linkClipsTool,
  moveClipsTool,
  pasteClipsTool,
  removeClipsTool,
  rippleDeleteTool,
  splitClipsTool,
  trimClipsTool,
  unlinkClipsTool,
} from "./edit";
import { loadTimeline } from "./engine";
import { normalizeLinks } from "./helpers";
import { setTrackTool } from "./ops";
import {
  addClipsTool,
  clearDurationCache,
  clearHasAudioCache,
  clearHasVideoCache,
} from "./placement";
import { setClipPropertiesTool, setKeyframesTool } from "./props";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

beforeEach(() => {
  clearHasAudioCache();
  clearHasVideoCache();
});

async function withVideoAudio(): Promise<{
  ctx: Any;
  store: Any;
  videoId: string;
  audioId: string;
}> {
  const { ctx, store } = await seededCtx(audioRunner);
  const r = (await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    ctx,
  )) as Any;
  const videoId = r.created.find((c: Any) => c.kind === "video").clip_id as string;
  const audioId = r.created.find((c: Any) => c.kind === "audio").clip_id as string;
  return { ctx, store, videoId, audioId };
}

describe("moveClipsTool", () => {
  it("moves a clip in time and carries its linked audio", async () => {
    const { ctx, store, videoId, audioId } = await withVideoAudio();
    expect(
      ((await moveClipsTool({ moves: [{ clip_id: videoId, to_timeline_in: 30 }] }, ctx)) as Any).ok,
    ).toBe(true);
    const tl = await loadTimeline(store);
    expect([findClipById(tl, videoId).timeline_in, findClipById(tl, videoId).timeline_out]).toEqual(
      [30, 90],
    );
    expect([findClipById(tl, audioId).timeline_in, findClipById(tl, audioId).timeline_out]).toEqual(
      [30, 90],
    );
  });

  it("moves a clip across tracks", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "pic.png", timeline_in: 0, timeline_out: 30 }] },
      ctx,
    )) as Any;
    const id = r.created[0].clip_id as string;
    await moveClipsTool({ moves: [{ clip_id: id, to_track: "v1" }] }, ctx);
    const tl = await loadTimeline(store);
    expect(tl.tracks.find((t) => t.id === "v1")!.clips!.some((c) => c.id === id)).toBe(true);
  });

  it("overwrites the destination: a moved clip trims a blocker it lands on", async () => {
    const { ctx, store } = await seededCtx();
    const a = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    )) as Any;
    const b = (await addClipsTool(
      { entries: [{ media_ref: "b.png", timeline_in: 40, timeline_out: 70, track_id: "v1" }] },
      ctx,
    )) as Any;
    const aId = a.created[0].clip_id as string;
    const bId = b.created[0].clip_id as string;
    // Move b onto [10, 40), overlapping a's [0, 30) tail — a must be trimmed to make room.
    const r = (await moveClipsTool({ moves: [{ clip_id: bId, to_timeline_in: 10 }] }, ctx)) as Any;
    expect(r.ok).toBe(true);
    const tl = await loadTimeline(store);
    expect(findClipById(tl, aId).timeline_out).toBe(10);
    expect([findClipById(tl, bId).timeline_in, findClipById(tl, bId).timeline_out]).toEqual([
      10, 40,
    ]);
    // A drag shows the casualty on screen; an agent move is blind, so the reply has to say it.
    expect(r.overwrote.shortened).toEqual([{ id: aId, was: [0, 30], now: [0, 10] }]);
    expect(String(r.warnings.join(" "))).toContain(aId);
  });

  it("a move onto empty space reports no overwrite", async () => {
    const { ctx } = await seededCtx();
    const a = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    )) as Any;
    const r = (await moveClipsTool(
      { moves: [{ clip_id: a.created[0].clip_id, to_timeline_in: 100 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.overwrote).toBeUndefined();
    expect(r.warnings).toBeUndefined();
  });

  it("errors on unknown clip and a non-list moves", async () => {
    const { ctx } = await seededCtx();
    expect(
      ((await moveClipsTool({ moves: [{ clip_id: "nope", to_timeline_in: 0 }] }, ctx)) as Any).ok,
    ).toBe(false);
    expect(((await moveClipsTool({ moves: "x" }, ctx)) as Any).ok).toBe(false);
    expect(((await moveClipsTool({}, null)) as Any).ok).toBe(false);
  });

  it("rejects a move to a kind-incompatible track", async () => {
    const { ctx, store, videoId } = await withVideoAudio();
    const audio = (await loadTimeline(store)).tracks.find((t) => t.kind === "audio")!;
    const r = (await moveClipsTool(
      { moves: [{ clip_id: videoId, to_track: audio.id }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
  });
});

describe("trimClipsTool", () => {
  it("trims boundaries and keeps the linked audio aligned", async () => {
    const { ctx, store, videoId, audioId } = await withVideoAudio();
    await trimClipsTool({ trims: [{ clip_id: videoId, timeline_out: 30, source_out: 30 }] }, ctx);
    const tl = await loadTimeline(store);
    expect(findClipById(tl, videoId).timeline_out).toBe(30);
    expect(findClipById(tl, audioId).timeline_out).toBe(30);
    expect(findClipById(tl, audioId).source_out).toBe(30);
  });
  it("errors on a non-list trims", async () => {
    const { ctx } = await seededCtx();
    expect(((await trimClipsTool({ trims: "x" }, ctx)) as Any).ok).toBe(false);
  });

  // A head trim used to OVERWRITE each partner's edges with the lead's, so a J/L offset
  // (audio deliberately starting before the picture) was silently flattened to zero.
  it("a head trim drags the linked audio by the SAME DELTA, keeping a J/L offset", async () => {
    const { ctx, store, videoId, audioId } = await withVideoAudio();
    // Give the audio a 10f J-cut lead-in, then pull the video's head right by 20f.
    await setClipPropertiesTool({ clip_ids: [audioId], properties: { timeline_in: 10 } }, ctx);
    const before = findClipById(await loadTimeline(store), audioId);
    await trimClipsTool({ trims: [{ clip_id: videoId, timeline_in: 20, source_in: 20 }] }, ctx);
    const tl = await loadTimeline(store);
    const v = findClipById(tl, videoId);
    const a = findClipById(tl, audioId);
    expect(v.timeline_in).toBe(20);
    // The offset is preserved: the audio moved by the same 20f, it did not snap onto the video.
    expect(a.timeline_in).toBe((before.timeline_in as number) + 20);
    expect(a.timeline_in).not.toBe(v.timeline_in);
    // ...and the pair stays equal-length (t008) because both edges shifted by their own delta.
    expect((a.timeline_out as number) - (a.timeline_in as number)).toBe(
      (v.timeline_out as number) - (v.timeline_in as number),
    );
  });

  // THE drift guard for §4.1: the UI door and the agent door must be one rule. They were
  // not — this is the divergence that shipped a clip claiming frames past its own EOF.
  it("both trim doors produce an IDENTICAL document for the same intent", async () => {
    const shape = async (
      run: (ctx: Any, videoId: string) => Promise<unknown>,
    ): Promise<unknown[]> => {
      const { ctx, store, videoId, audioId } = await withVideoAudio();
      await run(ctx, videoId);
      const tl = await loadTimeline(store);
      return [videoId, audioId].map((id) => {
        const c = findClipById(tl, id) as Any;
        return [c.timeline_in, c.timeline_out, c.source_in, c.source_out];
      });
    };
    const viaTrim = await shape((ctx, id) =>
      trimClipsTool({ trims: [{ clip_id: id, timeline_out: 40, source_out: 40 }] }, ctx),
    );
    const viaProps = await shape((ctx, id) =>
      setClipPropertiesTool({ clip_ids: [id], properties: { duration: 40, source_out: 40 } }, ctx),
    );
    expect(viaTrim).toEqual(viaProps);
  });
  it("refuses a degenerate source span and leaves the clip unchanged", async () => {
    const { ctx, store, videoId } = await withVideoAudio();
    const before = findClipById(await loadTimeline(store), videoId).source_in;
    const r = (await trimClipsTool(
      { trims: [{ clip_id: videoId, source_in: 999, source_out: 10 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(findClipById(await loadTimeline(store), videoId).source_in).toBe(before);
  });
  it("refuses an inverted timeline span", async () => {
    const { ctx, videoId } = await withVideoAudio();
    const r = (await trimClipsTool(
      { trims: [{ clip_id: videoId, timeline_in: 40, timeline_out: 10 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });
});

// The editor's drag-trim door. It used to write the requested edges RAW, which gave the
// two media kinds opposite failures from the same gap: a video could be dragged past the
// end of its own footage and it COMMITTED (deriveSourceSpans re-derived source_out, so
// validation passed and the export silently ran out of frames), while a still — which has
// no source window at all — got half a window written and the whole edit was rejected, so
// it visibly snapped back. Both doors now resolve against the real media length.
describe("a trim can never outrun the footage behind it", () => {
  /** ffprobe that reports a 4-second source (120 frames at 30fps) AND a video stream. */
  const runner4s = makeRunner((p, a) => {
    if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
    if (a.includes("-select_streams"))
      return {
        code: 0,
        stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "",
        stderr: "",
      };
    return { code: 0, stdout: "4.0", stderr: "" };
  });

  beforeEach(() => clearDurationCache());

  async function video(): Promise<{ ctx: Any; store: Any; id: string }> {
    const { ctx, store } = await seededCtx(runner4s);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    return { ctx, store, id: r.created[0].clip_id as string };
  }

  async function still(): Promise<{ ctx: Any; store: Any; id: string }> {
    const { ctx, store } = await seededCtx(runner4s);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "pic.png", timeline_in: 0, timeline_out: 150 }] },
      ctx,
    )) as Any;
    return { ctx, store, id: r.created[0].clip_id as string };
  }

  it("a video's tail STOPS at the end of the source instead of committing dead frames", async () => {
    const { ctx, store, id } = await video();
    // 120 source frames, in-point 0 -> 120 is the ceiling. Ask for 600.
    const r = (await trimClipsTool(
      { trims: [{ clip_id: id, timeline_out: 600, source_out: 600 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const c = findClipById(await loadTimeline(store), id);
    expect(c.timeline_out).toBe(120);
    expect(c.source_out).toBeLessThanOrEqual(120);
  });

  it("shortens rather than SLIDING the head, so the visible content stays put", async () => {
    // The failure direction: clamping by moving source_in would silently slip the clip to
    // different footage — the exact bug set_clip_properties' design exists to prevent.
    // Source is 120 frames; this clip starts 90 in, so only 30 remain.
    const { ctx, store } = await seededCtx(runner4s);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, source_span: [3, 3.5] }] },
      ctx,
    )) as Any;
    const id = r.created[0].clip_id as string;
    expect(findClipById(await loadTimeline(store), id).source_in).toBe(90);
    await trimClipsTool({ trims: [{ clip_id: id, timeline_out: 500 }] }, ctx);
    const c = findClipById(await loadTimeline(store), id);
    expect(c.source_in).toBe(90); // head held
    expect(c.timeline_out - c.timeline_in).toBe(30); // only 30 frames remain
  });

  it("a still's tail EXTENDS freely — it has no source to run out of", async () => {
    const { ctx, store, id } = await still();
    const r = (await trimClipsTool({ trims: [{ clip_id: id, timeline_out: 9000 }] }, ctx)) as Any;
    expect(r.ok).toBe(true);
    const c = findClipById(await loadTimeline(store), id);
    expect(c.timeline_out).toBe(9000);
  });

  it("a still is never given a source window, in either direction", async () => {
    // A half-written window (source_out with no source_in) is what validateTimeline
    // rejected, which is what made the image snap back. Neither edge may invent one.
    const { ctx, store, id } = await still();
    await trimClipsTool({ trims: [{ clip_id: id, timeline_out: 400 }] }, ctx);
    await trimClipsTool({ trims: [{ clip_id: id, timeline_in: 20 }] }, ctx);
    const c = findClipById(await loadTimeline(store), id);
    expect(c.source_in).toBeUndefined();
    expect(c.source_out).toBeUndefined();
    expect([c.timeline_in, c.timeline_out]).toEqual([20, 400]);
  });

  it("an UNPROBEABLE source stays unbounded rather than blocking the edit", async () => {
    // A failed probe is not evidence the media is short. Fail closed here and a user with
    // a missing ffprobe could not lengthen any clip.
    const { ctx, store } = await seededCtx(
      makeRunner((p, a) =>
        p === "ffprobe" && a.includes("-select_streams")
          ? { code: 0, stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      ),
    );
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    const id = r.created[0].clip_id as string;
    expect(
      ((await trimClipsTool({ trims: [{ clip_id: id, timeline_out: 900 }] }, ctx)) as Any).ok,
    ).toBe(true);
    expect(findClipById(await loadTimeline(store), id).timeline_out).toBe(900);
  });

  it("holds the linked audio to the clamped span, not the asked-for one", async () => {
    // The partner used to be handed the RAW request, so a clamped video left its audio
    // longer than the picture — A/V desync from a fix that only reached the lead clip.
    const { ctx, store } = await seededCtx(
      makeRunner((p, a) => {
        if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
        if (a.includes("-select_streams")) return { code: 0, stdout: "1", stderr: "" };
        return { code: 0, stdout: "4.0", stderr: "" };
      }),
    );
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    const vid = r.created.find((c: Any) => c.kind === "video").clip_id as string;
    const aud = r.created.find((c: Any) => c.kind === "audio").clip_id as string;
    await trimClipsTool({ trims: [{ clip_id: vid, timeline_out: 600 }] }, ctx);
    const tl = await loadTimeline(store);
    expect(findClipById(tl, aud).timeline_out).toBe(findClipById(tl, vid).timeline_out);
  });
});

describe("splitClipsTool", () => {
  it("splits a clip and its linked audio at the cut", async () => {
    const { ctx, store, videoId } = await withVideoAudio();
    const r = (await splitClipsTool({ splits: [{ clip_id: videoId, at: 30 }] }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.new_clip_ids.length).toBe(1);
    const tl = await loadTimeline(store);
    const v2 = tl.tracks.find((t) => t.id === "v1")!.clips!;
    expect(v2.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 30],
      [30, 60],
    ]);
    const audioTrack = tl.tracks.find((t) => t.kind === "audio" && t.id !== "music")!;
    expect(audioTrack.clips!.length).toBe(2);
  });
  it("rejects a cut outside the clip and a non-list splits", async () => {
    const { ctx, videoId } = await withVideoAudio();
    expect(
      ((await splitClipsTool({ splits: [{ clip_id: videoId, at: 100 }] }, ctx)) as Any).ok,
    ).toBe(false);
    expect(((await splitClipsTool({ splits: "x" }, ctx)) as Any).ok).toBe(false);
  });
  it("partitions keyframes across a split (right half rebased to its own origin)", async () => {
    const { ctx, store, videoId } = await withVideoAudio();
    await setKeyframesTool(
      {
        clip_id: videoId,
        property: "opacity",
        keyframes: [
          { t: 0, v: 0 },
          { t: 20, v: 0.5 },
          { t: 40, v: 1 },
        ],
      },
      ctx,
    );
    const r = (await splitClipsTool({ splits: [{ clip_id: videoId, at: 30 }] }, ctx)) as Any;
    expect(r.ok).toBe(true);
    const tl = await loadTimeline(store);
    const left = findClipById(tl, videoId);
    const right = findClipById(tl, r.new_clip_ids[0] as string);
    // Keys before the cut stay on the left; the key at t=40 moves to the right,
    // rebased to the right clip's origin (40 - 30 = 10). Timeline positions unchanged.
    expect(left.opacity).toEqual([
      { t: 0, v: 0 },
      { t: 20, v: 0.5 },
    ]);
    expect(right.opacity).toEqual([{ t: 10, v: 1 }]);
  });
});

describe("duplicateClipsTool", () => {
  it("clones a clip right after itself, rippling later clips", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "a.png", timeline_in: 0, timeline_out: 30 },
          { media_ref: "b.png", timeline_in: 30, timeline_out: 60 },
        ],
      },
      ctx,
    )) as Any;
    const firstId = r.created[0].clip_id as string;
    const dup = (await duplicateClipsTool({ clip_ids: [firstId] }, ctx)) as Any;
    expect(dup.ok).toBe(true);
    expect(dup.new_clip_ids.length).toBe(1);
    const tl = await loadTimeline(store);
    const clips = tl.tracks.find((t) => t.kind === "video")!.clips!;
    // original [0,30], copy [30,60], the later clip rippled to [60,90]
    expect(clips.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 30],
      [30, 60],
      [60, 90],
    ]);
    const copy = findClipById(tl, dup.new_clip_ids[0]);
    expect(copy.media_ref).toBe("a.png");
    expect(copy.id).not.toBe(firstId);
  });

  it("copies clip properties onto the duplicate", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30 }] },
      ctx,
    )) as Any;
    const id = r.created[0].clip_id as string;
    await setClipPropertiesTool(
      { clip_ids: [id], properties: { opacity: 0.5, layout: { x: 10, y: 20, w: 100, h: 200 } } },
      ctx,
    );
    const dup = (await duplicateClipsTool({ clip_ids: [id] }, ctx)) as Any;
    const copy = findClipById(await loadTimeline(store), dup.new_clip_ids[0]);
    expect(copy.opacity).toBe(0.5);
    expect(copy.layout).toEqual({ x: 10, y: 20, w: 100, h: 200 });
  });

  it("errors on a non-list clip_ids and without ctx", async () => {
    const { ctx } = await seededCtx();
    expect(((await duplicateClipsTool({ clip_ids: "x" }, ctx)) as Any).ok).toBe(false);
    expect(((await duplicateClipsTool({}, null)) as Any).ok).toBe(false);
  });
});

describe("pasteClipsTool", () => {
  it("inserts a clip clone at a frame on the target track", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30 }] },
      ctx,
    )) as Any;
    const track = (await loadTimeline(store)).tracks.find((t) => t.kind === "video")!;
    const original = findClipById(await loadTimeline(store), r.created[0].clip_id);
    const paste = (await pasteClipsTool(
      { clips: [original], track_id: track.id, at: 60 },
      ctx,
    )) as Any;
    expect(paste.ok).toBe(true);
    const copy = findClipById(await loadTimeline(store), paste.new_clip_ids[0]);
    expect([copy.timeline_in, copy.timeline_out]).toEqual([60, 90]);
    expect(copy.media_ref).toBe("a.png");
    expect(copy.id).not.toBe(r.created[0].clip_id);
  });

  it("errors on an unknown track and a non-list clips", async () => {
    const { ctx } = await seededCtx();
    expect(
      (
        (await pasteClipsTool(
          {
            clips: [{ media_ref: "x", timeline_in: 0, timeline_out: 10 }],
            track_id: "nope",
            at: 0,
          },
          ctx,
        )) as Any
      ).ok,
    ).toBe(false);
    expect(((await pasteClipsTool({ clips: "x" }, ctx)) as Any).ok).toBe(false);
    expect(((await pasteClipsTool({}, null)) as Any).ok).toBe(false);
  });
});

describe("applyTransitionTool", () => {
  async function twoImages(): Promise<{ ctx: Any; store: Any; second: string }> {
    const { ctx, store } = await seededCtx();
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "a.png", timeline_in: 0, timeline_out: 60 },
          { media_ref: "b.png", timeline_in: 60, timeline_out: 120 },
        ],
      },
      ctx,
    )) as Any;
    return { ctx, store, second: r.created[1].clip_id as string };
  }

  it("sets a transition without shifting the abutting clip (non-shifting B)", async () => {
    const { ctx, store, second } = await twoImages();
    const res = (await applyTransitionTool(
      { clip_id: second, transition_in: { kind: "crossfade", duration: 15 } },
      ctx,
    )) as Any;
    expect(res.ok).toBe(true);
    const b = findClipById(await loadTimeline(store), second);
    expect([b.timeline_in, b.timeline_out]).toEqual([60, 120]); // NOT shifted — clips abut, crossfade is render-side
    expect(b.transition_in).toEqual({ kind: "crossfade", duration: 15 });
  });

  it("carries a custom expr and clears the transition (non-shifting)", async () => {
    const { ctx, store, second } = await twoImages();
    await applyTransitionTool(
      { clip_id: second, transition_in: { kind: "custom", duration: 12, expr: "A*B" } },
      ctx,
    );
    let b = findClipById(await loadTimeline(store), second);
    expect(b.transition_in).toEqual({ kind: "custom", duration: 12, expr: "A*B" });
    expect([b.timeline_in, b.timeline_out]).toEqual([60, 120]); // NOT shifted
    await applyTransitionTool({ clip_id: second, transition_in: null }, ctx);
    b = findClipById(await loadTimeline(store), second);
    expect(b.transition_in).toBeUndefined();
    expect([b.timeline_in, b.timeline_out]).toEqual([60, 120]);
  });

  it("errors without a preceding clip, when too long, and without ctx", async () => {
    const { ctx } = await seededCtx();
    const solo = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    expect(
      (
        (await applyTransitionTool(
          { clip_id: solo.created[0].id, transition_in: { kind: "crossfade", duration: 15 } },
          ctx,
        )) as Any
      ).ok,
    ).toBe(false);
    const { ctx: ctx2, second } = await twoImages();
    expect(
      (
        (await applyTransitionTool(
          { clip_id: second, transition_in: { kind: "crossfade", duration: 90 } },
          ctx2,
        )) as Any
      ).ok,
    ).toBe(false); // > clip length
    expect(
      ((await applyTransitionTool({ clip_id: "x", transition_in: null }, null)) as Any).ok,
    ).toBe(false);
  });
});

describe("removeClipsTool", () => {
  it("removes a clip and its linked partner", async () => {
    const { ctx, store, videoId } = await withVideoAudio();
    const r = (await removeClipsTool({ clip_ids: [videoId] }, ctx)) as Any;
    expect(r.removed).toBe(2);
    const tl = await loadTimeline(store);
    expect(tl.tracks.every((t) => (t.clips ?? []).length === 0)).toBe(true);
  });
  it("errors on no match and a non-list clip_ids", async () => {
    const { ctx } = await seededCtx();
    expect(((await removeClipsTool({ clip_ids: ["nope"] }, ctx)) as Any).ok).toBe(false);
    expect(((await removeClipsTool({ clip_ids: "x" }, ctx)) as Any).ok).toBe(false);
  });
});

describe("rippleDeleteTool", () => {
  it("deletes a span and shifts later clips left", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      {
        entries: [
          { media_ref: "a.mp4", timeline_in: 0, timeline_out: 30 },
          { media_ref: "b.mp4", timeline_in: 30, timeline_out: 60 },
        ],
      },
      ctx,
    );
    const r = (await rippleDeleteTool({ track_id: "v1", start: 0, end: 30 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.removed_span).toBe(30);
    const clips = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips!;
    expect(clips.length).toBe(1);
    expect([clips[0].timeline_in, clips[0].timeline_out]).toEqual([0, 30]);
  });
  it("returns a mutation delta: removed_ids + a collapsed shifted rule", async () => {
    const { ctx } = await seededCtx(videoRunner);
    await addClipsTool(
      {
        entries: [
          { media_ref: "a.mp4", timeline_in: 0, timeline_out: 30, track_id: "v2" },
          { media_ref: "b.mp4", timeline_in: 30, timeline_out: 60, track_id: "v2" },
          { media_ref: "c.mp4", timeline_in: 60, timeline_out: 90, track_id: "v2" },
          { media_ref: "d.mp4", timeline_in: 90, timeline_out: 120, track_id: "v2" },
        ],
      },
      ctx,
    );
    // delete [0,30): clip a is removed; b,c,d slide left by 30 (run of 3 -> one rule)
    const r = (await rippleDeleteTool({ track_id: "v2", start: 0, end: 30 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.removed_ids).toHaveLength(1);
    expect(r.shifted).toEqual([{ track: "v2", from_frame: 30, by: -30, count: 3 }]);
  });
  it("errors on an unknown track and a bad range", async () => {
    const { ctx } = await seededCtx();
    expect(((await rippleDeleteTool({ track_id: "nope", start: 0, end: 10 }, ctx)) as Any).ok).toBe(
      false,
    );
    expect(((await rippleDeleteTool({}, null)) as Any).ok).toBe(false);
  });
  it("drops a linked clip in the span and shifts a linked clip after it", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    await addClipsTool(
      {
        entries: [
          { media_ref: "a.mp4", timeline_in: 0, timeline_out: 30 },
          { media_ref: "b.mp4", timeline_in: 60, timeline_out: 90 },
        ],
      },
      ctx,
    );
    expect(((await rippleDeleteTool({ track_id: "v1", start: 0, end: 30 }, ctx)) as Any).ok).toBe(
      true,
    );
    const tl = await loadTimeline(store);
    const v2 = tl.tracks.find((t) => t.id === "v1")!.clips!;
    expect(v2.length).toBe(1);
    expect([v2[0].timeline_in, v2[0].timeline_out]).toEqual([30, 60]);
    const audioClips = tl.tracks
      .filter((t) => t.kind === "audio" && t.id !== "music")
      .flatMap((t) => t.clips ?? []);
    expect(audioClips.length).toBe(1);
    expect([audioClips[0].timeline_in, audioClips[0].timeline_out]).toEqual([30, 60]);
  });
  it("trims clips at the range boundaries instead of dropping them", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      {
        entries: [
          { media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 },
          { media_ref: "b.mp4", timeline_in: 60, timeline_out: 90 },
        ],
      },
      ctx,
    );
    // [40,80) straddles a's tail and b's head → a trims to [0,40], b's tail shifts left.
    const r = (await rippleDeleteTool({ track_id: "v1", start: 40, end: 80 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.removed_span).toBe(40);
    const clips = (await loadTimeline(store)).tracks
      .find((t) => t.id === "v1")!
      .clips!.slice()
      .sort((a, b) => (a.timeline_in as number) - (b.timeline_in as number));
    expect(clips.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 40],
      [40, 50],
    ]);
  });
  it("deletes multiple ranges in one call (batch), applied back-to-front", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    );
    const r = (await rippleDeleteTool(
      {
        track_id: "v1",
        ranges: [
          { start: 10, end: 20 },
          { start: 40, end: 50 },
        ],
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.removed_span).toBe(20);
    expect(r.ranges).toBe(2);
    const clips = (await loadTimeline(store)).tracks
      .find((t) => t.id === "v1")!
      .clips!.slice()
      .sort((a, b) => (a.timeline_in as number) - (b.timeline_in as number));
    expect(clips.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 10],
      [10, 30],
      [30, 70],
    ]);
  });
  it("merges overlapping ranges and errors without a window", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    );
    const r = (await rippleDeleteTool(
      {
        track_id: "v1",
        ranges: [
          { start: 10, end: 40 },
          { start: 30, end: 60 },
        ],
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.removed_span).toBe(50); // [10,40]+[30,60] merge to [10,60]
    expect(r.ranges).toBe(1);
    const clips = (await loadTimeline(store)).tracks
      .find((t) => t.id === "v1")!
      .clips!.map((c) => [c.timeline_in, c.timeline_out])
      .sort((a, b) => (a[0] as number) - (b[0] as number));
    expect(clips).toEqual([
      [0, 10],
      [10, 40],
    ]);
    expect(((await rippleDeleteTool({ track_id: "v1" }, ctx)) as Any).ok).toBe(false);
  });

  it("coerces both track_id and clip_id to clip_id, with a note", async () => {
    const { ctx } = await seededCtx(videoRunner);
    const a = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    )) as Any;
    const clipId = a.created[0].clip_id as string;
    const r = (await rippleDeleteTool(
      { track_id: "v2", clip_id: clipId, start: 10, end: 20 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.removed_span).toBe(10);
    expect(String((r.notes ?? []).join(" "))).toContain("used clip_id");
  });

  it("coerces the synclock_ripple thrash: track_id + clip_id + ranges + start/end at once", async () => {
    // The exact over-specified ripple_delete gpt-5.4 sent in the synclock_ripple eval;
    // pre-fence it errored ("pass track_id OR clip_id, not both"). Now clip_id wins over
    // track_id AND the ranges list wins over the single start/end, so the one call succeeds.
    const { ctx } = await seededCtx(videoRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, track_id: "v2" }] },
      ctx,
    );
    const b = (await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 60, timeline_out: 120, track_id: "v2" }] },
      ctx,
    )) as Any;
    const bId = b.created[0].clip_id as string;
    const r = (await rippleDeleteTool(
      {
        track_id: "v2",
        clip_id: bId,
        ranges: [{ start: 60, end: 120 }],
        start: 60,
        end: 120,
        ignore_sync_locked_tracks: ["a3"],
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const notes = String((r.notes ?? []).join(" "));
    expect(notes).toContain("used clip_id");
    expect(notes).toContain("used the ranges list");
  });

  it("falls back to track_id when clip_id doesn't resolve, with a note", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90, track_id: "v2" }] },
      ctx,
    );
    // clip_id is bogus -> the cut falls back to the (valid) track_id.
    const r = (await rippleDeleteTool(
      { clip_id: "ghost", track_id: "v2", start: 10, end: 20 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.track).toBe("v2"); // used the track, not a clip
    expect(r.removed_span).toBe(10);
    expect(String((r.notes ?? []).join(" "))).toContain("didn't match any clip");
    const v2 = (await loadTimeline(store)).tracks.find((t) => t.id === "v2")!.clips!;
    expect(Math.max(...v2.map((c) => c.timeline_out as number))).toBe(80); // 10f rippled out of 90
  });

  it("errors when neither clip_id nor track_id resolves", async () => {
    const { ctx } = await seededCtx(videoRunner);
    const r = (await rippleDeleteTool(
      { clip_id: "ghost", track_id: "nope", start: 0, end: 10 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("matched anything");
  });
});

describe("rippleDeleteTool — sync lock", () => {
  it("shifts a sync-locked bystander track's later clips left with the cut", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, track_id: "v2" }] },
      ctx,
    );
    await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 60, timeline_out: 90, track_id: "v1" }] },
      ctx,
    );
    expect(((await rippleDeleteTool({ track_id: "v2", start: 0, end: 30 }, ctx)) as Any).ok).toBe(
      true,
    );
    const v1 = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips!;
    expect([v1[0].timeline_in, v1[0].timeline_out]).toEqual([30, 60]); // slid left by the 30f cut
  });

  it("refuses atomically and names a sync-locked lane that can't absorb the ripple", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90, track_id: "v2" }] },
      ctx,
    );
    await addClipsTool(
      { entries: [{ media_ref: "s.mp4", timeline_in: 0, timeline_out: 50, track_id: "v1" }] },
      ctx,
    );
    await addClipsTool(
      { entries: [{ media_ref: "t.mp4", timeline_in: 70, timeline_out: 90, track_id: "v1" }] },
      ctx,
    );
    const r = (await rippleDeleteTool({ track_id: "v2", start: 40, end: 70 }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("v1"); // names the blocking lane
    // atomic: neither the anchor nor the sync lane moved
    const tl = await loadTimeline(store);
    const v1 = tl.tracks
      .find((t) => t.id === "v1")!
      .clips!.slice()
      .sort((a, b) => (a.timeline_in as number) - (b.timeline_in as number));
    expect(v1.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 50],
      [70, 90],
    ]);
    expect(
      tl.tracks.find((t) => t.id === "v2")!.clips!.map((c) => [c.timeline_in, c.timeline_out]),
    ).toEqual([[0, 90]]);
  });

  it("ignore_sync_locked_tracks exempts a lane so the ripple proceeds", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90, track_id: "v2" }] },
      ctx,
    );
    await addClipsTool(
      { entries: [{ media_ref: "s.mp4", timeline_in: 0, timeline_out: 50, track_id: "v1" }] },
      ctx,
    );
    await addClipsTool(
      { entries: [{ media_ref: "t.mp4", timeline_in: 70, timeline_out: 90, track_id: "v1" }] },
      ctx,
    );
    const r = (await rippleDeleteTool(
      { track_id: "v2", start: 40, end: 70, ignore_sync_locked_tracks: ["v1"] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true); // v1 exempted -> no overlap check, edit lands
    const v1 = (await loadTimeline(store)).tracks
      .find((t) => t.id === "v1")!
      .clips!.slice()
      .sort((a, b) => (a.timeline_in as number) - (b.timeline_in as number));
    expect(v1.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 50],
      [70, 90],
    ]); // untouched
  });

  it("a sync_locked:false lane is left in place by the ripple", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, track_id: "v2" }] },
      ctx,
    );
    await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 60, timeline_out: 90, track_id: "v1" }] },
      ctx,
    );
    expect((await setTrackTool({ track_id: "v1", sync_locked: false }, ctx)).ok).toBe(true);
    expect(((await rippleDeleteTool({ track_id: "v2", start: 0, end: 30 }, ctx)) as Any).ok).toBe(
      true,
    );
    const v1 = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips!;
    expect([v1[0].timeline_in, v1[0].timeline_out]).toEqual([60, 90]); // NOT shifted
  });
});

describe("duplicate/paste — sync lock", () => {
  it("duplicate ripples a sync-locked bystander lane", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    const a = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30, track_id: "v2" }] },
      ctx,
    )) as Any;
    await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 30, timeline_out: 60, track_id: "v1" }] },
      ctx,
    );
    expect(((await duplicateClipsTool({ clip_ids: [a.created[0].clip_id] }, ctx)) as Any).ok).toBe(
      true,
    );
    const v1 = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips!;
    expect([v1[0].timeline_in, v1[0].timeline_out]).toEqual([60, 90]); // pushed right by the 30f duplicate
  });

  it("paste-insert ripples a sync-locked bystander lane", async () => {
    const { ctx, store } = await seededCtx(videoRunner);
    const a = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30, track_id: "v2" }] },
      ctx,
    )) as Any;
    await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    );
    const clip = findClipById(await loadTimeline(store), a.created[0].clip_id);
    expect(((await pasteClipsTool({ clips: [clip], track_id: "v2", at: 0 }, ctx)) as Any).ok).toBe(
      true,
    );
    const v1 = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips!;
    expect([v1[0].timeline_in, v1[0].timeline_out]).toEqual([30, 60]); // pushed right by the paste
  });
});

describe("normalizeLinks", () => {
  const tl = (v: Any, a: Any): Any => ({
    units: "frames",
    canvas: { width: 100, height: 100, fps: 30 },
    tracks: [
      { id: "v1", kind: "video", clips: [v] },
      { id: "a1", kind: "audio", clips: [a] },
    ],
  });
  it("locks a same-source split A/V pair's speed + length to the video lead", () => {
    const t = tl(
      {
        id: "v",
        media_ref: "a.mp4",
        link_group: "g",
        timeline_in: 0,
        timeline_out: 50,
        source_in: 0,
        source_out: 60,
        speed: 1.2,
      },
      {
        id: "a",
        kind: "audio",
        media_ref: "a.mp4",
        link_group: "g",
        timeline_in: 0,
        timeline_out: 60,
        source_in: 0,
        source_out: 60,
      },
    );
    normalizeLinks(t);
    expect(t.tracks[1].clips[0].speed).toBe(1.2); // inherited from the video lead
    expect(t.tracks[1].clips[0].timeline_out).toBe(50); // length locked to the video
  });
  it("preserves a J/L start offset while locking length, and clears speed when the lead has none", () => {
    const t = tl(
      { id: "v", media_ref: "a.mp4", link_group: "g", timeline_in: 10, timeline_out: 60 },
      {
        id: "a",
        kind: "audio",
        media_ref: "a.mp4",
        link_group: "g",
        timeline_in: 5,
        timeline_out: 99,
        speed: 2,
      },
    );
    normalizeLinks(t);
    const a = t.tracks[1].clips[0];
    expect(a.timeline_in).toBe(5); // offset preserved
    expect(a.timeline_out).toBe(55); // 5 + (60-10) length
    expect(a.speed).toBeUndefined(); // lead has no speed -> partner's is cleared
  });
  it("only groups a CROSS-source user link -- keeps its own speed + length", () => {
    const t = tl(
      {
        id: "v",
        media_ref: "a.mp4",
        link_group: "g",
        timeline_in: 0,
        timeline_out: 50,
        speed: 1.2,
      },
      {
        id: "m",
        kind: "audio",
        media_ref: "music.mp3",
        link_group: "g",
        timeline_in: 0,
        timeline_out: 300,
        speed: 1,
      },
    );
    normalizeLinks(t);
    const m = t.tracks[1].clips[0];
    expect(m.timeline_out).toBe(300); // longer music NOT truncated to the video
    expect(m.speed).toBe(1); // own speed preserved
  });
});

describe("link/unlink tools", () => {
  it("links two clips into one group and unlinks the group", async () => {
    const { ctx, store } = await seededCtx();
    const r1 = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    )) as Any;
    const r2 = (await addClipsTool(
      { entries: [{ media_ref: "b.png", timeline_in: 0, timeline_out: 30, track_id: "v2" }] },
      ctx,
    )) as Any;
    const id1 = r1.created[0].clip_id as string;
    const id2 = r2.created[0].clip_id as string;
    expect(((await linkClipsTool({ clip_ids: [id1, id2] }, ctx)) as Any).ok).toBe(true);
    let t = await loadTimeline(store);
    const g = findClipById(t, id1).link_group;
    expect(g).toBeTruthy();
    expect(findClipById(t, id2).link_group).toBe(g); // shared group
    expect(((await unlinkClipsTool({ clip_ids: [id1] }, ctx)) as Any).ok).toBe(true);
    t = await loadTimeline(store);
    expect(findClipById(t, id1).link_group).toBeUndefined();
    expect(findClipById(t, id2).link_group).toBeUndefined(); // partner unlinked too
  });
  it("rejects linking < 2 clips and unlinking an unlinked clip", async () => {
    const { ctx } = await seededCtx();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.png", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    )) as Any;
    expect(((await linkClipsTool({ clip_ids: [r.created[0].clip_id] }, ctx)) as Any).ok).toBe(
      false,
    );
    expect(((await unlinkClipsTool({ clip_ids: [r.created[0].clip_id] }, ctx)) as Any).ok).toBe(
      false,
    );
  });
});

// --- Branch hardening (mutation): assert the SPECIFIC reject message on BOTH the
// degenerate (==) and strictly-inverted (<) boundary, so the <= guards can't be
// mutated to < (nor the conditionals forced constant) without a test noticing.
describe("edit ops -- branch hardening", () => {
  async function withPlain(): Promise<{ ctx: Any; id: string }> {
    const { ctx } = await seededCtx(videoRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    return { ctx, id: r.created[0].clip_id as string };
  }
  it("trim rejects a degenerate (==) and inverted (<) SOURCE span with the source message", async () => {
    for (const span of [
      { source_in: 2, source_out: 2 },
      { source_in: 3, source_out: 1 },
    ]) {
      const { ctx, id } = await withPlain();
      const r = (await trimClipsTool({ trims: [{ clip_id: id, ...span }] }, ctx)) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("source_out must be after source_in");
    }
  });
  it("trim rejects a degenerate and inverted TIMELINE span with the timeline message", async () => {
    for (const span of [
      { timeline_in: 20, timeline_out: 20 },
      { timeline_in: 40, timeline_out: 10 },
    ]) {
      const { ctx, id } = await withPlain();
      const r = (await trimClipsTool({ trims: [{ clip_id: id, ...span }] }, ctx)) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("timeline_out must be after timeline_in");
    }
  });
  it("split rejects at the boundaries (==) and outside, with the strictly-inside message", async () => {
    for (const at of [0, 60, 90]) {
      const { ctx, id } = await withPlain();
      const r = (await splitClipsTool({ splits: [{ clip_id: id, at }] }, ctx)) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("must be strictly inside the clip");
    }
  });
  it("move requires to_timeline_in and/or to_track", async () => {
    const { ctx, id } = await withPlain();
    const r = (await moveClipsTool({ moves: [{ clip_id: id }] }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("needs to_timeline_in and/or to_track");
  });
});
