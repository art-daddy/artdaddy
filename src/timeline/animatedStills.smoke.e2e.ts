// Animated stills through the real export door, judged on the delivered file. Before this, an
// animated WebP or APNG anywhere on the timeline FAILED the whole export ("Option loop not found"),
// and a GIF saved as .png did too: the export picked a still's loop option by its NAME, and ffmpeg
// picks its reader by content (media/stillReader.ts).
//   npx vitest run --config vitest.smoke.config.ts src/timeline/animatedStills.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  openE2EDoc,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { inspectTimelineTool } from "../tools/inspect";
import { ensureTimeline } from "./engine";
import { whenExportEnds } from "./exportQueue";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { setClipPropertiesTool } from "./props";
import { exportTimelineTool } from "./render";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-animstills-${Date.now()}`);
const W = 200;
const H = 120;
const FPS = 10;

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** 1 s at 10 fps: a 40 px red square crossing transparency, x = 80 * t. */
const MOVING = [
  "-f",
  "lavfi",
  "-i",
  `color=c=black@0:s=${W}x${H}:r=${FPS}:d=1,format=rgba[bg];color=c=red:s=40x40:r=${FPS}:d=1,format=rgba[sq];[bg][sq]overlay=x='t*80':y=40`,
];

interface Row {
  name: string;
  file: string;
  make: (out: string) => string[][];
  /** The file plays its animation once and then holds its last frame (as a browser shows it). */
  playsOnce?: boolean;
}
const ROWS: Row[] = [
  { name: "GIF", file: "sticker.gif", make: (o) => [[...MOVING, o]] },
  { name: "animated WebP", file: "sticker.webp", make: (o) => [[...MOVING, "-c:v", "libwebp_anim", "-loop", "0", o]] },
  { name: "animated PNG", file: "sticker.png", make: (o) => [[...MOVING, "-f", "apng", "-plays", "0", o]] },
  {
    name: "GIF saved as .png",
    file: "meme.png",
    make: (o) => {
      const gif = o.replace(/\.png$/, ".tmp.gif");
      return [[...MOVING, gif], ["-i", gif, "-c", "copy", "-f", "gif", o]];
    },
  },
  {
    name: "animated WebP that plays once",
    file: "once.webp",
    make: (o) => [[...MOVING, "-c:v", "libwebp_anim", "-loop", "1", o]],
    playsOnce: true,
  },
  // Read once, plainly (its own reader either ends or loops on a play-N file, by its length).
  {
    name: "animated PNG that plays once",
    file: "once.png",
    make: (o) => [[...MOVING, "-f", "apng", "-plays", "1", o]],
    playsOnce: true,
  },
];

/** The square's left edge on the middle row of the delivered file at `t`, or -1 when no red. */
async function squareX(file: string, t: number): Promise<number> {
  const raw = `${file}.${t}.raw`;
  await ff(["-y", "-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=iw:2:0:${H / 2}`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  const px = new Uint8Array(await fsp.readFile(raw));
  for (let x = 0; x < W; x++) if (px[3 * x] > 150 && px[3 * x + 1] < 90 && px[3 * x + 2] < 90) return x;
  return -1;
}

describe("an animated still exports, animates and loops", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))(
    "%s",
    async (_name, row) => {
      const dir = joinPath(ROOT, row.file.replace(/\W+/g, "_"));
      await nodeFs.mkdir(dir);
      await openE2EDoc(dir);
      const ctx = mkCtx(dir);
      await ensureTimeline(ctx.store);
      expect(((await setCanvasTool({ width: W, height: H, fps: FPS }, ctx)) as Rec).ok).toBe(true);

      const src = joinPath(dir, row.file);
      for (const args of row.make(src)) await ff(["-y", "-v", "error", ...args]);
      const ref = await libRef(ctx, src, "image");
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 35 }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed)).toBe(true);

      const res = (await exportTimelineTool({ name: "out" }, ctx)) as Rec;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const ended = await whenExportEnds(String(res.job_id));
      expect(ended?.state, JSON.stringify(ended)).toBe("done");

      const out = await ctx.store.exportPath("out.mp4");
      const early = await squareX(out, 0.25);
      const later = await squareX(out, 0.75);
      expect(early, "the square is in the picture").toBeGreaterThanOrEqual(0);
      expect(later - early, "the square moves: the still animates").toBeGreaterThan(20);
      const nextLoop = await squareX(out, 1.25);
      if (row.playsOnce) expect(nextLoop, "holds its last frame").toBeGreaterThan(later);
      else expect(Math.abs(nextLoop - early), "a second later it is where it started: it loops").toBeLessThanOrEqual(4);
    },
    180_000,
  );
});

