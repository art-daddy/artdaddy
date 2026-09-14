import { describe, expect, it } from "vitest";

import { findClipById, seededCtx, audioRunner, makeRunner, videoRunner } from "../test/timelineKit";
import { ctxApplyOp, loadTimeline } from "./engine";
import { addClipsTool, addTextClipsTool, clearDurationCache, clearHasAudioCache } from "./placement";
import { clearSourceDimsCache } from "./sourceDims";
import {
  applyColorTool,
  applyEffectsTool,
  setClipPropertiesTool,
  setKeyframesTool,
  setTransitionTool,
} from "./props";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function withVideo(): Promise<{ ctx: Any; store: Any; id: string }> {
  const { ctx, store } = await seededCtx(videoRunner);
  const r = (await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    ctx,
  )) as Any;
  return { ctx, store, id: r.created[0].clip_id as string };
}

async function withAudio(): Promise<{ ctx: Any; store: Any; id: string }> {
  const { ctx, store } = await seededCtx(audioRunner);
  const r = (await addClipsTool(
    { entries: [{ media_ref: "bed.mp3", timeline_in: 0, timeline_out: 60 }] },
    ctx,
  )) as Any;
  return { ctx, store, id: r.created[0].clip_id as string };
}

describe("setClipPropertiesTool", () => {
  it("sets then removes properties", async () => {
    const { ctx, store, id } = await withVideo();
    await setClipPropertiesTool(
      { clip_ids: [id], properties: { opacity: 0.5, layout: { x: 0, y: 0, w: 100, h: 100 } } },
      ctx,
    );
    let clip = findClipById(await loadTimeline(store), id);
    expect(clip.opacity).toBe(0.5);
    expect(clip.layout.w).toBe(100);
    await setClipPropertiesTool({ clip_ids: [id], properties: { opacity: null } }, ctx);
    expect(findClipById(await loadTimeline(store), id).opacity).toBeUndefined();
  });
  it("accepts flattened typed top-level properties (agent path)", async () => {
    const { ctx, store, id } = await withVideo();
    await setClipPropertiesTool(
      { clip_ids: [id], opacity: 0.4, rotate: 90, transform: { scale: 1.5 } },
      ctx,
    );
    const clip = findClipById(await loadTimeline(store), id);
    expect(clip.opacity).toBe(0.4);
    expect(clip.rotate).toBe(90);
    expect(clip.transform).toEqual({ scale: 1.5 });
  });
  it("resizes a clip in place via duration and fills a longer span with loop (audio)", async () => {
    const { ctx, store, id } = await withAudio();
    const r = (await setClipPropertiesTool(
      { clip_ids: [id], duration: 120, loop: true },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const clip = findClipById(await loadTimeline(store), id);
    expect(clip.timeline_out).toBe(120); // timeline_in 0 + duration 120, past the original 60f span
    expect(clip.loop).toBe(true);
    expect(clip.duration).toBeUndefined(); // relative length is converted, never stored raw
  });
  it("applies duration per-clip so it is safe to batch (t009 fix)", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "a.mp3", timeline_in: 0, timeline_out: 60 },
          { media_ref: "b.mp3", timeline_in: 100, timeline_out: 160 },
        ],
      },
      ctx,
    )) as Any;
    const ids = r.created.map((c: Any) => c.clip_id as string);
    await setClipPropertiesTool({ clip_ids: ids, duration: 30 }, ctx);
    const clips = (await loadTimeline(store)).tracks.flatMap((t: Any) => t.clips ?? []) as Any[];
    for (const c of clips) expect(c.timeline_out).toBe(c.timeline_in + 30); // each keeps its own start
  });
  it("propagates speed to linked audio even when duration is set (t008 regression)", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "v.mp4", timeline_in: 0, timeline_out: 60, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    const videoId = r.created[0].clip_id as string;
    const audioId = r.created[1].clip_id as string; // the split linked audio
    await setClipPropertiesTool({ clip_ids: [videoId], speed: 1.2, duration: 50 }, ctx);
    const audio = findClipById(await loadTimeline(store), audioId);
    expect(audio.speed).toBe(1.2); // inherits speed despite the explicit duration
    expect(audio.timeline_out).toBe(50); // and stays length-locked to the video
  });
  it("propagates fade/volume to the linked audio partner (not a video no-op)", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "v.mp4", timeline_in: 0, timeline_out: 60, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    const videoId = r.created[0].clip_id as string;
    const audioId = r.created[1].clip_id as string; // the split linked audio
    // fade/volume only render on audio clips — setting them on the video clip must
    // reach its linked audio partner instead of silently no-op'ing.
    await setClipPropertiesTool({ clip_ids: [videoId], fade: { in: 6, out: 6 }, volume: 0.5 }, ctx);
    const audio = findClipById(await loadTimeline(store), audioId);
    expect(audio.fade).toEqual({ in: 6, out: 6 });
    expect(audio.volume).toBe(0.5);
  });
  it("errors on empty properties, unknown clip, and non-list ids", async () => {
    const { ctx } = await seededCtx();
    expect(
      ((await setClipPropertiesTool({ clip_ids: ["x"], properties: {} }, ctx)) as Any).ok,
    ).toBe(false);
    expect(
      (
        (await setClipPropertiesTool(
          { clip_ids: ["nope"], properties: { opacity: 1 } },
          ctx,
        )) as Any
      ).ok,
    ).toBe(false);
    expect(
      ((await setClipPropertiesTool({ clip_ids: "x", properties: { opacity: 1 } }, ctx)) as Any).ok,
    ).toBe(false);
    expect(((await setClipPropertiesTool({}, null)) as Any).ok).toBe(false);
  });
});

