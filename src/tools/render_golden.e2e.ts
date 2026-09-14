// Render/audio GOLDEN e2e tests — opt-in lane (vitest.smoke.config.ts). Each test
// synthesizes solid-colour / tone sources, drives the real client tools, renders
// through real ffmpeg, and asserts the OUTPUT by numbers (average RGB / luma via
// inspect_color, dB via volumedetect) with tolerances — stable across ffmpeg
// builds. Structural filter-graph goldens live in render.test.ts (fast unit lane).
//   npx vitest run --config vitest.smoke.config.ts src/tools/render_golden.e2e.ts
import os from "node:os";
import { promises as fsp } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientToolContext } from "./context";
import {
  framePng,
  have,
  installE2EDocuments,
  libRef,
  measureColor,
  meanVolumeDb,
  mkCtx,
  nodeFs,
  openE2EDoc,
  probe,
  regionScopes,
  renderMp4,
  resetE2EDocuments,
  srcSolid,
  srcSplit,
  srcTone,
} from "./__e2e";
import { ensureTimeline, loadTimeline } from "../timeline/engine";
import { applyTransitionTool } from "../timeline/edit";
import { addTrackTool, setCanvasTool } from "../timeline/ops";
import { addClipsTool } from "../timeline/placement";
import { applyColorTool, setClipPropertiesTool, setKeyframesTool } from "../timeline/props";
import { exportTimelineTool } from "../timeline/render";
import { whenExportsSettle } from "../timeline/exportQueue";
import { joinPath } from "./store";

type Rec = Record<string, unknown>;
const ROOT = joinPath(os.tmpdir(), `artdaddy-golden-${Date.now()}`);
let HAVE_FFMPEG = false;

beforeAll(async () => {
  installE2EDocuments(); // every project() dir gets an open ephemeral document (Phase 5.5)
  HAVE_FFMPEG = (await have("ffmpeg")) && (await have("ffprobe"));
});
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** A fresh project rooted under ROOT with a `w`x`h` canvas (30fps). */
async function project(
  name: string,
  w: number,
  h: number,
): Promise<{ dir: string; ctx: ClientToolContext }> {
  const dir = joinPath(ROOT, name);
  await nodeFs.mkdir(dir);
  await openE2EDoc(dir); // expose an OPEN document (awaited) before any timeline commit
  const ctx = mkCtx(dir);
  await ensureTimeline(ctx.store);
  const r = (await setCanvasTool({ width: w, height: h }, ctx)) as Rec;
  if (!r.ok) throw new Error(`canvas setup failed: ${JSON.stringify(r)}`);
  return { dir, ctx };
}

/** Place one clip; return its clip id. */
async function addClip(ctx: ClientToolContext, entry: Rec): Promise<string> {
  const ref = await libRef(ctx, entry.media_ref as string); // place by library ref, not a system path
  const r = (await addClipsTool({ entries: [{ ...entry, media_ref: ref }] }, ctx)) as Rec;
  if (!r.ok) throw new Error(`add_clips failed: ${JSON.stringify(r)}`);
  return (r.created as Rec[])[0].clip_id as string;
}

