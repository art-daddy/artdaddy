// Phase 2 (UJ-012): inspect_timeline renders the frames it is asked for and nothing else. It used to
// render the timeline from frame 0 to the deepest frame asked for, so a look at minute 14 cost 14
// minutes of encode: p90 241 s in production, 20 of 65 calls failed. These tests drive the real tool
// against the ffmpeg the app ships and measure the work: wall time, where in the timeline the frames
// are, and how many frames ffmpeg itself says it decoded.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/inspectTimeline.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ClientToolContext } from "./context";
import { inspectTimelineTool } from "./inspect";
import { ProjectStoreAccess, joinPath } from "./store";
import { ensureTimeline } from "../timeline/engine";
import { addClipsTool, addTextClipsTool } from "../timeline/placement";
import {
  decodeCountingRunner,
  ff,
  flushE2EDoc,
  installE2EDocuments,
  libRef,
  longFixture,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  resetE2EDocuments,
} from "./__e2e";

// The grid's labels are drawn with the bundled font, as in the app.
vi.mock("@tauri-apps/api/path", async () => {
  const p = await import("node:path");
  return { resolveResource: async (r: string) => p.resolve(process.cwd(), "src-tauri", r) };
});

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const FPS = 30;
const GOP = 120; // a keyframe every 4 s, as OBS and most phones write
const LONG_S = 14 * 60;
const TOTAL = LONG_S * FPS;

const root = path.join(os.tmpdir(), `artdaddy-inspect-tl-${Date.now()}`);
const proj = joinPath(root, "long");
const ctx: ClientToolContext = { store: new ProjectStoreAccess(proj, nodeFs), runner: nodeRunner };

/** Each look must do its own work, so the frames an earlier one cached are thrown away first. */
async function clearFrameCache(dir: string): Promise<void> {
  await fsp.rm(path.join(dir, "internals", "cache", "inspect"), { recursive: true, force: true });
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Width, height and JPEG-ness of a frame file, from its bytes and ffprobe. */
async function jpegFacts(file: string): Promise<{ jpeg: boolean; w: number; h: number }> {
  const buf = await fsp.readFile(file);
  const r = await nodeRunner.run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    file,
  ]);
  const s = (JSON.parse(r.stdout) as { streams: Array<{ width: number; height: number }> }).streams[0];
  return { jpeg: buf[0] === 0xff && buf[1] === 0xd8, w: s.width, h: s.height };
}

/** A frame file as 8-bit grey pixels. */
async function greyPixels(file: string, w: number, h: number): Promise<Uint8Array> {
  const out = `${file}.gray`;
  await ff(["-y", "-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", out]);
  const b = await fsp.readFile(out);
  expect(b.length).toBe(w * h);
  return new Uint8Array(b);
}

beforeAll(async () => {
  installE2EDocuments();
  await fsp.mkdir(proj, { recursive: true });
  const ref = await libRef(ctx, await longFixture({ seconds: LONG_S, fps: FPS, gop: GOP }), "video");
  await openE2EDoc(proj);
  await ensureTimeline(ctx.store); // the default canvas: 1080x1920 @ 30
  const placed = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: TOTAL }] },
    ctx,
  )) as Any;
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  // A captioned timeline, like the one that took 241 s to look at: a caption every 4 s.
  const captions = Array.from({ length: TOTAL / 120 }, (_, i) => ({
    content: `Caption ${i + 1}: something was said here`,
    timeline_in: i * 120,
    timeline_out: i * 120 + 90,
  }));
  const texts = (await addTextClipsTool({ entries: captions }, ctx)) as Any;
  expect(texts.ok, JSON.stringify(texts).slice(0, 400)).toBe(true);
  await flushE2EDoc(proj);
}, 600_000);

afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("inspect_timeline costs the frames it shows, wherever they are (UJ-012)", () => {
  it("six frames spread over a captioned 14-minute 1080p timeline take seconds", async () => {
    await clearFrameCache(proj);
    const t0 = performance.now();
    const r = (await inspectTimelineTool({ start_frame: 0, end_frame: TOTAL }, ctx)) as Any;
    const ms = performance.now() - t0;
    expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
    expect(r.frame_numbers).toHaveLength(6);
    expect(r.frame_numbers[5]).toBeGreaterThan(TOTAL - TOTAL / 6); // the last one is near the end
    expect(r.frames_attached).toBe(6);
    for (const a of r._attachments as Array<{ path: string }>) {
      const f = await jpegFacts(a.path);
      expect(f.jpeg).toBe(true);
      expect(Math.max(f.w, f.h)).toBe(768);
    }
    console.log(`[inspect_timeline] 6 frames over 14 min: ${Math.round(ms)} ms`); // eslint-disable-line no-console
    expect(ms).toBeLessThan(10_000);
  });

  it("frames at the end take no longer than frames at the start (median of 3)", async () => {
    const time = async (start: number): Promise<number> => {
      await clearFrameCache(proj);
      const t0 = performance.now();
      const r = (await inspectTimelineTool({ start_frame: start, end_frame: start + 180 }, ctx)) as Any;
      const ms = performance.now() - t0;
      expect(r.frames_attached).toBe(6);
      return ms;
    };
    const atStart: number[] = [];
    const atEnd: number[] = [];
    for (let i = 0; i < 3; i++) {
      atStart.push(await time(0));
      atEnd.push(await time(TOTAL - 180));
    }
    console.log(`[inspect_timeline] start ${atStart.map(Math.round)} ms, end ${atEnd.map(Math.round)} ms`); // eslint-disable-line no-console
    expect(median(atEnd)).toBeLessThanOrEqual(1.5 * median(atStart));
  });

  it("ffmpeg decodes a few seconds of source per frame, never the timeline up to it", async () => {
    await clearFrameCache(proj);
    // The tool's own commands, with only the log level raised so ffmpeg reports what it decoded.
    const decoded: number[] = [];
    const counting = decodeCountingRunner(decoded);
    // Frames at odd places, so the seeks land mid-GOP: a round range put every one of them on a
    // keyframe and showed only the best case (66 decoded each).
    const r = (await inspectTimelineTool(
      { start_frame: 1234, end_frame: TOTAL - 7 },
      { ...ctx, runner: counting },
    )) as Any;
    expect(r.frames_attached).toBe(6);
    expect(decoded).toHaveLength(6);
    // From the keyframe before the 2 s seek margin to the frame: at most one GOP plus the margin,
    // plus what the decoder runs ahead. The deepest frame from frame 0 would be ~23,000.
    console.log(`[inspect_timeline] frames decoded per look: ${decoded}`); // eslint-disable-line no-console
    for (const n of decoded) {
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(GOP + 2 * FPS + 60);
    }
  });
});

