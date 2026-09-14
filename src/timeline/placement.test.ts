import { beforeEach, describe, expect, it } from "vitest";

import { INTERNAL_DIR, joinPath, type LibraryClip, type ProjectStoreAccess } from "../tools/store";
import { audioRunner, makeRunner, seededCtx, videoRunner } from "../test/timelineKit";
import { loadTimeline } from "./engine";
import { clipKind } from "./helpers";
import { getTimelineTool } from "./ops";
import {
  addClipsTool,
  addTextClipsTool,
  clearDurationCache,
  clearHasAudioCache,
  clearHasVideoCache,
  insertClipsTool,
} from "./placement";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

beforeEach(() => {
  clearHasAudioCache();
  clearHasVideoCache();
  clearDurationCache();
});

describe("addClipsTool", () => {
  it("errors without ctx, on empty entries, and on a missing source", async () => {
    expect(((await addClipsTool({}, null)) as Any).ok).toBe(false);
    const { ctx } = await seededCtx();
    expect(((await addClipsTool({ entries: [] }, ctx)) as Any).ok).toBe(false);
    expect(
      ((await addClipsTool({ entries: [{ timeline_in: 0, timeline_out: 60 }] }, ctx)) as Any).ok,
    ).toBe(false);
  });

  it("rejects an absolute / '..' media_ref and places nothing (agent uses library refs, not system paths)", async () => {
    const { ctx, store } = await seededCtx();
    const before = (await loadTimeline(store)).tracks.reduce(
      (n, t) => n + (t.clips?.length ?? 0),
      0,
    );
    for (const bad of ["C:/secret/passwords.mp4", "/etc/shadow", "../../escape.mp4"]) {
      const r = (await addClipsTool(
        { entries: [{ media_ref: bad, timeline_in: 0, timeline_out: 60 }] },
        ctx,
      )) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("not a system path");
    }
    const after = (await loadTimeline(store)).tracks.reduce(
      (n, t) => n + (t.clips?.length ?? 0),
      0,
    );
    expect(after).toBe(before); // nothing placed from any absolute / escape ref
  });

  it("abandons the write when the project is closing — no clip applied (session close)", async () => {
    const { ctx, store, doc } = await seededCtx();
    const before = (await loadTimeline(store)).tracks.reduce(
      (n, t) => n + (t.clips?.length ?? 0),
      0,
    );
    // A project close/switch during the async preflight (resolve + ffprobe) begins the document
    // close; the mutation GATE then rejects the commit at admission, so no clip lands in the
    // project the user already left. No per-tool signal/stillCurrent opt-in — it's the gate.
    void doc.gate.beginClose();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("closed");
    const after = (await loadTimeline(store)).tracks.reduce(
      (n, t) => n + (t.clips?.length ?? 0),
      0,
    );
    expect(after).toBe(before); // nothing applied to the project the user already left
  });

  it("rejects a kind-mismatched track_id (audio media on a video track)", async () => {
    const { ctx } = await seededCtx();
    // Establish v1 as a video track, then an audio clip aimed at it must be refused.
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    );
    const r = (await addClipsTool(
      { entries: [{ media_ref: "m.mp3", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
  });

  it("places a video and auto-splits its audio to a linked track", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    const tl = await loadTimeline(store);
    const v = tl.tracks.find((t) => t.id === "v1")!;
    expect(v.clips!.length).toBe(1);
    const lg = v.clips![0].link_group;
    expect(lg).toBeTruthy();
    const audio = tl.tracks.find((t) => t.kind === "audio" && t.id !== "music")!;
    expect(audio.clips![0].link_group).toBe(lg);
  });

  // Placing a shot silently used to mean baking a muted copy through run_ffmpeg — the ONLY thing
  // the escape hatch was ever used for in 699 calls. Every native alternative needed the linked
  // clip's id, which does not exist until after placement.
  it("places the picture alone when the entry declines the audio", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      {
        entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, with_audio: false }],
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1); // the linked audio clip was never created
    const tl = await loadTimeline(store);
    const v = tl.tracks.find((t) => t.id === "v1")!;
    expect(v.clips!.length).toBe(1);
    expect(v.clips![0].link_group).toBeUndefined(); // nothing to link to
    expect(tl.tracks.flatMap((t) => (t.kind === "audio" ? (t.clips ?? []) : []))).toEqual([]);
  });

  // The failure direction: omitting the flag, or passing true, must not quietly drop the audio.
  it("still splits the audio when the entry does not decline it", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, with_audio: true }] },
      ctx,
    );
    const tl = await loadTimeline(store);
    const audio = tl.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips ?? []);
    expect(audio.length).toBe(1);
    expect(audio[0].link_group).toBe(tl.tracks.find((t) => t.id === "v1")!.clips![0].link_group);
  });

  it("places a silent video as a single clip", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    )) as Any;
    expect(r.count).toBe(1);
    const tl = await loadTimeline(store);
    expect(tl.tracks.find((t) => t.id === "v1")!.clips![0].link_group).toBeUndefined();
  });

  it("places an image without a source window, and audio on the music track", async () => {
    const { ctx, store } = await seededCtx();
    await addClipsTool(
      { entries: [{ media_ref: "pic.png", timeline_in: 0, timeline_out: 30 }] },
      ctx,
    );
    await addClipsTool(
      { entries: [{ media_ref: "song.mp3", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    );
    const tl = await loadTimeline(store);
    const img = tl.tracks.find((t) => t.id === "v1")!.clips![0] as Any;
    expect(img.source_in).toBeUndefined();
    const music = tl.tracks.find((t) => t.id === "music")!;
    expect(music.clips![0].kind).toBe("audio");
  });

  // A voiceover then a music bed is the most ordinary audio job there is, and it used to cost the
  // voiceover: both went to the default zone and same-track overwrite removed the first. Placing
  // two OVERLAPPING audio clips with no track named must keep both.
  it("routes a second overlapping audio clip to its own track instead of overwriting", async () => {
    const { ctx, store } = await seededCtx();
    const vo = (await addClipsTool(
      { entries: [{ media_ref: "song.mp3", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    )) as Any;
    const voId = vo.created[0].clip_id as string;
    const bed = (await addClipsTool(
      { entries: [{ media_ref: "song.mp3", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    )) as Any;
    expect(bed.ok).toBe(true);
    const tl = await loadTimeline(store);
    const audio = tl.tracks.filter((t) => t.kind === "audio");
    expect(audio.length).toBe(2); // a second lane, not a replacement
    const all = audio.flatMap((t) => t.clips ?? []);
    expect(all.length).toBe(2);
    expect(all.some((c) => c.id === voId)).toBe(true); // the first one SURVIVED
    // Naming a track is still an explicit request to overwrite it.
    await addClipsTool(
      {
        entries: [
          { media_ref: "song.mp3", timeline_in: 0, timeline_out: 90, track_id: "music" },
        ],
      },
      ctx,
    );
    const after = await loadTimeline(store);
    expect(after.tracks.find((t) => t.id === "music")!.clips!.length).toBe(1);
  });

  // A placed clip must address its media the way every OTHER tool does — by library
  // id — and must CARRY its own kind. Deriving the kind from the ref only worked
  // while the ref was a path: a bare id has no extension, so an image would read as
  // video everywhere (render, preview, thumbnails). Both halves are asserted on the
  // PERSISTED clip, so neither can regress silently.
  describe("a placed clip stores the library id + its own kind (a media ref plus its kind)", () => {
    // Seed the catalog directly: registerLibraryClip needs binary writes, which the
    // in-memory fs these suites use doesn't support. The catalog file IS the input
    // toMediaRef reads, so this exercises the same path.
    async function catalog(store: ProjectStoreAccess, rows: LibraryClip[]): Promise<void> {
      await store.writeText(
        joinPath(store.projectDir, INTERNAL_DIR, "library.json"),
        JSON.stringify({ clips: rows }),
      );
      for (const r of rows) await store.writeText(joinPath(store.projectDir, r.path), "x");
    }

    it("stores the catalog id, not a path, and records kind for image and video", async () => {
      const { ctx, store } = await seededCtx();
      await catalog(store, [
        { id: "media_pic0001", path: "library/media_pic0001.png", filename: "pic.png" },
        { id: "media_vid0001", path: "library/media_vid0001.mp4", filename: "clip.mp4" },
      ]);

      await addClipsTool(
        {
          entries: [
            { media_ref: "media_pic0001", timeline_in: 0, timeline_out: 30, track_id: "v2" },
            { media_ref: "media_vid0001", timeline_in: 30, timeline_out: 60, track_id: "v2" },
          ],
        },
        ctx,
      );

      const tl = await loadTimeline(store);
      const clips = tl.tracks.find((t) => t.id === "v2")!.clips! as Any[];
      // The ID itself — not "library/<id>.png", not an absolute path.
      expect(clips[0].media_ref).toBe("media_pic0001");
      expect(clips[1].media_ref).toBe("media_vid0001");
      expect(String(clips[0].media_ref)).not.toMatch(/[\\/]/);
      // …and the kind travels WITH the clip, because the id can't tell you.
      expect(clips[0].kind).toBe("image");
      expect(clips[1].kind).toBe("video");
      // The whole point: reading the kind back off a stored clip still says "image".
      expect(clipKind(clips[0])).toBe("image");
    });

    it("insert_clips stores the id too (the sibling producer, not just add_clips)", async () => {
      const { ctx, store } = await seededCtx();
      await catalog(store, [
        { id: "media_shot0001", path: "library/media_shot0001.png", filename: "shot.png" },
      ]);
      await insertClipsTool(
        { at: 0, track_id: "v2", entries: [{ media_ref: "media_shot0001", duration: 30 }] },
        ctx,
      );
      const tl = await loadTimeline(store);
      const clip = tl.tracks.find((t) => t.id === "v2")!.clips![0] as Any;
      expect(clip.media_ref).toBe("media_shot0001");
      expect(clip.kind).toBe("image");
    });

    it("keeps the portable path for media that is NOT catalogued (there is no id)", async () => {
      const { ctx, store } = await seededCtx();
      await addClipsTool(
        { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30, track_id: "v2" }] },
        ctx,
      );
      const tl = await loadTimeline(store);
      const clip = tl.tracks.find((t) => t.id === "v2")!.clips![0] as Any;
      expect(clip.media_ref).toBe("a.mp4");
      expect(clip.kind).toBe("video");
    });
  });

  it("source_span cuts an exact span of the source (seconds -> frames, 1x)", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, source_span: [1, 3] }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const clip = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips![0] as Any;
    // fps 30: [1s, 3s] -> source_in 30, source_out 90; timeline length = the 60-frame span.
    expect([clip.source_in, clip.source_out]).toEqual([30, 90]);
    expect([clip.timeline_in, clip.timeline_out]).toEqual([0, 60]);
  });

  it("places the whole source when no length is given", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const clip = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips![0] as Any;
    expect(clip.timeline_in).toBe(0);
    expect(clip.timeline_out).toBeGreaterThan(0); // whole source (probe) or the still default
  });

  it("source_span + an AGREEING timeline_out places the cut silently; a DISAGREEING one coerces to the span + notes it; loop on non-audio rejects", async () => {
    const { ctx, store } = await seededCtx();
    // agree: [0s,2s] = 60 frames == timeline_out 60 -> the source cut places, no complaint.
    const ok = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    expect(ok.ok).toBe(true);
    expect(String((ok.notes ?? []).join(" "))).not.toContain("disagreed");
    const clip = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips![0] as Any;
    expect([clip.timeline_in, clip.timeline_out]).toEqual([0, 60]); // [0s,2s] @30fps
    // disagree: [0s,2s] = 60 frames != timeline_out 999 -> source_span wins, the length is noted (no reject).
    const coerced = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 999, source_span: [0, 2] }] },
      ctx,
    )) as Any;
    expect(coerced.ok).toBe(true);
    // The note must name the CONSEQUENCE, not just that two fields disagreed: a span shorter than
    // the requested window leaves a hole on the track, and that is what the caller has to act on.
    const coercedNote = String((coerced.notes ?? []).join(" "));
    expect(coercedNote).toMatch(/\bgap\b/i);
    expect(coercedNote).toContain("60"); // where the clip actually ends
    expect(coercedNote).toContain("999"); // what was asked for
    const clip2 = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips![0] as Any;
    expect([clip2.timeline_in, clip2.timeline_out]).toEqual([0, 60]); // span wins, not the 999
    // loop on a non-audio source still rejects.
    expect(
      (
        (await addClipsTool(
          { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, loop: true }] },
          ctx,
        )) as Any
      ).ok,
    ).toBe(false);
  });

  it("clamps an oversized source_span to the media's real duration", async () => {
    // ffprobe reports a 2s source (60 frames) with video+audio; a guessed
    // [0, 100s] span must clamp to source_out = 60 rather than run past EOF.
    const runner = makeRunner((p, a) => {
      if (p !== "ffprobe") return { code: 0, stdout: "", stderr: "" };
      if (a.includes("format=duration")) return { code: 0, stdout: "2.0", stderr: "" };
      if (a.includes("-select_streams")) return { code: 0, stdout: "0", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const { ctx, store } = await seededCtx(runner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "clampsrc.mp4", timeline_in: 0, source_span: [0, 100] }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const clip = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips![0] as Any;
    expect([clip.source_in, clip.source_out]).toEqual([0, 60]); // clamped to 2s @ 30fps
    expect([clip.timeline_in, clip.timeline_out]).toEqual([0, 60]);
  });

  it("surfaces a probe failure (ffprobe non-zero) instead of silently misclassifying", async () => {
    const failing = makeRunner((p) =>
      p === "ffprobe"
        ? { code: 1, stdout: "", stderr: "moov atom not found" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const { ctx } = await seededCtx(failing);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "badprobe.mp4", timeline_in: 0, timeline_out: 30 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("couldn't probe");
  });

  it("overwrites: a new clip trims an existing clip it overlaps on the same track", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, track_id: "v2" }] },
      ctx,
    );
    const r = (await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 30, timeline_out: 90, track_id: "v2" }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true); // no rejection — the landing region is cleared, not refused
    const clips = (await loadTimeline(store)).tracks.find((t) => t.id === "v2")!.clips!;
    // existing [0,60] trimmed to [0,30]; new clip [30,90] fills the rest — no overlap.
    expect(clips.map((c) => [c.timeline_in, c.timeline_out]).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 30],
      [30, 90],
    ]);
  });

  it("overwrites: a covering clip removes the clip underneath", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 10, timeline_out: 50, track_id: "v2" }] },
      ctx,
    );
    const r = (await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 0, timeline_out: 60, track_id: "v2" }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const clips = (await loadTimeline(store)).tracks.find((t) => t.id === "v2")!.clips!;
    expect(clips.map((c) => [c.timeline_in, c.timeline_out])).toEqual([[0, 60]]); // the [10,50] clip is gone
  });

  it("overwrites: a clip landing inside a longer clip splits it (hole punch)", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 90, track_id: "v2" }] },
      ctx,
    );
    const r = (await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 30, timeline_out: 60, track_id: "v2" }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const clips = (await loadTimeline(store)).tracks.find((t) => t.id === "v2")!.clips!;
    // original [0,90] survives on both sides of the new [30,60] clip.
    expect(clips.map((c) => [c.timeline_in, c.timeline_out]).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 30],
      [30, 60],
      [60, 90],
    ]);
  });

  it("overwrites: replacing a video clip also drops its linked audio", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, track_id: "v2" }] },
      ctx,
    );
    const oldLg = (await loadTimeline(store)).tracks.find((t) => t.id === "v2")!.clips![0]
      .link_group;
    expect(oldLg).toBeTruthy();
    await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 0, timeline_out: 60, track_id: "v2" }] },
      ctx,
    );
    const tl = await loadTimeline(store);
    // The replaced clip's linked audio (its group) is gone; v2 holds only the new clip.
    const allAudio = tl.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips ?? []);
    expect(allAudio.some((c) => c.link_group === oldLg)).toBe(false);
    expect(tl.tracks.find((t) => t.id === "v2")!.clips!.length).toBe(1);
  });
});