// ── source window: trimming and slipping (contract 1.7.0, replaces trim_clips) ──
// These assert the SAVED TIMELINE, not the arguments. The bug that motivated the
// whole design shipped with a green suite because nothing checked the artifact:
// the model set source_in, the clip slipped, and the reply said "trimmed".
describe("setClipPropertiesTool -- source window", () => {
  /** ffprobe that reports a video-only stream AND a real duration, so the
   *  out-of-bounds clamp has something to clamp against. */
  const boundedRunner = (seconds: number) =>
    makeRunner((p, a) => {
      if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
      if (a.includes("-select_streams"))
        return {
          code: 0,
          stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "",
          stderr: "",
        };
      if (a.some((x) => x.includes("format=duration")))
        return { code: 0, stdout: String(seconds), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });

  async function clip3s(runner?: Any): Promise<{ ctx: Any; store: Any; id: string }> {
    clearDurationCache();
    const { ctx, store } = await seededCtx(runner ?? videoRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90, source_span: [0, 3] }] },
      ctx,
    )) as Any;
    return { ctx, store, id: r.created[0].clip_id as string };
  }

  it("source_in ALONE slips: the clip keeps its length and its position", async () => {
    const { ctx, store, id } = await clip3s();
    await setClipPropertiesTool({ clip_ids: [id], source_in: 30 }, ctx);
    const c = findClipById(await loadTimeline(store), id);
    expect([c.timeline_in, c.timeline_out]).toEqual([0, 90]);
    expect([c.source_in, c.source_out]).toEqual([30, 120]);
  });

  it("source_in + duration TRIMS: shorter clip, head moved, still at frame 0", async () => {
    const { ctx, store, id } = await clip3s();
    await setClipPropertiesTool({ clip_ids: [id], source_in: 30, duration: 60 }, ctx);
    const c = findClipById(await loadTimeline(store), id);
    expect([c.timeline_in, c.timeline_out]).toEqual([0, 60]);
    expect([c.source_in, c.source_out]).toEqual([30, 90]);
  });

  it("an explicit source_out SURVIVES the save -- it is never re-derived", async () => {
    const { ctx, store, id } = await clip3s();
    await setClipPropertiesTool({ clip_ids: [id], source_in: 15, source_out: 45 }, ctx);
    const c = findClipById(await loadTimeline(store), id);
    expect([c.source_in, c.source_out]).toEqual([15, 45]);
    expect(c.timeline_out - c.timeline_in).toBe(30); // length followed the window
  });

  it("rejects an inverted window instead of silently repairing it", async () => {
    const { ctx, store, id } = await clip3s();
    const r = (await setClipPropertiesTool(
      { clip_ids: [id], source_in: 60, source_out: 30 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    const c = findClipById(await loadTimeline(store), id);
    expect([c.source_in, c.source_out]).toEqual([0, 90]); // untouched
  });

  it("clamps past the end of the real source and SAYS so", async () => {
    const { ctx, store, id } = await clip3s(boundedRunner(4)); // 4s = 120 frames
    const r = (await setClipPropertiesTool(
      { clip_ids: [id], source_in: 60, duration: 120 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const c = findClipById(await loadTimeline(store), id);
    expect(c.source_out).toBe(120); // never past EOF
    expect(c.source_in).toBe(60); // the head they named was NOT moved
    expect(String((r.notes ?? []).join(" "))).toContain("shortened");
  });

  it("an unprobeable source is edited unclamped rather than blocked", async () => {
    const { ctx, store, id } = await clip3s(); // videoRunner reports no duration
    const r = (await setClipPropertiesTool({ clip_ids: [id], source_in: 9000 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(findClipById(await loadTimeline(store), id).source_in).toBe(9000);
  });

  it("a slip drags the LINKED AUDIO so A/V cannot desync", async () => {
    clearDurationCache();
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "v.mp4", timeline_in: 0, timeline_out: 60, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    const [videoId, audioId] = r.created.map((c: Any) => c.clip_id as string);
    await setClipPropertiesTool({ clip_ids: [videoId], source_in: 30 }, ctx);
    const audio = findClipById(await loadTimeline(store), audioId);
    expect(audio.source_in).toBe(30);
    expect(audio.timeline_out - audio.timeline_in).toBe(60);
  });

  it("a bare duration does NOT invent a source window on a text clip", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addTextClipsTool(
      { entries: [{ content: "hi", timeline_in: 0, duration: 60 }] },
      ctx,
    )) as Any;
    const id = r.created[0].clip_id as string;
    await setClipPropertiesTool({ clip_ids: [id], duration: 30 }, ctx);
    const c = findClipById(await loadTimeline(store), id);
    expect(c.timeline_out).toBe(30);
    expect(c.source_in).toBeUndefined();
    expect(c.source_out).toBeUndefined();
  });

  it("a loop clip keeps filling its slot -- duration does not retrim it", async () => {
    clearDurationCache();
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "bed.mp3", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    const id = r.created[0].clip_id as string;
    await setClipPropertiesTool({ clip_ids: [id], loop: true, duration: 300 }, ctx);
    const c = findClipById(await loadTimeline(store), id);
    expect(c.timeline_out).toBe(300); // fills the slot from a shorter source
    expect(c.loop).toBe(true);
  });
});

// Replacing a shot used to mean remove_clips + add_clips, which drops the grade, the transform and
// every keyframe: done eight times in one session, and a missed re-apply ships an UNGRADED shot —
// silent, because the clip is still there and still the right length.
describe("swapping a clip's media in place", () => {
  const graded = async () => {
    const { ctx, store, id } = await withVideo();
    await setClipPropertiesTool(
      { clip_ids: [id], transform: { scale: 1.2 }, opacity: 0.8, fit: "cover" },
      ctx,
    );
    await applyColorTool({ clip_ids: [id], saturation: 0.7, contrast: 1.3 }, ctx);
    await setKeyframesTool(
      {
        clip_id: id,
        property: "opacity",
        keyframes: [
          { t: 0, v: 0 },
          { t: 30, v: 1 },
        ],
      },
      ctx,
    );
    return { ctx, store, id };
  };

  it("keeps the grade, the transform and the keyframes", async () => {
    const { ctx, store, id } = await graded();
    const before = findClipById(await loadTimeline(store), id);

    const r = (await setClipPropertiesTool({ clip_ids: [id], media_ref: "b.mp4" }, ctx)) as Any;
    expect(r.ok).toBe(true);

    const after = findClipById(await loadTimeline(store), id);
    expect(after.media_ref).toBe("b.mp4"); // the one thing that changed
    expect(after.color).toEqual(before.color);
    expect(after.transform).toEqual(before.transform);
    expect(after.opacity).toEqual(before.opacity); // the keyframe track, not a scalar
    expect(after.fit).toBe("cover");
    expect(after.id).toBe(id); // the id survives, so every later edit still addresses it
  });

  it("keeps the slot, so nothing downstream has to move", async () => {
    const { ctx, store, id } = await graded();
    await setClipPropertiesTool({ clip_ids: [id], media_ref: "b.mp4" }, ctx);
    const c = findClipById(await loadTimeline(store), id);
    expect([c.timeline_in, c.timeline_out]).toEqual([0, 60]);
    expect([c.source_in, c.source_out]).toEqual([0, 60]); // and reads from the top of the new take
  });

  it("shortens the clip when the replacement is shorter, and says so", async () => {
    clearDurationCache();
    // ffprobe reports 1s of media against a 60-frame (2s) slot.
    const shortRunner = makeRunner((p, a) => {
      if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
      if (a.includes("-select_streams"))
        return { code: 0, stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "", stderr: "" };
      return { code: 0, stdout: "1.0", stderr: "" };
    });
    const { ctx, store } = await seededCtx(shortRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    const id = r.created[0].clip_id as string;

    const swap = (await setClipPropertiesTool({ clip_ids: [id], media_ref: "b.mp4" }, ctx)) as Any;
    const c = findClipById(await loadTimeline(store), id);
    // A clip may never claim frames past the end of its own footage — the rule sourceWindow exists
    // for, applied to the new source rather than the one being replaced.
    expect(c.source_out as number).toBeLessThanOrEqual(30);
    expect(c.timeline_out as number).toBeLessThan(60);
    expect(String((swap.notes as string[]).join(" "))).toMatch(/shorter than the slot/);
  });

  it("moves the linked audio to the new source too", async () => {
    clearDurationCache();
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    const vid = r.created[0].clip_id as string;
    const aud = r.created[1].clip_id as string;

    await setClipPropertiesTool({ clip_ids: [vid], media_ref: "b.mp4" }, ctx);

    const tl = await loadTimeline(store);
    // A pair pointing at two different sources is the desync the link exists to prevent.
    expect(findClipById(tl, aud).media_ref).toBe("b.mp4");
    expect(findClipById(tl, vid).media_ref).toBe("b.mp4");
  });

  // The reported symptom of doing this the old way: remove + add re-routed the audio to whatever
  // lane happened to be free, so it landed on a1 once and a NEW a2 the next time — and a1 was muted
  // at track level while a2 was not, so the mix changed without anyone touching it.
  it("leaves the linked audio on the track it was already on", async () => {
    clearDurationCache();
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    const vid = r.created[0].clip_id as string;
    const aud = r.created[1].clip_id as string;
    const trackOf = (tl: Any, id: string) =>
      tl.tracks.find((t: Any) => (t.clips ?? []).some((c: Any) => c.id === id))?.id;
    const audioTracks = (tl: Any) => tl.tracks.filter((t: Any) => t.kind === "audio").length;
    const start = await loadTimeline(store);
    const before = trackOf(start, aud);
    const lanesBefore = audioTracks(start);

    await setClipPropertiesTool({ clip_ids: [vid], media_ref: "b.mp4" }, ctx);

    const tl = await loadTimeline(store);
    expect(trackOf(tl, aud)).toBe(before);
    expect(audioTracks(tl)).toBe(lanesBefore); // and no new lane appeared for it to land on
  });

  it("drops the linked audio when the replacement has none", async () => {
    clearDurationCache();
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    const vid = r.created[0].clip_id as string;
    const aud = r.created[1].clip_id as string;

    // Same call, but now ffprobe says the replacement carries no audio stream.
    const silent = { ...ctx, runner: videoRunner };
    clearHasAudioCache();
    await setClipPropertiesTool({ clip_ids: [vid], media_ref: "b.mp4" }, silent);

    const tl = await loadTimeline(store);
    const ids = tl.tracks.flatMap((t) => (t.clips ?? []).map((c) => c.id));
    expect(ids).not.toContain(aud); // an audio clip with no audio to play is not silence, it is a bug
  });

  it("refuses a system path, like every other media argument", async () => {
    const { ctx, id } = await graded();
    for (const bad of ["C:/secret/passwords.mp4", "../../escape.mp4"]) {
      const r = (await setClipPropertiesTool({ clip_ids: [id], media_ref: bad }, ctx)) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("not a system path");
    }
  });

  it("is a real edit on its own — no other property required", async () => {
    const { ctx, id } = await graded();
    const r = (await setClipPropertiesTool({ clip_ids: [id], media_ref: "b.mp4" }, ctx)) as Any;
    expect(r.ok).toBe(true);
  });
});

describe("setKeyframesTool", () => {
  it("animates a scalar prop then clears it", async () => {
    const { ctx, store, id } = await withVideo();
    await setKeyframesTool(
      {
        clip_id: id,
        property: "opacity",
        keyframes: [
          { t: 0, v: 0 },
          { t: 30, v: 1, ease: "ease-in" },
        ],
      },
      ctx,
    );
    let clip = findClipById(await loadTimeline(store), id);
    expect(Array.isArray(clip.opacity)).toBe(true);
    expect(clip.opacity[1]).toEqual({ t: 30, v: 1, ease: "ease-in" });
    const cleared = (await setKeyframesTool(
      { clip_id: id, property: "opacity", keyframes: [] },
      ctx,
    )) as Any;
    expect(cleared.cleared).toBe(true);
    expect(findClipById(await loadTimeline(store), id).opacity).toBeUndefined();
  });
  it("animates position (a vector) and scale via set_keyframes", async () => {
    const { ctx, store, id } = await withVideo();
    // A position keyframe is a {t, x, y} vector -> splits into transform.position.x/y tracks.
    const rp = (await setKeyframesTool(
      {
        clip_id: id,
        property: "position",
        keyframes: [
          { t: 0, x: 0.2, y: 0.3 },
          { t: 30, x: 0.5, y: 0.3 },
        ],
      },
      ctx,
    )) as Any;
    expect(rp.ok).toBe(true);
    let clip = findClipById(await loadTimeline(store), id);
    expect(Array.isArray(clip.transform.position.x)).toBe(true);
    expect(clip.transform.position.x[1]).toEqual({ t: 30, v: 0.5 });
    expect(clip.transform.position.y[0]).toEqual({ t: 0, v: 0.3 });
    // scale is a scalar track under transform.
    const rs = (await setKeyframesTool(
      {
        clip_id: id,
        property: "scale",
        keyframes: [
          { t: 0, v: 1 },
          { t: 30, v: 1.4 },
        ],
      },
      ctx,
    )) as Any;
    expect(rs.ok).toBe(true);
    clip = findClipById(await loadTimeline(store), id);
    expect(Array.isArray(clip.transform.scale)).toBe(true);
  });
  it("rejects an unknown property and a non-list keyframes", async () => {
    const { ctx, id } = await withVideo();
    expect(
      ((await setKeyframesTool({ clip_id: id, property: "nope", keyframes: [] }, ctx)) as Any).ok,
    ).toBe(false);
    expect(
      ((await setKeyframesTool({ clip_id: id, property: "opacity", keyframes: "x" }, ctx)) as Any)
        .ok,
    ).toBe(false);
    expect(((await setKeyframesTool({}, null)) as Any).ok).toBe(false);
  });
  it("sorts keyframes by time and dedupes duplicate frames (last write wins)", async () => {
    const { ctx, store, id } = await withVideo();
    // Out-of-order rows with two rows on frame 10 — other NLEs: sorted by frame, last dupe wins.
    await setKeyframesTool(
      {
        clip_id: id,
        property: "opacity",
        keyframes: [
          { t: 30, v: 1 },
          { t: 10, v: 0.2 },
          { t: 0, v: 0 },
          { t: 10, v: 0.9 },
        ],
      },
      ctx,
    );
    const clip = findClipById(await loadTimeline(store), id);
    expect(clip.opacity).toEqual([
      { t: 0, v: 0 },
      { t: 10, v: 0.9 },
      { t: 30, v: 1 },
    ]);
  });
  it("sorts and dedupes a position vector track too", async () => {
    const { ctx, store, id } = await withVideo();
    await setKeyframesTool(
      {
        clip_id: id,
        property: "position",
        keyframes: [
          { t: 20, x: 0.9, y: 0.9 },
          { t: 0, x: 0.1, y: 0.1 },
          { t: 20, x: 0.5, y: 0.5 },
        ],
      },
      ctx,
    );
    const clip = findClipById(await loadTimeline(store), id);
    expect(clip.transform.position.x).toEqual([
      { t: 0, v: 0.1 },
      { t: 20, v: 0.5 },
    ]); // last dupe wins
    expect(clip.transform.position.y).toEqual([
      { t: 0, v: 0.1 },
      { t: 20, v: 0.5 },
    ]);
  });
  it("clears a position keyframe track", async () => {
    const { ctx, store, id } = await withVideo();
    await setKeyframesTool(
      {
        clip_id: id,
        property: "position",
        keyframes: [
          { t: 0, x: 0.2, y: 0.3 },
          { t: 30, x: 0.5, y: 0.6 },
        ],
      },
      ctx,
    );
    const cleared = (await setKeyframesTool(
      { clip_id: id, property: "position", keyframes: [] },
      ctx,
    )) as Any;
    expect(cleared.cleared).toBe(true);
    const clip = findClipById(await loadTimeline(store), id);
    expect(clip.transform.position.x).toBeUndefined();
    expect(clip.transform.position.y).toBeUndefined();
  });
});

describe("applyEffectsTool", () => {
  it("adds, merges by type, then removes effects", async () => {
    const { ctx, store, id } = await withVideo();
    await applyEffectsTool({ clip_ids: [id], add: [{ type: "blur", params: { radius: 5 } }] }, ctx);
    expect(findClipById(await loadTimeline(store), id).effects).toEqual([
      { type: "blur", params: { radius: 5 } },
    ]);
    await applyEffectsTool({ clip_ids: [id], add: [{ type: "blur", params: { radius: 8 } }] }, ctx);
    expect(findClipById(await loadTimeline(store), id).effects[0].params.radius).toBe(8);
    await applyEffectsTool({ clip_ids: [id], remove: ["blur"] }, ctx);
    expect(findClipById(await loadTimeline(store), id).effects).toBeUndefined();
  });
  it("echoes the resulting stack back to the CALLER, not just into the timeline", async () => {
    // The echo is only useful if it survives the receipt; assert the tool result itself.
    const { ctx, id } = await withVideo();
    const r = (await applyEffectsTool({ clip_ids: [id], add: [{ type: "glow" }] }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.effects[id]).toEqual([{ type: "glow", params: { intensity: 25 } }]);
  });

  it("errors when neither add nor remove given, or an effect lacks a type", async () => {
    const { ctx, id } = await withVideo();
    expect(((await applyEffectsTool({ clip_ids: [id] }, ctx)) as Any).ok).toBe(false);
    expect(
      ((await applyEffectsTool({ clip_ids: [id], add: [{ amount: 1 }] }, ctx)) as Any).ok,
    ).toBe(false);
    expect(
      ((await applyEffectsTool({ clip_ids: "x", add: [{ type: "bw" }] }, ctx)) as Any).ok,
    ).toBe(false);
  });
});

describe("applyColorTool", () => {
  it("echoes the resulting grade back to the CALLER, and clamps on the way", async () => {
    const { ctx, id } = await withVideo();
    const r = (await applyColorTool({ clip_ids: [id], exposure: 99 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.color[id]).toEqual({ exposure: 3 }); // clamped to the registry max, not stored raw
  });

  it("rejects an unknown knob instead of silently dropping it", async () => {
    const { ctx, store, id } = await withVideo();
    const r = (await applyColorTool({ clip_ids: [id], color: { warmth: 20 } }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("warmth");
    expect(findClipById(await loadTimeline(store), id).color).toBeUndefined();
  });

  it("merges then clears color", async () => {
    const { ctx, store, id } = await withVideo();
    await applyColorTool({ clip_ids: [id], color: { exposure: 0.2 } }, ctx);
    await applyColorTool({ clip_ids: [id], color: { contrast: 1.1 } }, ctx);
    expect(findClipById(await loadTimeline(store), id).color).toEqual({
      exposure: 0.2,
      contrast: 1.1,
    });
    await applyColorTool({ clip_ids: [id], color: null }, ctx);
    expect(findClipById(await loadTimeline(store), id).color).toBeUndefined();
  });
  it("accepts flattened typed knobs and reset-from-neutral", async () => {
    const { ctx, store, id } = await withVideo();
    await applyColorTool({ clip_ids: [id], exposure: 0.5, contrast: 1.2, saturation: 1.1 }, ctx);
    expect(findClipById(await loadTimeline(store), id).color).toEqual({
      exposure: 0.5,
      contrast: 1.2,
      saturation: 1.1,
    });
    // reset starts from neutral, dropping the prior knobs and keeping only the new one.
    await applyColorTool({ clip_ids: [id], reset: true, temperature: 5000 }, ctx);
    expect(findClipById(await loadTimeline(store), id).color).toEqual({ temperature: 5000 });
  });

  it("rejects an absolute lut and applies nothing (a lut must be a library asset)", async () => {
    const { ctx, store, id } = await withVideo();
    const r = (await applyColorTool({ clip_ids: [id], lut: "/etc/evil.cube" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not a system path");
    expect(findClipById(await loadTimeline(store), id).color).toBeUndefined(); // nothing applied
  });
  it("errors on a non-list ids", async () => {
    const { ctx } = await seededCtx();
    expect(((await applyColorTool({ clip_ids: "x", color: {} }, ctx)) as Any).ok).toBe(false);
  });
});

describe("setTransitionTool", () => {
  it("sets a transition on an abutting clip without shifting it, then clears", async () => {
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
    const id = r.created[1].clip_id as string;
    // Non-shifting (B): the clip stays abutting; the crossfade is render-side.
    expect(
      (
        (await setTransitionTool(
          { clip_id: id, transition_in: { kind: "crossfade", duration: 15 } },
          ctx,
        )) as Any
      ).ok,
    ).toBe(true);
    let b = findClipById(await loadTimeline(store), id);
    expect([b.timeline_in, b.timeline_out]).toEqual([60, 120]); // NOT shifted
    expect(b.transition_in).toEqual({ kind: "crossfade", duration: 15 });
    // Clearing just drops the field (clip stays put).
    expect(((await setTransitionTool({ clip_id: id, transition_in: null }, ctx)) as Any).ok).toBe(
      true,
    );
    b = findClipById(await loadTimeline(store), id);
    expect(b.transition_in).toBeUndefined();
    expect([b.timeline_in, b.timeline_out]).toEqual([60, 120]);
  });
  it("errors on unknown clip and without ctx", async () => {
    const { ctx } = await seededCtx();
    expect(
      ((await setTransitionTool({ clip_id: "nope", transition_in: null }, ctx)) as Any).ok,
    ).toBe(false);
    expect(((await setTransitionTool({}, null)) as Any).ok).toBe(false);
  });
});

// --- Branch hardening (mutation): tight assertions on BOTH sides of the real
// conditionals that survived mutation testing -- speed/length precedence, the
// rescaleForSpeed guard, effect-field routing, and stack emptying.
describe("setClipPropertiesTool -- branch hardening", () => {
  async function withSpanVideo(): Promise<{ ctx: Any; store: Any; id: string; out0: number }> {
    const { ctx, store } = await seededCtx(videoRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    const id = r.created[0].clip_id as string;
    const out0 = findClipById(await loadTimeline(store), id).timeline_out as number;
    return { ctx, store, id, out0 };
  }
  it("speed rescales the clip's OWN length when no explicit length is given", async () => {
    const { ctx, store, id, out0 } = await withSpanVideo();
    await setClipPropertiesTool({ clip_ids: [id], speed: 2 }, ctx);
    const out = findClipById(await loadTimeline(store), id).timeline_out as number;
    expect(out).toBeLessThan(out0); // 2x -> shorter: rescaleForSpeed ran
    expect(out).toBe(Math.round(out0 / 2));
  });
  it("an explicit duration OVERRIDES the speed rescale (explicitLen wins)", async () => {
    const { ctx, store, id } = await withSpanVideo();
    await setClipPropertiesTool({ clip_ids: [id], speed: 2, duration: 90 }, ctx);
    expect(findClipById(await loadTimeline(store), id).timeline_out).toBe(90); // in(0)+90, not the rescaled ~half
  });
  it("speed rescales a plain (no-span) clip by the factor and stays finite (no NaN)", async () => {
    const { ctx, store, id } = await withVideo(); // tl [0,60], numeric source window
    await setClipPropertiesTool({ clip_ids: [id], speed: 2 }, ctx);
    const out = findClipById(await loadTimeline(store), id).timeline_out as number;
    expect(Number.isFinite(out)).toBe(true); // guard did NOT wrongly divide by a non-number
    expect(out).toBe(30); // 60/2 -> rescaleForSpeed ran; not unchanged (60), not NaN
  });
  it("duration must be > 0: a zero duration does not resize", async () => {
    const { ctx, store, id } = await withVideo();
    const r = (await setClipPropertiesTool({ clip_ids: [id], duration: 0 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(findClipById(await loadTimeline(store), id).timeline_out).toBe(60); // not resized to in+0
  });
});

describe("applyEffectsTool -- branch hardening", () => {
  it("routes to `effects` for video and `audio_effects` for audio", async () => {
    const v = await withVideo();
    await applyEffectsTool(
      { clip_ids: [v.id], add: [{ type: "blur", params: { radius: 4 } }] },
      v.ctx,
    );
    const vc = findClipById(await loadTimeline(v.store), v.id);
    expect(vc.effects).toHaveLength(1);
    expect(vc.audio_effects).toBeUndefined();
    const a = await withAudio();
    await applyEffectsTool({ clip_ids: [a.id], add: [{ type: "eq", params: { bass: 3 } }] }, a.ctx);
    const ac = findClipById(await loadTimeline(a.store), a.id);
    expect(ac.audio_effects).toHaveLength(1);
    expect(ac.effects).toBeUndefined();
  });
  it("removing the last effect deletes the field entirely (not an empty array)", async () => {
    const { ctx, store, id } = await withVideo();
    await applyEffectsTool({ clip_ids: [id], add: [{ type: "blur" }] }, ctx);
    expect(findClipById(await loadTimeline(store), id).effects).toHaveLength(1);
    await applyEffectsTool({ clip_ids: [id], remove: ["blur"] }, ctx);
    expect(findClipById(await loadTimeline(store), id).effects).toBeUndefined();
  });
});

// A 480p source, the resolution that produced the "video is static" report.
const sdRunner = makeRunner((p, a) => {
  if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
  if (a.includes("stream=width,height")) return { code: 0, stdout: "854,480", stderr: "" };
  if (a.includes("-select_streams"))
    return { code: 0, stdout: a[a.indexOf("-select_streams") + 1] === "v" ? "1" : "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
});

async function withSdVideo(): Promise<{ ctx: Any; store: Any; id: string }> {
  clearDurationCache();
  clearSourceDimsCache();
  const { ctx, store } = await seededCtx(sdRunner);
  const r = (await addClipsTool(
    { entries: [{ media_ref: "sd.mp4", timeline_in: 0, timeline_out: 60 }] },
    ctx,
  )) as Any;
  return { ctx, store, id: r.created[0].clip_id as string };
}

describe("zoom is bounded by what the source can carry", () => {
  it("set_clip_properties clamps the reported edit and says why", async () => {
    const { ctx, store, id } = await withSdVideo();
    const r = (await setClipPropertiesTool(
      { clip_ids: [id], fit: "cover", transform: { position: { x: 0.38, y: 0.49 }, scale: 3.45 } },
      ctx,
    )) as Any;
    const clip = findClipById(await loadTimeline(store), id);
    expect(clip.transform.scale).toBeCloseTo(1.5, 6);
    expect(clip.transform.position).toEqual({ x: 0.38, y: 0.49 });
    // The model can only correct what it is told; a silent clamp trades one invisible failure
    // for another.
    expect(String(r.notes?.join(" "))).toMatch(/13\.8x magnification of a 854x480 source/);
    expect(String(r.notes?.join(" "))).toMatch(/78x139 source pixels/);
  });

  it("set_keyframes clamps an animated zoom through its own door", async () => {
    const { ctx, store, id } = await withSdVideo();
    await setClipPropertiesTool({ clip_ids: [id], fit: "cover" }, ctx);
    const r = (await setKeyframesTool(
      {
        clip_id: id,
        property: "scale",
        keyframes: [
          { t: 0, v: 3.85 },
          { t: 242, v: 3.98 },
        ],
      },
      ctx,
    )) as Any;
    const kf = findClipById(await loadTimeline(store), id).transform.scale;
    expect(kf[0].v).toBeLessThan(1.6);
    expect(kf[1].v / kf[0].v).toBeCloseTo(3.98 / 3.85, 6);
    expect(String(r.notes?.join(" "))).toMatch(/zoom reduced/);
  });

  it("leaves a normal vertical reframe of the same 480p source completely alone", async () => {
    const { ctx, store, id } = await withSdVideo();
    const r = (await setClipPropertiesTool(
      { clip_ids: [id], fit: "cover", transform: { scale: 1.2 } },
      ctx,
    )) as Any;
    expect(findClipById(await loadTimeline(store), id).transform.scale).toBe(1.2);
    expect(r.notes).toBeUndefined();
  });

  it("an unrelated property edit never re-zooms a clip", async () => {
    // Clamping on every write would let "set the opacity" silently resize a clip nobody touched.
    const { ctx, store, id } = await withSdVideo();
    await setClipPropertiesTool({ clip_ids: [id], fit: "cover" }, ctx);
    await ctxApplyOp(ctx, "seed", (tl) => {
      findClipById(tl, id).transform = { scale: 9 };
      return {};
    });
    await setClipPropertiesTool({ clip_ids: [id], opacity: 0.5 }, ctx);
    expect(findClipById(await loadTimeline(store), id).transform.scale).toBe(9);
  });

  it("survives the agent's real argument shape, where unset params are null", async () => {
    // Verbatim from a live eval trace: every typed param the model left alone arrives as an
    // explicit null. A fixture with those keys simply omitted agrees with code that only
    // checks `undefined` — this shape crashed set_clip_properties in three scenarios.
    const { ctx, store, id } = await withSdVideo();
    const r = (await setClipPropertiesTool(
      {
        clip_ids: [id],
        transform: { position: { x: 0.82, y: 0.18 }, scale: 0.28, scale_x: null, scale_y: null },
        fit: "contain",
        rotate: null,
        opacity: null,
        speed: null,
        duration: null,
        source_in: null,
        source_out: null,
        flip: null,
        crop: null,
        blend: "normal",
        volume: null,
        loop: null,
        stretch: null,
        duck: null,
        fade: null,
        audio_filter: null,
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(findClipById(await loadTimeline(store), id).transform.scale).toBe(0.28);
  });
});