// ── Slice A: video compositing ──────────────────────────────────────────────
describe("golden: video compositing", () => {
  it("fit=contain letterboxes (black bars beside centred content)", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("fit-contain", 240, 120); // 2:1 canvas
    const src = await srcSolid(joinPath(dir, "sq.mp4"), { color: "red", w: 120, h: 120, dur: 1 }); // square
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    await setClipPropertiesTool({ clip_ids: [id], fit: "contain" }, ctx);
    const mp4 = await renderMp4(ctx, dir);
    // Left 40px column is a black bar; the centre 40px is red content.
    const bar = await regionScopes(ctx, mp4, joinPath(dir, "bar.png"), {
      atSec: 0.5,
      vf: "crop=40:120:0:0",
    });
    const mid = await regionScopes(ctx, mp4, joinPath(dir, "mid.png"), {
      atSec: 0.5,
      vf: "crop=40:120:100:0",
    });
    expect(bar.luma).toBeLessThan(0.1); // letterbox bar is black
    expect(mid.mean[0]).toBeGreaterThan(0.6); // centre is red
  }, 60_000);

  it("fit=cover fills the canvas edge-to-edge (no bars)", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("fit-cover", 240, 120);
    const src = await srcSolid(joinPath(dir, "sq.mp4"), { color: "red", w: 120, h: 120, dur: 1 });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    await setClipPropertiesTool({ clip_ids: [id], fit: "cover" }, ctx);
    const mp4 = await renderMp4(ctx, dir);
    const bar = await regionScopes(ctx, mp4, joinPath(dir, "bar.png"), {
      atSec: 0.5,
      vf: "crop=40:120:0:0",
    });
    expect(bar.mean[0]).toBeGreaterThan(0.6); // the former bar region is now red
  }, 60_000);

  it("visual fade: a video clip ramps opacity in and out (dimmer at the edges)", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("fade-visual", 160, 120);
    const src = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 160, h: 120, dur: 2 });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 60 });
    // Same `fade` field as audio — on video it ramps the alpha over the black base.
    await setClipPropertiesTool({ clip_ids: [id], fade: { in: 15, out: 15 } }, ctx); // 0.5s each
    const mp4 = await renderMp4(ctx, dir);
    const mid = await measureColor(
      ctx,
      await framePng(mp4, joinPath(dir, "mid.png"), { atSec: 1.0 }),
    ); // full opacity
    const fin = await measureColor(
      ctx,
      await framePng(mp4, joinPath(dir, "fin.png"), { atSec: 0.25 }),
    ); // ~halfway through fade-in
    const fout = await measureColor(
      ctx,
      await framePng(mp4, joinPath(dir, "fout.png"), { atSec: 1.75 }),
    ); // ~halfway through fade-out
    expect(mid.mean[0]).toBeGreaterThan(0.6); // full red at the centre
    expect(fin.mean[0]).toBeLessThan(mid.mean[0] - 0.2); // fading IN -> dimmer than full
    expect(fout.mean[0]).toBeLessThan(mid.mean[0] - 0.2); // fading OUT -> dimmer than full
    expect(fin.mean[0]).toBeGreaterThan(0.1); // but not black — partway through the ramp
  }, 60_000);

  it("z-order: the higher track occludes the lower", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("zorder", 160, 120);
    await addTrackTool({ id: "v1", kind: "video" }, ctx); // z 0
    await addTrackTool({ id: "v2", kind: "video" }, ctx); // z 1 (on top)
    const blue = await srcSolid(joinPath(dir, "blue.mp4"), {
      color: "blue",
      w: 160,
      h: 120,
      dur: 1,
    });
    const red = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 160, h: 120, dur: 1 });
    await addClip(ctx, { media_ref: blue, timeline_in: 0, timeline_out: 30, track_id: "v1" });
    await addClip(ctx, { media_ref: red, timeline_in: 0, timeline_out: 30, track_id: "v2" });
    const mp4 = await renderMp4(ctx, dir);
    const s = await measureColor(ctx, await framePng(mp4, joinPath(dir, "f.png"), { atSec: 0.5 }));
    expect(s.mean[0]).toBeGreaterThan(0.6); // red (top) wins
    expect(s.mean[2]).toBeLessThan(0.2); // blue (bottom) hidden
  }, 60_000);

  it("transform places a scaled clip in the top-left quadrant", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("transform", 160, 120);
    const src = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 160, h: 120, dur: 1 });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    // Centre at (0.25,0.25) scaled 0.5 -> occupies x[0,80] y[0,60] (top-left quarter).
    await setClipPropertiesTool(
      { clip_ids: [id], transform: { position: { x: 0.25, y: 0.25 }, scale: 0.5 } },
      ctx,
    );
    const mp4 = await renderMp4(ctx, dir);
    const tl = await regionScopes(ctx, mp4, joinPath(dir, "tl.png"), {
      atSec: 0.5,
      vf: "crop=40:30:0:0",
    });
    const br = await regionScopes(ctx, mp4, joinPath(dir, "br.png"), {
      atSec: 0.5,
      vf: "crop=40:30:120:90",
    });
    expect(tl.mean[0]).toBeGreaterThan(0.5); // clip in the top-left
    expect(br.luma).toBeLessThan(0.1); // bottom-right is empty (black)
  }, 60_000);

  // A transform scale whose pixel box rounds ODD used to abort the WHOLE render:
  // we composite in 4:2:0, where `pad` rounds its input up to chroma alignment and
  // then reports "padded dimensions cannot be smaller than input dimensions".
  // 0.29 of a 1080x1920 canvas is 313x557 — odd on both axes — and every clip on
  // the timeline vanished, not just the scaled one. Renders real pixels because a
  // filtergraph STRING assertion cannot tell a valid graph from one ffmpeg rejects.
  it("an odd-pixel transform box still renders (4:2:0 chroma alignment)", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("odd-box", 1080, 1920);
    const base = await srcSolid(joinPath(dir, "blue.mp4"), {
      color: "blue",
      w: 1080,
      h: 1920,
      dur: 1,
    });
    await addClip(ctx, { media_ref: base, timeline_in: 0, timeline_out: 30 });
    await addTrackTool({ kind: "video" }, ctx);
    const over = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 640, h: 480, dur: 1 });
    const id = await addClip(ctx, {
      media_ref: over,
      timeline_in: 0,
      timeline_out: 30,
      track: "v2",
    });
    await setClipPropertiesTool(
      { clip_ids: [id], transform: { position: { x: 0.5, y: 0.5 }, scale: 0.29 } },
      ctx,
    );

    const mp4 = await renderMp4(ctx, dir);
    // The OUTCOME: a real frame exists and still carries the base layer. Before the
    // fix ffmpeg exited -22 and wrote nothing at all, so renderMp4 produced no file.
    const whole = await regionScopes(ctx, mp4, joinPath(dir, "whole.png"), { atSec: 0.5 });
    expect(whole.luma).toBeGreaterThan(0.01);
  }, 90_000);

  // The SAME chroma-alignment failure reachable from a different producer: the canvas
  // itself. Fixing only the transform box left this open — an odd canvas dies with the
  // identical "-22 / padded dimensions" abort, so the rule belongs at the canvas
  // boundary, not at each caller.
  it("an odd CANVAS still renders (the rule is not per-clip)", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("odd-canvas", 320, 240);
    await setCanvasTool({ width: 321, height: 241 }, ctx);
    const src = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 320, h: 240, dur: 1 });
    await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });

    const mp4 = await renderMp4(ctx, dir);
    const s = await regionScopes(ctx, mp4, joinPath(dir, "f.png"), { atSec: 0.5 });
    expect(s.mean[0]).toBeGreaterThan(0.5); // red actually reached the frame
  }, 90_000);

  // A clip stores its media as a BARE library id, so the export path only works if
  // that id resolves to a real file before ffmpeg sees it. Proven end-to-end in
  // pixels — a bogus path renders no file at all, and a still fed as a video (source
  // window 0..0) contributes a zero-length input while the filtergraph still looks
  // perfectly valid. Sampled at TWO points, the later one far past the still's single
  // frame, so "renders" means "held for the clip's whole duration".
  it("an image placed by library id renders for the whole clip", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("img-by-id", 160, 120);
    const vid = await srcSolid(joinPath(dir, "green.mp4"), {
      color: "green",
      w: 160,
      h: 120,
      dur: 1,
    });
    const still = await framePng(vid, joinPath(dir, "still.png")); // a real one-frame PNG
    await addClip(ctx, { media_ref: still, timeline_in: 0, timeline_out: 60 }); // 2s from a still

    // The ref really is a bare id — nothing downstream can read an extension off it.
    const tl = await loadTimeline(ctx.store);
    const placed = (tl.tracks ?? []).flatMap((t) => t.clips ?? [])[0];
    expect(String(placed.media_ref)).not.toMatch(/\.[a-z0-9]+$/i);

    const mp4 = await renderMp4(ctx, dir);
    const early = await regionScopes(ctx, mp4, joinPath(dir, "e.png"), { atSec: 0.1 });
    const late = await regionScopes(ctx, mp4, joinPath(dir, "l.png"), { atSec: 1.8 });
    expect(early.mean[1]).toBeGreaterThan(0.3); // green is on screen…
    expect(late.mean[1]).toBeGreaterThan(0.3); // …and still there 1.8s in
  }, 90_000);

  it("blend=multiply darkens the top clip against the layer below", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("blend", 160, 120);
    await addTrackTool({ id: "v1", kind: "video" }, ctx);
    await addTrackTool({ id: "v2", kind: "video" }, ctx);
    const gray = await srcSolid(joinPath(dir, "gray.mp4"), {
      color: "gray",
      w: 160,
      h: 120,
      dur: 1,
    });
    const red = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 160, h: 120, dur: 1 });
    await addClip(ctx, { media_ref: gray, timeline_in: 0, timeline_out: 30, track_id: "v1" });
    const rid = await addClip(ctx, {
      media_ref: red,
      timeline_in: 0,
      timeline_out: 30,
      track_id: "v2",
    });
    // Baseline: plain red on top fully occludes the gray.
    const plain = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "plain.png"), { atSec: 0.5 }),
    );
    // multiply blends red against the gray below -> a darker red.
    await setClipPropertiesTool({ clip_ids: [rid], blend: "multiply" }, ctx);
    const mult = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "mult.png"), { atSec: 0.5 }),
    );
    expect(plain.mean[0]).toBeGreaterThan(0.8); // plain red is bright
    expect(mult.mean[0]).toBeLessThan(plain.mean[0] - 0.2); // multiply darkened it
    expect(mult.mean[0]).toBeGreaterThanOrEqual(mult.mean[2]); // still red-dominant, not blue
  }, 60_000);

  it("keyframed opacity ramps a clip up over time", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("kf-opacity", 160, 120);
    const src = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 160, h: 120, dur: 1 });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    await setKeyframesTool(
      {
        clip_id: id,
        property: "opacity",
        keyframes: [
          { t: 0, v: 0 },
          { t: 29, v: 1 },
        ],
      },
      ctx,
    );
    const mp4 = await renderMp4(ctx, dir);
    const early = await measureColor(
      ctx,
      await framePng(mp4, joinPath(dir, "e.png"), { atSec: 0.1 }),
    ); // ~10% opacity
    const late = await measureColor(
      ctx,
      await framePng(mp4, joinPath(dir, "l.png"), { atSec: 0.9 }),
    ); // ~93% opacity
    expect(early.mean[0]).toBeLessThan(0.4); // faint red early
    expect(late.mean[0]).toBeGreaterThan(0.6); // strong red late
    expect(late.mean[0]).toBeGreaterThan(early.mean[0] + 0.3);
  }, 60_000);

  it("a crossfade dissolves gradually rather than hard-cutting", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("dissolve", 160, 120);
    const red = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 160, h: 120, dur: 2 });
    const blue = await srcSolid(joinPath(dir, "blue.mp4"), {
      color: "blue",
      w: 160,
      h: 120,
      dur: 2,
    });
    await addClip(ctx, { media_ref: red, timeline_in: 0, timeline_out: 30 });
    const bId = await addClip(ctx, { media_ref: blue, timeline_in: 30, timeline_out: 60 });
    await applyTransitionTool(
      { clip_id: bId, transition_in: { kind: "crossfade", duration: 10 } },
      ctx,
    ); // over [30,40]
    const mp4 = await renderMp4(ctx, dir);
    // A crossfade is CENTRED on the cut, so blue must rise MONOTONICALLY across the window and
    // pass through ~50% AT the cut. The old assertion here was `some(b => b > 0.15 && b < 0.85)`
    // — "at least one frame is partly blended" — which a dissolve that crept to 20% and then hard
    // cut would satisfy. A QA sweep spent an hour on a false alarm because this test could not
    // tell those apart.
    const at = async (f: number): Promise<number> =>
      (await measureColor(ctx, await framePng(mp4, joinPath(dir, `f${f}.png`), { atSec: f / 30 })))
        .mean[2];
    const [before, q1, mid, q3, after] = [
      await at(10),
      await at(28),
      await at(30),
      await at(33),
      await at(50),
    ];
    expect(before).toBeLessThan(0.2); // well before the cut: still red
    expect(after).toBeGreaterThan(0.6); // well after: fully blue
    // Rises the whole way through, rather than stalling and then jumping.
    expect(q1).toBeGreaterThan(before);
    expect(mid).toBeGreaterThan(q1);
    expect(q3).toBeGreaterThan(mid);
    // Centred: roughly half dissolved AT the cut. A window that starts at the cut (or one that
    // never completes) misses this badly.
    expect(mid).toBeGreaterThan(before + (after - before) * 0.25);
    expect(mid).toBeLessThan(before + (after - before) * 0.75);
  }, 60_000);

  it("rotate leaves black gaps in the corners", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("rotate", 160, 120);
    const src = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 160, h: 120, dur: 1 });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    await setClipPropertiesTool({ clip_ids: [id], rotate: 45 }, ctx);
    const mp4 = await renderMp4(ctx, dir);
    const corner = await regionScopes(ctx, mp4, joinPath(dir, "c.png"), {
      atSec: 0.5,
      vf: "crop=24:24:0:0",
    }); // top-left
    const center = await regionScopes(ctx, mp4, joinPath(dir, "m.png"), {
      atSec: 0.5,
      vf: "crop=24:24:68:48",
    }); // centre
    expect(center.mean[0]).toBeGreaterThan(0.5); // centre still red
    expect(corner.luma).toBeLessThan(center.luma - 0.1); // corner rotated away to black
  }, 60_000);
});