// The real incident: a placement at frame 0 ate a graded 96-frame shot and left a 24-frame stub of
// the next one under an id nobody had seen. The reply said `created`, `count` and a change delta;
// the agent could not account for the stub and told the user "the rest of the timeline stayed in
// place". So the rule is about what the REPLY says, not about what the timeline looks like: an
// overwrite has to name the material it destroyed, in its own field, every time.
describe("an overwrite reports what it destroyed", () => {
  const place = (ctx: Any, media: string, tin: number, tout: number) =>
    addClipsTool(
      { entries: [{ media_ref: media, timeline_in: tin, timeline_out: tout, track_id: "v2" }] },
      ctx,
    ) as Promise<Any>;

  it("names the clip it removed and the one it cut short", async () => {
    const { ctx } = await seededCtx(audioRunner);
    const first = await place(ctx, "a.mp4", 0, 60);
    const second = await place(ctx, "b.mp4", 60, 120);
    const eaten = first.created[0].clip_id as string;
    const cut = second.created[0].clip_id as string;

    const r = await place(ctx, "c.mp4", 0, 90);

    expect(r.ok).toBe(true);
    expect(r.overwrote.removed).toContain(eaten); // gone entirely
    const short = r.overwrote.shortened.find((s: Any) => s.was_clip === cut);
    expect(short).toBeTruthy(); // the stub is attributed to the clip it came from
    expect(short.was).toEqual([60, 120]);
    expect(short.now).toEqual([90, 120]);
    expect(short.id).not.toBe(cut); // ...and its id CHANGED, which is what confused the agent
    // A field the caller has to opt into reading is not enough; it must be said in words too.
    expect(String(r.warnings.join(" "))).toContain(eaten);
    expect(String(r.warnings.join(" "))).toContain("Undo");
  });

  // The failure direction: a report that fires unconditionally would carry no information.
  it("says nothing about an overwrite when it landed on empty space", async () => {
    const { ctx } = await seededCtx(audioRunner);
    await place(ctx, "a.mp4", 0, 60);
    const r = await place(ctx, "b.mp4", 120, 180);
    expect(r.ok).toBe(true);
    expect(r.overwrote).toBeUndefined();
    expect(r.warnings).toBeUndefined();
  });

  // Both halves of a hole punch survive, so nothing is "removed" — but the tail is a clip id the
  // caller has never seen, which is precisely the state it needs told about.
  it("reports both surviving pieces of a hole punch, and removes nothing", async () => {
    const { ctx } = await seededCtx(audioRunner);
    const first = await place(ctx, "a.mp4", 0, 90);
    const host = first.created[0].clip_id as string;

    const r = await place(ctx, "b.mp4", 30, 60);

    expect(r.overwrote.removed).toEqual([]);
    const head = r.overwrote.shortened.find((s: Any) => s.id === host);
    expect(head).toMatchObject({ was: [0, 90], now: [0, 30] }); // keeps its id
    const tail = r.overwrote.shortened.find((s: Any) => s.was_clip === host);
    expect(tail).toMatchObject({ was: [0, 90], now: [60, 90] }); // new id, same origin
  });

  it("reports every entry of a multi-entry placement, not just the first", async () => {
    const { ctx } = await seededCtx(audioRunner);
    const a = await place(ctx, "a.mp4", 0, 30);
    const b = await place(ctx, "b.mp4", 60, 90);

    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "c.mp4", timeline_in: 0, timeline_out: 30, track_id: "v2" },
          { media_ref: "d.mp4", timeline_in: 60, timeline_out: 90, track_id: "v2" },
        ],
      },
      ctx,
    )) as Any;

    expect(r.overwrote.removed).toEqual(
      expect.arrayContaining([a.created[0].clip_id, b.created[0].clip_id]),
    );
  });
});