describe("inspect_timeline frames carry the grid and say what failed", () => {
  const W = 1280;
  const H = 720;
  const dir = joinPath(root, "grid");
  const gctx: ClientToolContext = { store: new ProjectStoreAccess(dir, nodeFs), runner: nodeRunner };

  it("draws Palmier's grid where its labels say, and the frame number top-left", async () => {
    await fsp.mkdir(dir, { recursive: true });
    const grey = path.join(dir, "grey.png");
    await ff(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x808080:s=${W}x${H}`, "-frames:v", "1", grey]);
    const ref = await libRef(gctx, grey, "image");
    // Written straight to disk: nothing here edits it, so no open document is needed.
    await nodeFs.writeTextFile(
      joinPath(dir, "internals", "timeline.json"),
      JSON.stringify({
        units: "frames",
        canvas: { width: W, height: H, fps: FPS },
        tracks: [
          {
            id: "v1",
            kind: "video",
            z: 0,
            clips: [{ id: "g", kind: "image", media_ref: ref, timeline_in: 0, timeline_out: 60 }],
          },
        ],
        failures: [],
      }),
    );
    const r = (await inspectTimelineTool({ start_frame: 12 }, gctx)) as Any;
    expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
    expect(r.frames[0].visible_clips).toEqual(["g"]);
    const file = (r._attachments as Array<{ path: string }>)[0].path;
    const { w, h } = await jpegFacts(file);
    expect([w, h]).toEqual([768, 432]);
    const px = await greyPixels(file, w, h);
    const column = (x: number): number => {
      let s = 0;
      for (let y = Math.round(h * 0.3); y < Math.round(h * 0.7); y++) s += px[y * w + x];
      return s / (Math.round(h * 0.7) - Math.round(h * 0.3));
    };
    const row = (y: number): number => {
      let s = 0;
      for (let x = Math.round(w * 0.3); x < Math.round(w * 0.7); x++) s += px[y * w + x];
      return s / (Math.round(w * 0.7) - Math.round(w * 0.3));
    };
    // Every line is a light core over a dark stroke (Palmier's look): brighter than the picture at
    // its centre, darker beside it. Measured on grey 128: major core 181 / edges 110, minor core 160
    // / edges 113, and between lines exactly the picture.
    const line = (at: (i: number) => number, c: number): { core: number; edge: number } => ({
      core: Math.max(at(c - 1), at(c), at(c + 1)),
      edge: Math.min(at(c - 2), at(c - 1), at(c + 1), at(c + 2)),
    });
    for (const [at, size] of [
      [column, w],
      [row, h],
    ] as const) {
      const major = line(at, Math.round(size * 0.5));
      expect(major.core).toBeGreaterThan(128 + 40);
      expect(major.edge).toBeLessThan(128 - 10);
      const minor = line(at, Math.round(size * 0.35));
      expect(minor.core).toBeGreaterThan(128 + 20);
      expect(minor.edge).toBeLessThan(128 - 8);
      for (let d = -3; d <= 3; d++) expect(Math.abs(at(Math.round(size * 0.525) + d) - 128)).toBeLessThan(6);
    }
    // The "f12" chip: a dark box with light text, top-left.
    let lo = 255;
    let hi = 0;
    for (let y = 4; y < 20; y++)
      for (let x = 6; x < 30; x++) {
        lo = Math.min(lo, px[y * w + x]);
        hi = Math.max(hi, px[y * w + x]);
      }
    expect(lo).toBeLessThan(80);
    expect(hi).toBeGreaterThan(180);
  });

  // The Austria journey (2026-10-02): a source in iCloud, and the look failed in 0.2 s with
  // "timeline render failed (code=-2)". A frame that does not touch the missing file must still come
  // back, and the one that does must name the clip and the file.
  it("names the clip whose file is gone, and still returns the frames that do not need it", async () => {
    const odir = joinPath(root, "offline");
    const octx: ClientToolContext = { store: new ProjectStoreAccess(odir, nodeFs), runner: nodeRunner };
    await fsp.mkdir(odir, { recursive: true });
    const here = path.join(root, "here.mp4");
    const gone = path.join(root, "gone.mp4");
    // Different pictures: the library is content-addressed, and two identical files are one asset.
    for (const [f, pattern] of [
      [here, "testsrc2"],
      [gone, "testsrc"],
    ])
      await ff(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `${pattern}=size=320x180:rate=${FPS}:duration=3`, "-pix_fmt", "yuv420p", f]);
    const a = await libRef(octx, here, "video");
    const b = await libRef(octx, gone, "video");
    await openE2EDoc(odir);
    await ensureTimeline(octx.store);
    const placed = (await addClipsTool(
      {
        entries: [
          { media_ref: a, timeline_in: 0, timeline_out: 90 },
          { media_ref: b, timeline_in: 90, timeline_out: 180 },
        ],
      },
      octx,
    )) as Any;
    expect(placed.ok, JSON.stringify(placed)).toBe(true);
    await flushE2EDoc(odir);
    await fsp.rm(gone); // moved to the cloud, deleted, or on a drive that is not plugged in
    const goneClip = (placed.created as Array<{ clip_id: string }>)[1].clip_id;
    const r = (await inspectTimelineTool({ start_frame: 0, end_frame: 180, max_frames: 2 }, octx)) as Any;
    expect(r.ok, JSON.stringify(r).slice(0, 800)).toBe(true);
    const [first, second] = r.frames as Any[];
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toContain(`clip ${goneClip} uses 'gone.mp4', which is not on disk`);
    expect(r.frames_attached).toBe(1);
  });
});