// A 2..8-frame APNG HANGS `-stream_loop -1` (measured on the shipped ffmpeg; 9+ frames do not), so
// the 10-frame rows above could not see it: the export of a blinking icon never ended. The smallest
// animations of every reader, judged frame by frame on the delivered file, with a hard limit.
describe("a short animation loops frame for frame", () => {
  const FEW = (n: number) => [...MOVING, "-frames:v", String(n)];
  it.each([
    { name: "APNG", file: "blink.png", frames: 6, enc: ["-f", "apng", "-plays", "0"] },
    { name: "APNG", file: "blink2.png", frames: 2, enc: ["-f", "apng", "-plays", "0"] },
    { name: "GIF", file: "blink.gif", frames: 6, enc: [] },
    { name: "WebP", file: "blink.webp", frames: 6, enc: ["-c:v", "libwebp_anim", "-loop", "0"] },
  ])(
    "$name of $frames frames",
    async ({ file, frames, enc }) => {
      const dir = joinPath(ROOT, `few_${file.replace(/\W+/g, "_")}`);
      await nodeFs.mkdir(dir);
      await openE2EDoc(dir);
      const ctx = mkCtx(dir);
      await ensureTimeline(ctx.store);
      expect(((await setCanvasTool({ width: W, height: H, fps: FPS }, ctx)) as Rec).ok).toBe(true);
      const src = joinPath(dir, file);
      await ff(["-y", "-v", "error", ...FEW(frames), ...enc, src]);
      const ref = await libRef(ctx, src, "image");
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 20 }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed)).toBe(true);
      const res = (await exportTimelineTool({ name: "out" }, ctx)) as Rec;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const ended = await Promise.race([
        whenExportEnds(String(res.job_id)),
        new Promise<null>((r) => setTimeout(() => r(null), 45_000)),
      ]);
      expect(ended?.state, "the export finished (a hang never ends)").toBe("done");
      const out = await ctx.store.exportPath("out.mp4");
      // The source runs at the project's own 10 fps, so project frame k shows source frame k mod n,
      // whose square sits at x = 8 * (k mod n).
      const seen: number[] = [];
      for (let k = 0; k < 14; k++) seen.push(await squareX(out, k / FPS));
      expect(seen).toEqual(Array.from({ length: 14 }, (_, k) => 8 * (k % frames)));
    },
    120_000,
  );
});

// Speed is offered on a still (the Inspector shows it), and it changes how fast an animation plays,
// not how long the clip lasts. The export cut a still's input to its slot's length and only THEN
// compressed it by the speed, so at 2x every still -- a plain picture as much as a GIF -- vanished
// halfway through its own slot, while the preview went on showing it.
describe("a retimed still stays in the picture for its whole slot", () => {
  const PICTURE = (o: string): string[][] => [
    ["-f", "lavfi", "-i", "color=c=red:s=40x40,format=rgba", "-frames:v", "1", o],
  ];
  it.each([
    { name: "picture", file: "still.png", make: PICTURE, speed: 2 },
    { name: "GIF", file: "sticker.gif", make: (o: string) => [[...MOVING, o]], speed: 2 },
    { name: "GIF", file: "slow.gif", make: (o: string) => [[...MOVING, o]], speed: 0.5 },
  ])(
    "$name at $speed x",
    async ({ file, make, speed }) => {
      const dir = joinPath(ROOT, `speed_${file.replace(/\W+/g, "_")}`);
      await nodeFs.mkdir(dir);
      await openE2EDoc(dir);
      const ctx = mkCtx(dir);
      await ensureTimeline(ctx.store);
      expect(((await setCanvasTool({ width: W, height: H, fps: FPS }, ctx)) as Rec).ok).toBe(true);
      const src = joinPath(dir, file);
      for (const args of make(src)) await ff(["-y", "-v", "error", ...args]);
      const ref = await libRef(ctx, src, "image");
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 30 }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed)).toBe(true);
      const id = String((placed.clips as Rec[])[0].id);
      const set = (await setClipPropertiesTool({ clip_ids: [id], speed }, ctx)) as Rec;
      expect(set.ok, JSON.stringify(set)).toBe(true);
      expect((set.clips as Rec[])[0].timeline_out, "speed leaves a still's length alone").toBe(30);

      // A look seeks by the same span, so the frame it returns must show the still too.
      const look = (await inspectTimelineTool({ start_frame: 25 }, ctx)) as Rec;
      expect(look.ok, JSON.stringify(look).slice(0, 600)).toBe(true);
      const jpeg = (look._attachments as Array<{ path: string }>)[0].path;
      expect(await redPixels(jpeg), "the look at frame 25 shows the still").toBeGreaterThan(100);

      const res = (await exportTimelineTool({ name: "out" }, ctx)) as Rec;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const ended = await whenExportEnds(String(res.job_id));
      expect(ended?.state, JSON.stringify(ended)).toBe("done");
      const out = await ctx.store.exportPath("out.mp4");
      // The slot is frames 0..29 at 10 fps. Probed at each frame's START: an input seek drops every
      // frame stamped before it, so a time inside the last frame would find nothing at all.
      for (const k of [0, 14, 15, 18, 25, 29])
        expect(await squareX(out, k / FPS), `in the picture at frame ${k}`).toBeGreaterThanOrEqual(0);
    },
    180_000,
  );
});

/** Strongly red pixels in a picture, scaled to the canvas size first. */
async function redPixels(file: string): Promise<number> {
  const raw = `${file}.red.raw`;
  await ff(["-y", "-v", "error", "-i", file, "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  const px = new Uint8Array(await fsp.readFile(raw));
  let n = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] > 150 && px[i + 1] < 90 && px[i + 2] < 90) n++;
  return n;
}
