// End-to-end smoke test: drives the REAL ported tools with a real Node
// CommandRunner (child_process) + real fs against real ffmpeg/ffprobe/yt-dlp.
// NOT part of the unit suite (see vitest.config exclude). Run explicitly:
//   npx vitest run --config vitest.smoke.config.ts
// Network tools are gated behind ARTDADDY_SMOKE_NET=1 (they hit YouTube).
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { clipVideoTool, cropImageTool, probeMediaTool, runFfmpegTool } from "./media";
import { inspectColorTool, inspectMediaTool, inspectTimelineTool } from "./inspect";
import {
  deleteProjectTool,
  duplicateProjectTool,
  listProjectsTool,
  newProjectTool,
} from "./project";
import { downloadVideoTool, videoGetMetadataTool, youtubeSearchTool } from "./net";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { ensureTimeline } from "../timeline/engine";
import { addTrackTool, setCanvasTool } from "../timeline/ops";
import { addClipsTool } from "../timeline/placement";
import { applyColorTool } from "../timeline/props";
import { buildRenderCommand, renderTimelineTool } from "../timeline/render";
import { toSecondsView } from "../timeline/frames";
import { PARITY_CANVAS, PARITY_PROBE_FRAME, parityTimeline } from "../preview/__parity";
import { installE2EDocuments, resetE2EDocuments, flushE2EDoc, libRef, openE2EDoc } from "./__e2e";

type Rec = Record<string, unknown>;

const nodeRunner: CommandRunner = {
  run(program, args): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(program, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  },
};

const nodeFs: FsLike = {
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readTextFile: (p) => fsp.readFile(p, "utf8"),
  async writeTextFile(p, c) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, c);
  },
  async readBytes(p) {
    const b = await fsp.readFile(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  },
  async writeBytes(p, bytes) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, bytes);
  },
  async rename(src, dst) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rename(src, dst);
  },
  async readDir(p) {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  },
  async remove(p) {
    await fsp.rm(p, { recursive: true, force: true });
  },
  async copyFile(src, dst) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
};

async function have(program: string): Promise<boolean> {
  // ffmpeg/ffprobe use -version; yt-dlp uses --version.
  const flag = program === "yt-dlp" ? "--version" : "-version";
  const r = await nodeRunner.run(program, [flag]);
  return r.code === 0;
}

const NET = process.env.ARTDADDY_SMOKE_NET === "1";
const proj = joinPath(os.tmpdir(), `artdaddy-smoke-${Date.now()}`);
const ctx: ClientToolContext = { store: new ProjectStoreAccess(proj, nodeFs), runner: nodeRunner };

beforeAll(() => installE2EDocuments()); // every project dir the harness drives gets an open document (Phase 5.5)
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined);
});