describe("insertClipsTool", () => {
  it("ripple-inserts, splitting a straddling clip and pushing the tail", async () => {
    const { ctx, store } = await seededCtx();
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    const r = (await insertClipsTool(
      { at: 30, track_id: "v1", entries: [{ media_ref: "b.mp4", duration: 30 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.pushed_by).toBe(30);
    const clips = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips!;
    expect(clips.map((c) => [c.timeline_in, c.timeline_out])).toEqual([
      [0, 30],
      [30, 60],
      [60, 90],
    ]);
  });

  it("validates at and entries", async () => {
    const { ctx } = await seededCtx();
    expect(((await insertClipsTool({ at: 0, entries: [] }, ctx)) as Any).ok).toBe(false);
    expect(
      (
        (await insertClipsTool(
          { at: -5, entries: [{ media_ref: "a.mp4", duration: 30 }] },
          ctx,
        )) as Any
      ).ok,
    ).toBe(false);
    expect(((await insertClipsTool({}, null)) as Any).ok).toBe(false);
  });

  it("rejects an absolute-path media_ref (same containment as add_clips)", async () => {
    const { ctx } = await seededCtx();
    const r = (await insertClipsTool(
      { at: 0, track_id: "v2", entries: [{ media_ref: "C:/secret/passwords.mp4", duration: 30 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not a system path");
  });

  it("splits a straddling linked clip (video + its audio) on ripple insert", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
      ctx,
    );
    expect(
      (
        (await insertClipsTool(
          { at: 30, track_id: "v1", entries: [{ media_ref: "b.mp4", duration: 30 }] },
          ctx,
        )) as Any
      ).ok,
    ).toBe(true);
    const tl = await loadTimeline(store);
    const v2 = tl.tracks
      .find((t) => t.id === "v1")!
      .clips!.map((c) => [c.timeline_in, c.timeline_out]);
    expect(v2).toEqual([
      [0, 30],
      [30, 60],
      [60, 90],
    ]);
    const aTimes = tl.tracks
      .filter((t) => t.kind === "audio" && t.id !== "music")
      .flatMap((t) => (t.clips ?? []).map((c) => [c.timeline_in, c.timeline_out]));
    expect(aTimes).toContainEqual([0, 30]); // linked audio's left half after the split
    expect(aTimes).toContainEqual([60, 90]); // linked audio's right half shifted by the insert
  });

  it("pushes a sync-locked bystander lane right by the insert span", async () => {
    const { ctx, store } = await seededCtx();
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30, track_id: "v2" }] },
      ctx,
    );
    await addClipsTool(
      { entries: [{ media_ref: "b.mp4", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    );
    expect(
      (
        (await insertClipsTool(
          { at: 0, track_id: "v2", entries: [{ media_ref: "c.mp4", duration: 30 }] },
          ctx,
        )) as Any
      ).ok,
    ).toBe(true);
    const v1 = (await loadTimeline(store)).tracks.find((t) => t.id === "v1")!.clips!;
    expect([v1[0].timeline_in, v1[0].timeline_out]).toEqual([30, 60]); // pushed right by the 30f insert
  });
});

describe("placing media that is still being generated", () => {
  // The contract promises the model it can place a generated ref IMMEDIATELY. It could not:
  // resolveMediaRef returns null for a row whose file does not exist, so the raw ref went to
  // ffprobe and add_clips failed with "No such file or directory". Every unit test passed —
  // none of them placed a pending ref against a probe that behaves like the real one.
  const noFile = makeRunner((p) =>
    p === "ffprobe"
      ? { code: 1, stdout: "", stderr: "No such file or directory" }
      : { code: 0, stdout: "", stderr: "" },
  );

  /** A catalog row with NO file on disk, exactly as submitGeneration leaves it. */
  async function pendingCatalog(store: ProjectStoreAccess, kind: string): Promise<void> {
    await store.writeText(
      joinPath(store.projectDir, INTERNAL_DIR, "library.json"),
      JSON.stringify({
        clips: [
          {
            id: "media_gen_pending",
            path: `library/media_gen_pending.${kind === "audio" ? "wav" : "mp4"}`,
            filename: "gen",
            kind,
            status: "generating",
          },
        ],
      }),
    );
  }

  it("add_clips places a generating ref without probing it", async () => {
    const { ctx, store } = await seededCtx(noFile);
    await pendingCatalog(store, "audio");

    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "media_gen_pending", timeline_in: 0, timeline_out: 90, kind: "audio" },
        ],
      },
      ctx,
    )) as Any;

    expect(r.ok).toBe(true);
    const tl = await loadTimeline(store);
    const placed = tl.tracks.flatMap((t) => (t.clips ?? []) as Any[]);
    expect(placed).toHaveLength(1);
    expect(placed[0].media_ref).toBe("media_gen_pending"); // the id, so it fills in on settle
    expect(clipKind(placed[0])).toBe("audio"); // kind from the catalog row, not from a probe
  });

  it("insert_clips does too — the other door onto the timeline", async () => {
    const { ctx, store } = await seededCtx(noFile);
    await pendingCatalog(store, "video");

    const r = (await insertClipsTool(
      { entries: [{ media_ref: "media_gen_pending", duration: 60 }], at: 0 },
      ctx,
    )) as Any;

    expect(r.ok).toBe(true);
    const placed = (await loadTimeline(store)).tracks.flatMap((t) => (t.clips ?? []) as Any[]);
    expect(placed.some((c) => c.media_ref === "media_gen_pending")).toBe(true);
  });

  // Its length is genuinely unknowable, so say so instead of probing a missing file and
  // reporting an ffprobe error the model cannot act on.
  it("asks for a length rather than probing when none is given", async () => {
    const { ctx, store } = await seededCtx(noFile);
    await pendingCatalog(store, "audio");

    const r = (await addClipsTool(
      { entries: [{ media_ref: "media_gen_pending", timeline_in: 0 }] },
      ctx,
    )) as Any;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/still being generated/);
    expect(String(r.error)).toMatch(/timeline_out or duration/);
  });

  // Media that is NOT pending must still be probed — this fix must not become a blanket
  // "skip the probe", which would resurrect the audio-only-.mp4 misclassification.
  it("still probes ordinary media", async () => {
    const { ctx, store } = await seededCtx(noFile);
    await pendingCatalog(store, "audio");

    const r = (await addClipsTool(
      { entries: [{ media_ref: "ordinary.mp4", timeline_in: 0, timeline_out: 30 }] },
      ctx,
    )) as Any;

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("couldn't probe");
  });
});