// ── Slice B: audio ──────────────────────────────────────────────────────────
describe("golden: audio", () => {
  it("audio fades ramp the level up at the head and down at the tail", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("fade", 160, 120);
    await addTrackTool({ id: "v1", kind: "video" }, ctx);
    await addTrackTool({ id: "a1", kind: "audio" }, ctx);
    const bed = await srcSolid(joinPath(dir, "bed.mp4"), {
      color: "black",
      w: 160,
      h: 120,
      dur: 1,
    }); // silent picture
    const tone = await srcTone(joinPath(dir, "tone.wav"), { freq: 440, dur: 1 });
    await addClip(ctx, { media_ref: bed, timeline_in: 0, timeline_out: 30, track_id: "v1" });
    const aid = await addClip(ctx, {
      media_ref: tone,
      timeline_in: 0,
      timeline_out: 30,
      track_id: "a1",
    });
    await setClipPropertiesTool({ clip_ids: [aid], fade: { in: 10, out: 10 } }, ctx); // 10 frames = 1/3 s each
    const mp4 = await renderMp4(ctx, dir);
    const head = await meanVolumeDb(mp4, { ss: 0, dur: 0.1 }); // deep in the fade-in
    const mid = await meanVolumeDb(mp4, { ss: 0.5, dur: 0.1 }); // full level
    const tail = await meanVolumeDb(mp4, { ss: 0.9, dur: 0.1 }); // deep in the fade-out
    expect(mid).toBeGreaterThan(head + 6); // head is quieter by a clear margin
    expect(mid).toBeGreaterThan(tail + 6); // tail is quieter too
  }, 60_000);

  it("speed=2 renders a pitch-preserving half-length clip that stays audible", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("atempo", 160, 120);
    const src = await srcSolid(joinPath(dir, "tone.mp4"), {
      color: "gray",
      w: 160,
      h: 120,
      dur: 2,
      freq: 440,
    });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 60 }); // 2s slot
    await setClipPropertiesTool({ clip_ids: [id], speed: 2 }, ctx); // -> 1s slot, source unchanged
    const mp4 = await renderMp4(ctx, dir);
    const p = await probe(mp4);
    expect(p.durationS).toBeGreaterThan(0.85);
    expect(p.durationS).toBeLessThan(1.2); // ~1s, not 2s
    expect(await meanVolumeDb(mp4)).toBeGreaterThan(-50); // still audible (atempo, not muted)
  }, 60_000);

  it("multi-track audio mixes without clipping", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("amix", 160, 120);
    await addTrackTool({ id: "v1", kind: "video" }, ctx);
    await addTrackTool({ id: "a1", kind: "audio" }, ctx);
    await addTrackTool({ id: "a2", kind: "audio" }, ctx);
    const bed = await srcSolid(joinPath(dir, "bed.mp4"), {
      color: "black",
      w: 160,
      h: 120,
      dur: 1,
    });
    const t1 = await srcTone(joinPath(dir, "t1.wav"), { freq: 440, dur: 1 });
    const t2 = await srcTone(joinPath(dir, "t2.wav"), { freq: 660, dur: 1 });
    await addClip(ctx, { media_ref: bed, timeline_in: 0, timeline_out: 30, track_id: "v1" });
    await addClip(ctx, { media_ref: t1, timeline_in: 0, timeline_out: 30, track_id: "a1" });
    await addClip(ctx, { media_ref: t2, timeline_in: 0, timeline_out: 30, track_id: "a2" });
    const mp4 = await renderMp4(ctx, dir);
    expect(await meanVolumeDb(mp4)).toBeGreaterThan(-50); // the mix is audible
    // max_volume must not hard-clip (0 dBFS): parse it from a full-file pass.
    const r = await ctx.runner.run("ffmpeg", ["-i", mp4, "-af", "volumedetect", "-f", "null", "-"]);
    const max = r.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    expect(max).toBeTruthy();
    expect(Number(max![1])).toBeLessThanOrEqual(0.5);
  }, 60_000);

  it("a loop clip fills a longer slot, staying audible past the source length", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("loop", 160, 120);
    await addTrackTool({ id: "v1", kind: "video" }, ctx);
    await addTrackTool({ id: "a1", kind: "audio" }, ctx);
    const bed = await srcSolid(joinPath(dir, "bed.mp4"), {
      color: "black",
      w: 160,
      h: 120,
      dur: 1,
    });
    const tone = await srcTone(joinPath(dir, "tone.wav"), { freq: 440, dur: 0.5 }); // 0.5s source (15 frames)
    await addClip(ctx, { media_ref: bed, timeline_in: 0, timeline_out: 30, track_id: "v1" });
    const aid = await addClip(ctx, {
      media_ref: tone,
      timeline_in: 0,
      timeline_out: 15,
      track_id: "a1",
    }); // source-length slot
    await setClipPropertiesTool({ clip_ids: [aid], duration: 30, loop: true }, ctx); // extend to 1s, loop to fill
    const mp4 = await renderMp4(ctx, dir);
    // The second half (0.6–0.9s) is PAST the 0.5s source — audible only if the loop repeated.
    expect(await meanVolumeDb(mp4, { ss: 0.6, dur: 0.3 })).toBeGreaterThan(-50);
  }, 60_000);
});