describe("client tools E2E (real binaries)", () => {
  it("probe / run_ffmpeg / clip_video / crop_image on real files", async () => {
    expect(await have("ffmpeg")).toBe(true);
    expect(await have("ffprobe")).toBe(true);

    // Real 3s test video + a still frame, catalogued in the project library.
    await nodeFs.mkdir(proj);
    const source = joinPath(proj, "source.mp4");
    let r = await nodeRunner.run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=30:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      source,
    ]);
    expect(r.code).toBe(0);
    await nodeFs.writeTextFile(
      joinPath(proj, "internals", "library.json"),
      JSON.stringify({
        version: 1,
        clips: [{ id: "media_src01", path: "source.mp4", filename: "source.mp4", kind: "video" }],
        folders: [],
      }),
    );
    r = await nodeRunner.run("ffmpeg", [
      "-y",
      "-i",
      source,
      "-frames:v",
      "1",
      joinPath(proj, "frame.png"),
    ]);
    expect(r.code).toBe(0);

    // probe_media by library id
    const probe = (await probeMediaTool({ media_ref: "media_src01" }, ctx)) as Rec;
    expect(probe.ok).toBe(true);
    expect((probe.video as Rec).width).toBe(320);
    expect(Number(probe.duration_s)).toBeGreaterThan(2.5);

    // run_ffmpeg: rescale to 160px wide
    const scaled = (await runFfmpegTool(
      {
        inputs: ["media_src01"],
        args: ["-i", "{in0}", "-vf", "scale=160:-2", "{out}"],
        output_name: "scaled.mp4",
      },
      ctx,
    )) as Rec;
    expect(scaled.ok).toBe(true);
    expect(String(scaled.media_ref)).toMatch(/^media_[0-9a-f]{12}$/); // registered as a library asset
    expect(await ctx.store.resolveRef(scaled.media_ref as string)).toBeTruthy();
    expect((scaled.video as Rec).width).toBe(160);

    // clip_video: 1s stream-copy cut
    const clip = (await clipVideoTool(
      { media_ref: "media_src01", start_s: 0.5, end_s: 1.5, output_name: "cut.mp4" },
      ctx,
    )) as Rec;
    expect(clip.ok).toBe(true);
    expect(Number(clip.size_bytes)).toBeGreaterThan(0);

    // crop_image: 100x80 crop of the still
    const crop = (await cropImageTool(
      { media_ref: "frame.png", bbox: { x: 20, y: 10, w: 100, h: 80 } },
      ctx,
    )) as Rec;
    expect(crop.ok).toBe(true);
    expect(crop.size).toEqual({ w: 100, h: 80 });
    expect(String(crop.media_ref)).toMatch(/^media_[0-9a-f]{12}$/);

    // timeline: seed on disk, add a track, place the real clip, read it back
    await openE2EDoc(proj); // expose an OPEN document (awaited) before any timeline commit
    await ensureTimeline(ctx.store);
    expect(((await addTrackTool({ id: "v2", kind: "video" }, ctx)) as Rec).ok).toBe(true);
    const placed = (await addClipsTool(
      { entries: [{ media_ref: "media_src01", timeline_in: 0, timeline_out: 90 }] },
      ctx,
    )) as Rec;
    expect(placed.ok).toBe(true);
    await flushE2EDoc(proj); // land the in-memory edits before reading timeline.json off disk
    const tl = JSON.parse(
      await nodeFs.readTextFile(joinPath(proj, "internals", "timeline.json")),
    ) as Rec;
    const tracks = tl.tracks as Rec[];
    expect(tracks.some((t) => (t.clips as unknown[]).length > 0)).toBe(true);

    // render: compile the timeline to a real mp4 via one ffmpeg filter_complex
    const rendered = (await renderTimelineTool({}, ctx)) as Rec;
    expect(rendered.ok).toBe(true);
    expect(await nodeFs.exists(joinPath(proj, rendered.final_mp4 as string))).toBe(true);
    const rprobe = (await probeMediaTool({ media_ref: rendered.final_mp4 as string }, ctx)) as Rec;
    expect(rprobe.ok).toBe(true);
    expect((rprobe.video as Rec).width).toBe(1080); // seeded canvas is 1080x1920
    expect(rprobe.has_audio).toBe(true); // linked audio was mixed in

    // inspect_timeline: render the composite + sample real frames as attachments
    const tlInspect = (await inspectTimelineTool(
      { start_frame: 0, end_frame: 60, max_frames: 3 },
      ctx,
    )) as Rec;
    expect(tlInspect.ok).toBe(true);
    expect(tlInspect.frame_numbers).toEqual([0, 30, 59]);
    const tlAtts = tlInspect._attachments as Array<{ path: string; kind: string }>;
    expect(tlAtts).toHaveLength(3);
    for (const a of tlAtts) {
      expect(a.kind).toBe("image");
      expect(await nodeFs.exists(a.path)).toBe(true); // frames really written to the shared store
    }

    // eslint-disable-next-line no-console
    console.log("[smoke] ffmpeg family OK:", {
      scaled: scaled.path,
      clip: clip.path,
      crop: crop.media_ref,
    });
    // eslint-disable-next-line no-console
    console.log("[smoke] timeline + render OK:", {
      tracks: tracks.length,
      placed: placed.count,
      render: rendered.final_mp4,
    });
  }, 60_000);

  it("render preserves pixel colour + audio (real ffmpeg pixel/audio compare)", async () => {
    expect(await have("ffmpeg")).toBe(true);
    const dir = joinPath(proj, "rp");
    await nodeFs.mkdir(dir);
    await openE2EDoc(dir); // OPEN document (awaited) before timeline commits on this sub-project
    const rp: ClientToolContext = {
      store: new ProjectStoreAccess(dir, nodeFs),
      runner: nodeRunner,
    };
    // A solid RED video carrying a 440Hz sine -> a deterministic pixel colour AND
    // audio signal that must survive the render round-trip.
    const src = joinPath(dir, "red.mp4");
    expect(
      (
        await nodeRunner.run("ffmpeg", [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:size=320x240:rate=30:duration=2",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=2",
          "-shortest",
          "-pix_fmt",
          "yuv420p",
          src,
        ])
      ).code,
    ).toBe(0);
    await ensureTimeline(rp.store);
    // Match the canvas to the source so the rendered frame is edge-to-edge red
    // (no letterbox black diluting the colour scopes).
    expect(((await setCanvasTool({ width: 320, height: 240 }, rp)) as Rec).ok).toBe(true);
    expect(((await addTrackTool({ id: "v", kind: "video" }, rp)) as Rec).ok).toBe(true);
    const srcRef = await libRef(rp, src, "video"); // place by library ref, not a system path
    const placed = (await addClipsTool(
      { entries: [{ media_ref: srcRef, timeline_in: 0, timeline_out: 30 }] },
      rp,
    )) as Rec;
    if (!placed.ok) throw new Error("add_clips failed: " + JSON.stringify(placed));
    const rendered = (await renderTimelineTool({}, rp)) as Rec;
    expect(rendered.ok).toBe(true);
    const mp4 = joinPath(dir, rendered.final_mp4 as string); // final_mp4 is project-relative
    expect(await nodeFs.exists(mp4)).toBe(true);

    // PIXEL compare: a frame pulled from the RENDERED mp4 still measures as red.
    const frame = joinPath(dir, "rframe.png");
    expect((await nodeRunner.run("ffmpeg", ["-y", "-i", mp4, "-frames:v", "1", frame])).code).toBe(
      0,
    );
    const frameRef = await libRef(rp, frame, "image");
    const color = (await inspectColorTool({ media_ref: frameRef }, rp)) as Rec;
    expect(color.ok).toBe(true);
    const scopes = color.scopes as Rec;
    expect(scopes.warm_cool as number).toBeGreaterThan(0.5); // red is warm
    expect(scopes.saturation as number).toBeGreaterThan(0.6); // still saturated after encode
    expect((scopes.hue_histogram as number[])[0]).toBeGreaterThan(0.4); // hue bin 0 (red)

    // AUDIO compare: the rendered mix is NON-SILENT (the 440Hz tone survived).
    const vol = await nodeRunner.run("ffmpeg", [
      "-i",
      mp4,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ]);
    const mean = vol.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    expect(mean).toBeTruthy();
    expect(Number(mean![1])).toBeGreaterThan(-50); // digital silence is ~ -91 dB
    // eslint-disable-next-line no-console
    console.log("[smoke] render pixel/audio OK:", {
      warm_cool: scopes.warm_cool,
      mean_volume_dB: mean?.[1],
    });
  }, 60_000);

  it("inspect_media samples frames from a real video (attachment-transport)", async () => {
    await fsp.mkdir(proj, { recursive: true });
    const src = joinPath(proj, "inspect_src.mp4");
    expect(
      (
        await nodeRunner.run("ffmpeg", [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x240:rate=30:duration=2",
          "-pix_fmt",
          "yuv420p",
          src,
        ])
      ).code,
    ).toBe(0);
    const srcRef = await libRef(ctx, src, "video");
    const r = (await inspectMediaTool({ media_ref: srcRef, max_frames: 3 }, ctx)) as Rec;
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("video");
    const atts = r._attachments as Array<{ path: string; kind: string }>;
    expect(atts).toHaveLength(3);
    for (const a of atts) {
      expect(a.kind).toBe("image");
      expect(await nodeFs.exists(a.path)).toBe(true); // frames really written to the shared store
    }
    // Gemini model -> attach the clipped 480p video instead of frames.
    const g = (await inspectMediaTool(
      { media_ref: srcRef, _model_id: "gemini-2.5-pro", fps: 2 },
      ctx,
    )) as Rec;
    expect(g.ok).toBe(true);
    expect(g.video_attached).toBe(true);
    const gatts = g._attachments as Array<{ path: string; kind: string }>;
    expect(gatts).toHaveLength(1);
    expect(gatts[0].kind).toBe("video");
    expect(await nodeFs.exists(gatts[0].path)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[smoke] inspect_media frames written:", atts.length, "+ gemini video clip");
  }, 60_000);

  it("inspect_color measures scopes on a real frame (raw-RGB decode)", async () => {
    await fsp.mkdir(proj, { recursive: true });
    const img = joinPath(proj, "color_src.png");
    // a solid red frame — deterministic scopes
    expect(
      (
        await nodeRunner.run("ffmpeg", [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:size=320x240",
          "-frames:v",
          "1",
          img,
        ])
      ).code,
    ).toBe(0);
    const imgRef = await libRef(ctx, img, "image");
    const r = (await inspectColorTool({ media_ref: imgRef }, ctx)) as Rec;
    expect(r.ok).toBe(true);
    const scopes = r.scopes as Rec;
    // red is warm (R>>B), highly saturated, hue in bin 0 (0-30 deg)
    expect(scopes.warm_cool as number).toBeGreaterThan(0.5);
    expect(scopes.saturation as number).toBeGreaterThan(0.8);
    expect((scopes.hue_histogram as number[])[0]).toBeGreaterThan(0.5);
    const catts = r._attachments as Array<{ path: string; kind: string }>;
    expect(catts).toHaveLength(1);
    expect(catts[0].kind).toBe("image");
    expect(await nodeFs.exists(catts[0].path)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[smoke] inspect_color scopes:", {
      warm_cool: scopes.warm_cool,
      saturation: scopes.saturation,
    });
  }, 60_000);

  // The smoke lane only ever measured a media_ref — the EASY member. Measuring a CLIP is the
  // path that needs the library ref resolved to a path before ffmpeg sees it, and it was broken
  // for every user while this file stayed green (fixed in 6d3f25a). So: measure the clip, then
  // grade it and measure again. Two samples that must DIFFER is what separates a real
  // measurement of the graded look from a call that merely returns ok.
  it("inspect_color measures a CLIP's graded look through real ffmpeg", async () => {
    const dir = joinPath(proj, "cc");
    await nodeFs.mkdir(dir);
    await openE2EDoc(dir);
    const cc: ClientToolContext = { store: new ProjectStoreAccess(dir, nodeFs), runner: nodeRunner };
    const src = joinPath(dir, "red.mp4");
    expect(
      (
        await nodeRunner.run("ffmpeg", [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:size=320x240:rate=30:duration=2",
          "-pix_fmt",
          "yuv420p",
          src,
        ])
      ).code,
    ).toBe(0);
    await ensureTimeline(cc.store);
    expect(((await setCanvasTool({ width: 320, height: 240 }, cc)) as Rec).ok).toBe(true);
    expect(((await addTrackTool({ id: "v", kind: "video" }, cc)) as Rec).ok).toBe(true);
    const ref = await libRef(cc, src, "video");
    const placed = (await addClipsTool(
      { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 30 }] },
      cc,
    )) as Rec;
    if (!placed.ok) throw new Error("add_clips failed: " + JSON.stringify(placed));
    const clipId = (placed.created as Array<{ clip_id: string }>)[0].clip_id;

    const before = (await inspectColorTool({ clip_id: clipId }, cc)) as Rec;
    expect(before.ok, `measuring a clip failed: ${JSON.stringify(before)}`).toBe(true);
    expect(before.subject).toBe("clip");
    const s0 = before.scopes as Rec;
    expect(s0.saturation as number).toBeGreaterThan(0.6); // red, ungraded

    const graded = (await applyColorTool({ clip_ids: [clipId], saturation: 0 }, cc)) as Rec;
    expect(graded.ok, `apply_color failed: ${JSON.stringify(graded)}`).toBe(true);

    const after = (await inspectColorTool({ clip_id: clipId }, cc)) as Rec;
    expect(after.ok, `measuring the graded clip failed: ${JSON.stringify(after)}`).toBe(true);
    const s1 = after.scopes as Rec;
    // Reading the CLIP means reading its grade. If this returned the raw source the number
    // would not move, which is the failure a plain ok-assertion cannot see.
    expect(s1.saturation as number).toBeLessThan((s0.saturation as number) / 2);
    // eslint-disable-next-line no-console
    console.log("[smoke] inspect_color clip saturation:", s0.saturation, "->", s1.saturation);
  }, 60_000);

  it("project lifecycle: new / list / duplicate / delete on the real fs", async () => {
    const projRoot = joinPath(os.tmpdir(), `artdaddy-proj-smoke-${Date.now()}`);
    const projectsDir = joinPath(projRoot, "projects");
    const activeDir = joinPath(projectsDir, "proj_seed");
    await nodeFs.mkdir(joinPath(activeDir, "internals"));
    await nodeFs.writeTextFile(
      joinPath(activeDir, "internals", "project.json"),
      JSON.stringify({
        id: "proj_seed",
        name: "Seed",
        settings: { canvas: { width: 1080, height: 1920, fps: 30 }, model_id: "" },
      }),
    );
    const pctx: ClientToolContext = {
      store: new ProjectStoreAccess(activeDir, nodeFs),
      runner: nodeRunner,
    };
    try {
      const np = (await newProjectTool({ name: "Smoke Reel", aspect_ratio: "9:16" }, pctx)) as Rec;
      expect(np.ok).toBe(true);
      // new/duplicate return the project id; the dir is <projects>/<id> (no `path` field).
      const npDir = joinPath(projectsDir, np.id as string);
      expect(await nodeFs.exists(joinPath(npDir, "internals", "timeline.json"))).toBe(true);
      expect(await nodeFs.exists(joinPath(npDir, "internals", "project.json"))).toBe(true);

      const ls = (await listProjectsTool({}, pctx)) as Rec;
      expect((ls.projects as Rec[]).some((p) => p.id === np.id)).toBe(true);
      expect(ls.active_project_id).toBe(np.id);

      const dup = (await duplicateProjectTool({ project: np.id as string }, pctx)) as Rec;
      expect(dup.ok).toBe(true);
      const dupDir = joinPath(projectsDir, dup.id as string);
      expect(await nodeFs.exists(joinPath(dupDir, "internals", "timeline.json"))).toBe(true); // media really copied

      const del = (await deleteProjectTool({ project: dup.id as string }, pctx)) as Rec;
      expect(del.ok).toBe(true);
      expect(await nodeFs.exists(dupDir)).toBe(false);
      // eslint-disable-next-line no-console
      console.log("[smoke] project lifecycle OK:", {
        created: np.id,
        duplicated: dup.id,
        deleted: del.deleted,
      });
    } finally {
      await fsp.rm(projRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  it("generates the WebGL/ffmpeg parity reference", async () => {
    const pub = path.join(process.cwd(), "public");
    await fsp.mkdir(pub, { recursive: true });
    await fsp.mkdir(proj, { recursive: true });
    const fg = joinPath(pub, "parity-fg.png");
    const gen = await nodeRunner.run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=400x300:duration=1",
      "-frames:v",
      "1",
      fg,
    ]);
    expect(gen.code).toBe(0);
    // ffmpeg render of the SHARED parity timeline (frames -> seconds view).
    const mp4 = joinPath(proj, "parity.mp4");
    const plan = buildRenderCommand(toSecondsView(parityTimeline(fg)), mp4);
    const r = await nodeRunner.run("ffmpeg", plan.args);
    if (r.code !== 0) {
      // eslint-disable-next-line no-console
      console.log("[smoke] parity ffmpeg args:", plan.args.join(" "));
      // eslint-disable-next-line no-console
      console.log("[smoke] parity ffmpeg stderr:\n", r.stderr);
    }
    expect(r.code).toBe(0);
    const ref = joinPath(pub, "parity-ref.png");
    // Output-seek lands on the first frame with PTS >= seek; aim half a frame
    // BEFORE the probe frame's PTS so that frame is the one delivered.
    const seek = ((PARITY_PROBE_FRAME - 0.5) / PARITY_CANVAS.fps).toFixed(6);
    const ext = await nodeRunner.run("ffmpeg", [
      "-y",
      "-i",
      mp4,
      "-ss",
      seek,
      "-frames:v",
      "1",
      ref,
    ]);
    expect(ext.code).toBe(0);
    expect(await nodeFs.exists(ref)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[smoke] parity reference generated:", ref);
  }, 60_000);

  it("renders the deferred visual features through real ffmpeg", async () => {
    await fsp.mkdir(proj, { recursive: true });
    const sa = joinPath(proj, "sa.mp4");
    const sb = joinPath(proj, "sb.mp4");
    expect(
      (
        await nodeRunner.run("ffmpeg", [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x240:rate=30:duration=1",
          "-pix_fmt",
          "yuv420p",
          sa,
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await nodeRunner.run("ffmpeg", [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=320x240:rate=30:duration=1",
          "-pix_fmt",
          "yuv420p",
          sb,
        ])
      ).code,
    ).toBe(0);
    // Frames-view timeline exercising colour/effects/glow/blend/crossfade + rotate/size/position keyframes.
    const frames = {
      units: "frames",
      canvas: { width: 640, height: 480, fps: 30 },
      tracks: [
        {
          id: "v0",
          kind: "video",
          z: 0,
          clips: [
            {
              media_ref: sa,
              source_in: 0,
              source_out: 30,
              timeline_in: 0,
              timeline_out: 30,
              color: { brightness: 0.05, contrast: 1.1, saturation: 1.2, temperature: 5200 },
              effects: [
                { type: "blur", params: { radius: 2 } },
                { type: "grain", params: { grain: 6 } },
              ],
              glow: 40,
              layout: { x: 40, y: 30, w: 320, h: 240, fit: "cover" },
            },
          ],
        },
        {
          id: "v1",
          kind: "video",
          z: 1,
          clips: [
            {
              media_ref: sb,
              source_in: 0,
              source_out: 30,
              timeline_in: 0,
              timeline_out: 30,
              blend: "screen",
              opacity: 0.8,
              rotate: [
                { t: 0, v: 0 },
                { t: 30, v: 20 },
              ],
              layout: {
                x: [
                  { t: 0, v: 100 },
                  { t: 30, v: 160 },
                ],
                y: 120,
                w: [
                  { t: 0, v: 260 },
                  { t: 30, v: 320 },
                ],
                h: 200,
              },
              transition_in: { kind: "crossfade", duration: 10 },
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof toSecondsView>[0];
    const mp4 = joinPath(proj, "deferred.mp4");
    const plan = buildRenderCommand(toSecondsView(frames), mp4);
    const r = await nodeRunner.run("ffmpeg", plan.args);
    if (r.code !== 0) {
      // eslint-disable-next-line no-console
      console.log("[smoke] deferred ffmpeg args:", plan.args.join(" "));
      // eslint-disable-next-line no-console
      console.log("[smoke] deferred ffmpeg stderr:\n", r.stderr);
    }
    expect(r.code).toBe(0);
    expect(await nodeFs.exists(mp4)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[smoke] deferred visual features rendered OK");
  }, 60_000);

  it.runIf(NET)(
    "yt-dlp: youtube_search + video_get_metadata + windowed download",
    async () => {
      expect(await have("yt-dlp")).toBe(true);

      const search = (await youtubeSearchTool(
        { query: "big buck bunny", n: 1, enrich: false },
        ctx,
      )) as Rec;
      expect(search.ok).toBe(true);
      const results = search.results as Rec[];
      expect(results.length).toBeGreaterThan(0);
      const url = results[0].url as string;

      const meta = (await videoGetMetadataTool({ url }, ctx)) as Rec;
      expect(meta.ok).toBe(true);
      expect((meta.metadata as Rec).title).toBeTruthy();

      const dl = (await downloadVideoTool(
        { url, output_name: "dl.mp4", start_s: 1, end_s: 3 },
        ctx,
      )) as Rec;
      expect(dl.ok).toBe(true);
      expect(await nodeFs.exists(dl.path as string)).toBe(true);

      // eslint-disable-next-line no-console
      console.log("[smoke] yt-dlp family OK:", {
        url,
        title: (meta.metadata as Rec).title,
        dl: dl.path,
      });
    },
    180_000,
  );
});