describe("addTextClipsTool", () => {
  it("places a text clip on the captions track (string content wrapped in a run)", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addTextClipsTool(
      { entries: [{ content: "Hello", timeline_in: 0, timeline_out: 30 }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    const cap = (await loadTimeline(store)).tracks.find((t) => t.id === "captions")!;
    expect(cap.kind).toBe("text");
    expect(cap.clips![0].content).toEqual([{ text: "Hello" }]);
  });

  it("errors on empty entries and without ctx", async () => {
    const { ctx } = await seededCtx();
    expect(((await addTextClipsTool({ entries: [] }, ctx)) as Any).ok).toBe(false);
    expect(((await addTextClipsTool({}, null)) as Any).ok).toBe(false);
  });

  it("places multiple text clips, keeps a rich content array, and carries style/animation", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await addTextClipsTool(
      {
        entries: [
          { content: "one", timeline_in: 0, timeline_out: 30, style: { size: 48 } },
          {
            content: [{ text: "two", bold: true }],
            timeline_in: 30,
            timeline_out: 60,
            animation: { in: "fade" },
          },
        ],
      },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    const cap = (await loadTimeline(store)).tracks.find((t) => t.id === "captions")!;
    expect(cap.kind).toBe("text");
    expect(cap.clips!.length).toBe(2);
    const [c0, c1] = cap.clips!;
    expect(c0.content).toEqual([{ text: "one" }]); // string wrapped in a run
    expect((c0 as Any).style).toEqual({ size: 48 });
    expect(c1.content).toEqual([{ text: "two", bold: true }]); // array kept as-is
    expect((c1 as Any).animation).toEqual({ in: "fade" });
  });

  it("get_timeline preserves text content + style (compaction never drops them)", async () => {
    const { ctx } = await seededCtx();
    await addTextClipsTool(
      { entries: [{ content: "hi", timeline_in: 0, timeline_out: 30, style: { size: 40 } }] },
      ctx,
    );
    const r = (await getTimelineTool({}, ctx)) as Any;
    const cap = r.timeline.tracks.find((t: Any) => t.id === "captions");
    expect(cap.clips[0].content).toEqual([{ text: "hi" }]);
    expect(cap.clips[0].style).toEqual({ size: 40 });
  });

  it("rejects text on a non-text track and an entry missing a time span", async () => {
    const { ctx } = await seededCtx();
    // Establish v1 as a video track; text aimed at it is refused (text needs a text track).
    await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
      ctx,
    );
    expect(
      (
        (await addTextClipsTool(
          { entries: [{ content: "x", timeline_in: 0, timeline_out: 30, track_id: "v1" }] },
          ctx,
        )) as Any
      ).ok,
    ).toBe(false);
    // No timeline_in/timeline_out/duration -> spanFrames refuses.
    expect(((await addTextClipsTool({ entries: [{ content: "x" }] }, ctx)) as Any).ok).toBe(false);
  });
});

describe("linked audio track allocation", () => {
  it("reuses a non-overlapping audio lane, else opens a new one", async () => {
    const { ctx, store } = await seededCtx(audioRunner);
    await addClipsTool(
      {
        entries: [
          { media_ref: "a.mp4", timeline_in: 0, timeline_out: 30 },
          { media_ref: "b.mp4", timeline_in: 30, timeline_out: 60 },
        ],
      },
      ctx,
    );
    let audio = (await loadTimeline(store)).tracks.filter(
      (t) => t.kind === "audio" && t.id !== "music",
    );
    expect(audio.length).toBe(1); // both linked audios share one non-overlapping lane
    expect(audio[0].clips!.length).toBe(2);
    await addClipsTool(
      { entries: [{ media_ref: "c.mp4", timeline_in: 0, timeline_out: 30, track_id: "v3" }] },
      ctx,
    );
    audio = (await loadTimeline(store)).tracks.filter(
      (t) => t.kind === "audio" && t.id !== "music",
    );
    expect(audio.length).toBe(2); // overlaps the first lane -> a new lane opens
  });
  it("derives an insert duration from a source_span (seconds)", async () => {
    const { ctx, store } = await seededCtx();
    const r = (await insertClipsTool(
      { at: 0, track_id: "v2", entries: [{ media_ref: "a.mp4", source_span: [0, 1.5] }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.pushed_by).toBe(45); // [0s, 1.5s] @ 30fps = 45 frames
    const clips = (await loadTimeline(store)).tracks.find((t) => t.id === "v2")!.clips!;
    expect([clips[0].timeline_in, clips[0].timeline_out]).toEqual([0, 45]);
  });
  it("insert: source_span + AGREEING duration places the cut; a DISAGREEING duration coerces to the span + notes it", async () => {
    const { ctx } = await seededCtx();
    // agree: [0s,1.5s] = 45 frames == duration 45 -> ok, no complaint.
    const ok = (await insertClipsTool(
      {
        at: 0,
        track_id: "v2",
        entries: [{ media_ref: "a.mp4", source_span: [0, 1.5], duration: 45 }],
      },
      ctx,
    )) as Any;
    expect(ok.ok).toBe(true);
    expect(ok.pushed_by).toBe(45);
    // disagree: 45 frames != duration 90 -> source_span wins (45), the duration is noted (no reject).
    const coerced = (await insertClipsTool(
      {
        at: 0,
        track_id: "v2",
        entries: [{ media_ref: "a.mp4", source_span: [0, 1.5], duration: 90 }],
      },
      ctx,
    )) as Any;
    expect(coerced.ok).toBe(true);
    expect(coerced.pushed_by).toBe(45); // span wins, not the 90
    expect(String((coerced.notes ?? []).join(" "))).toContain("disagreed");
  });
  it("assumes audio when the probe throws", async () => {
    const throwing = {
      run: async () => {
        throw new Error("ffprobe missing");
      },
    };
    const { ctx } = await seededCtx(throwing);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 30 }] },
      ctx,
    )) as Any;
    expect(r.count).toBe(2);
  });
});