// ── Slice C: colour grade + crop ────────────────────────────────────────────
describe("golden: colour + crop", () => {
  it("saturation=0 desaturates a colour clip toward gray", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("sat", 160, 120);
    const src = await srcSolid(joinPath(dir, "red.mp4"), { color: "red", w: 160, h: 120, dur: 1 });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    await applyColorTool({ clip_ids: [id], saturation: 0 }, ctx);
    const s = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "f.png"), { atSec: 0.5 }),
    );
    expect(s.saturation).toBeLessThan(0.2); // colour removed
    expect(Math.abs(s.mean[0] - s.mean[1])).toBeLessThan(0.15); // R≈G (gray)
    expect(Math.abs(s.mean[0] - s.mean[2])).toBeLessThan(0.15); // R≈B (gray)
  }, 60_000);

  it("exposure lifts the rendered brightness", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("exposure", 160, 120);
    const src = await srcSolid(joinPath(dir, "gray.mp4"), {
      color: "gray",
      w: 160,
      h: 120,
      dur: 1,
    });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    const base = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "b.png"), { atSec: 0.5 }),
    );
    await applyColorTool({ clip_ids: [id], exposure: 0.5 }, ctx);
    const lifted = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "l.png"), { atSec: 0.5 }),
    );
    expect(lifted.luma).toBeGreaterThan(base.luma + 0.1);
  }, 60_000);

  it("a master tone-curve lifts midtones (export-only path)", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("curve", 160, 120);
    const src = await srcSolid(joinPath(dir, "gray.mp4"), {
      color: "gray",
      w: 160,
      h: 120,
      dur: 1,
    });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    const base = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "b.png"), { atSec: 0.5 }),
    );
    await applyColorTool(
      {
        clip_ids: [id],
        masterCurve: [
          [0, 0],
          [0.5, 0.75],
          [1, 1],
        ],
      },
      ctx,
    ); // lift mids
    const curved = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "c.png"), { atSec: 0.5 }),
    );
    expect(curved.luma).toBeGreaterThan(base.luma + 0.1); // 0.5 -> ~0.75
  }, 60_000);

  it("crop keeps only the un-cropped region of the source", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("crop", 160, 120);
    const src = await srcSplit(joinPath(dir, "split.mp4"), {
      left: "blue",
      right: "red",
      w: 120,
      h: 120,
      dur: 1,
    });
    const id = await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    const base = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "b.png"), { atSec: 0.5 }),
    );
    expect(base.mean[2]).toBeGreaterThan(0.2); // blue half is present
    await setClipPropertiesTool({ clip_ids: [id], crop: { left: 0.5 } }, ctx); // drop the left (blue) half
    const cropped = await measureColor(
      ctx,
      await framePng(await renderMp4(ctx, dir), joinPath(dir, "c.png"), { atSec: 0.5 }),
    );
    expect(cropped.mean[2]).toBeLessThan(base.mean[2] - 0.1); // the blue half is gone
    expect(cropped.mean[0]).toBeGreaterThan(cropped.mean[2] + 0.2); // red dominates what remains
  }, 60_000);
});