// --- Branch hardening (mutation): the loop/stretch guard chain in resolvePlace,
// asserting the SPECIFIC behaviour so the &&/|| and === operators can't be mutated.
describe("add_clips -- branch hardening (loop/stretch guards)", () => {
  it("coerces loop AND stretch together to loop, with a note", async () => {
    const runner = makeRunner((p, a) =>
      p === "ffprobe" && a.includes("format=duration")
        ? { code: 0, stdout: "3.0", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const { ctx } = await seededCtx(runner);
    const r = (await addClipsTool(
      {
        entries: [
          { media_ref: "bed.mp3", timeline_in: 0, timeline_out: 60, loop: true, stretch: true },
        ],
      },
      ctx,
    )) as Any;
    expect(r.count).toBe(1);
    expect(String((r.notes ?? []).join(" "))).toContain("kept loop and ignored stretch");
  });
  it("rejects loop/stretch on a non-audio clip", async () => {
    const { ctx } = await seededCtx(videoRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60, loop: true }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("audio clips only");
  });
  it("rejects loop/stretch without a length to fill", async () => {
    const { ctx } = await seededCtx(audioRunner);
    const r = (await addClipsTool(
      { entries: [{ media_ref: "bed.mp3", timeline_in: 0, loop: true }] },
      ctx,
    )) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("need a timeline_out or duration");
  });
});