// ── Slice D: A/V sync ────────────────────────────────────────────────────────
describe("golden: A/V sync", () => {
  it("video and audio streams stay length-matched to the timeline", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("sync", 160, 120);
    await addTrackTool({ id: "v1", kind: "video" }, ctx);
    await addTrackTool({ id: "a1", kind: "audio" }, ctx);
    const bed = await srcSolid(joinPath(dir, "bed.mp4"), { color: "red", w: 160, h: 120, dur: 1 });
    const tone = await srcTone(joinPath(dir, "tone.wav"), { freq: 440, dur: 1 });
    await addClip(ctx, { media_ref: bed, timeline_in: 0, timeline_out: 30, track_id: "v1" });
    await addClip(ctx, { media_ref: tone, timeline_in: 0, timeline_out: 30, track_id: "a1" });
    const p = await probe(await renderMp4(ctx, dir));
    expect(p.hasAudio).toBe(true);
    expect(p.durationS).toBeGreaterThan(0.85);
    expect(p.durationS).toBeLessThan(1.2); // ~1s (30 frames @ 30fps)
    expect(Math.abs(p.vDurationS - p.aDurationS)).toBeLessThan(0.15); // streams aligned
  }, 60_000);
});

// ── Slice E: export deliverable ──────────────────────────────────────────────
describe("golden: export", () => {
  it("export writes a playable mp4 deliverable of the right size/streams", async () => {
    if (!HAVE_FFMPEG) return;
    const { dir, ctx } = await project("export", 160, 120);
    const src = await srcSolid(joinPath(dir, "red.mp4"), {
      color: "red",
      w: 160,
      h: 120,
      dur: 1,
      freq: 440,
    });
    await addClip(ctx, { media_ref: src, timeline_in: 0, timeline_out: 30 });
    const res = (await exportTimelineTool({ name: "deliverable" }, ctx)) as Rec;
    expect(res.ok).toBe(true);
    expect(res.format).toBe("mp4");
    expect(String(res.saved_to)).toMatch(/deliverable\.mp4$/);
    // The export is QUEUED: without this the assertions below would be checking a receipt
    // rather than a file, and would pass with no encoder in sight.
    await whenExportsSettle();
    // The deliverable is a real, playable mp4 with the canvas size, ~1s, and audio.
    const out = await ctx.store.exportPath("deliverable.mp4");
    const p = await probe(out);
    expect(p.width).toBe(160);
    expect(p.durationS).toBeGreaterThan(0.8);
    expect(p.hasAudio).toBe(true);
  }, 60_000);
});
