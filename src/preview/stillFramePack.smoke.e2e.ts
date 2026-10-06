// The preview's animated still against the export, on real files and real pixels.
//
// For each kind of animated still: the frame pack is made by the real generator (ffprobe + ffmpeg,
// as the proxy pass runs it), the timeline is exported through the real export door, and then, at
// every project frame, the frame the PREVIEW would draw there (scene `still` -> stillFrameShown over
// the pack's index -> that PNG of the pack) must show the same picture as the delivered file.
// What is not covered here is only the worker's GPU upload of that PNG.
//   npx vitest run --config vitest.smoke.config.ts src/preview/stillFramePack.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parsePackIndex, splitPngStream, stillFrameShown } from "../media/stillFrames";
import {
  ff,
  gifLoopAtEnd,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  openE2EDoc,
  resetE2EDocuments,
  webpWithBigProfile,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { ensureTimeline, loadTimeline } from "../timeline/engine";
import { whenExportEnds } from "../timeline/exportQueue";
import { setCanvasTool } from "../timeline/ops";
import { addClipsTool } from "../timeline/placement";
import { setClipPropertiesTool, setTransitionTool } from "../timeline/props";
import { exportTimelineTool } from "../timeline/render";
import { animIndexRel, animPackRel } from "./proxyPaths";
import { buildScene } from "./scene";
import { makeStillFramePack } from "./stillFramePack";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-stillframes-${Date.now()}`);
const W = 240;
const H = 64; // the smallest canvas edge the app allows
const FPS = 30;
const SLOT_DEFAULT = 75; // 2.5 s: several loops of every animation below

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

// A white bar on transparency whose x says which source frame this is (x = 4 * source frame of a
// 100 fps lavfi clock), keeping six frames with IRREGULAR delays (7, 13, 5, 20, 7 cs + the last).
const IRREGULAR = [
  "-f",
  "lavfi",
  "-i",
  `color=c=black@0:s=${W}x${H}:r=100:d=0.6,format=rgba[bg];color=c=white:s=4x${H}:r=100:d=0.6,format=rgba[fg];[bg][fg]overlay=x='n*4'`,
  "-vf",
  "select='eq(n\\,0)+eq(n\\,7)+eq(n\\,20)+eq(n\\,25)+eq(n\\,45)+eq(n\\,52)'",
  "-fps_mode",
  "passthrough",
];

const ROWS: Array<{
  name: string;
  file: string;
  enc: string[];
  speed?: number;
  slot?: number;
  /** Made from the encoded file, as a real one is shaped. */
  craft?: (encoded: string, out: string) => Promise<void>;
  /** A transparent clip after it, entering with a crossfade of this many frames: the still is held
   *  under it past its own end, the frame the export holds there. */
  crossfadeAfter?: number;
}> = [
  { name: "GIF", file: "a.gif", enc: [] },
  { name: "APNG", file: "a.png", enc: ["-f", "apng", "-plays", "0"] },
  {
    name: "animated WebP",
    file: "a.webp",
    enc: ["-c:v", "libwebp_anim", "-lossless", "1", "-loop", "0"],
  },
  { name: "APNG that plays once", file: "once.png", enc: ["-f", "apng", "-plays", "1"] },
  { name: "APNG that plays twice", file: "twice.png", enc: ["-f", "apng", "-plays", "2"] },
  {
    name: "WebP that plays twice",
    file: "twice.webp",
    enc: ["-c:v", "libwebp_anim", "-lossless", "1", "-loop", "2"],
  },
  { name: "GIF saved as .png", file: "meme.png", enc: ["-f", "gif"] },
  { name: "GIF at 2x", file: "fast.gif", enc: [], speed: 2 },
  // A browser plays a GIF with no loop extension once, and count N N+1 times (owner: honour the file).
  { name: "GIF that plays once", file: "once.gif", enc: ["-loop", "-1"] },
  { name: "GIF that plays three times", file: "thrice.gif", enc: ["-loop", "2"] },
  // Its count kept at its END: ffmpeg holds the last picture through what follows it.
  {
    name: "GIF with its loop count at its end",
    file: "tail.gif",
    enc: ["-loop", "-1"],
    craft: (gif, out) => gifLoopAtEnd(gif, out, 1),
  },
  // Its count behind a colour profile far bigger than any head read.
  {
    name: "WebP that plays twice behind a 70 KB colour profile",
    file: "profiled.webp",
    enc: ["-c:v", "libwebp_anim", "-lossless", "1", "-loop", "2"],
    craft: (webp, out) => webpWithBigProfile(webp, out, 70_000),
  },
  // 48 frames is where the old preview hold showed frame 5 and the export frame 0.
  { name: "GIF held under a crossfade", file: "held.gif", enc: [], slot: 48, crossfadeAfter: 12 },
  {
    name: "GIF at 1.15x held under a crossfade",
    file: "held115.gif",
    enc: [],
    speed: 1.15,
    slot: 28,
    crossfadeAfter: 12,
  },
  // Its reader's own loop drifted from the file's timing after ~5 s: only a long clip can see it.
  { name: "APNG over 12 s", file: "long.png", enc: ["-f", "apng", "-plays", "0"], slot: 360 },
  {
    name: "WebP over 12 s",
    file: "long.webp",
    enc: ["-c:v", "libwebp_anim", "-lossless", "1", "-loop", "0"],
    slot: 360,
  },
  { name: "GIF over 12 s", file: "long.gif", enc: [], slot: 360 },
];

/** The bar's x in a picture of the canvas size, read from its middle row; -1 when there is none. */
function barX(rgb: Uint8Array, row: number): number {
  for (let x = 0; x < W; x++) if (rgb[row * W * 3 + 3 * x] > 128) return x;
  return -1;
}
async function raw(args: string[], out: string): Promise<Uint8Array> {
  await ff(["-y", "-v", "error", ...args, "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
  return new Uint8Array(await fsp.readFile(out));
}

describe("the preview draws the frame the export draws", () => {
  it.each(ROWS)(
    "$name",
    async ({ file, enc, speed, slot, craft, crossfadeAfter }) => {
      const SLOT = slot ?? SLOT_DEFAULT;
      const AFTER = crossfadeAfter ? 30 : 0;
      const dir = joinPath(ROOT, file.replace(/\W+/g, "_"));
      await nodeFs.mkdir(dir);
      await openE2EDoc(dir);
      const ctx = mkCtx(dir);
      await ensureTimeline(ctx.store);
      const canvas = (await setCanvasTool({ width: W, height: H, fps: FPS }, ctx)) as Rec;
      expect(canvas.ok, JSON.stringify(canvas)).toBe(true);
      const src = joinPath(dir, file);
      if (craft) {
        const encoded = joinPath(dir, `encoded_${file}`);
        await ff(["-y", "-v", "error", ...IRREGULAR, ...enc, encoded]);
        await craft(encoded, src);
      } else await ff(["-y", "-v", "error", ...IRREGULAR, ...enc, src]);
      const ref = await libRef(ctx, src, "image");
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: SLOT }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed)).toBe(true);
      if (speed) {
        const id = String((placed.clips as Rec[])[0].id);
        expect(((await setClipPropertiesTool({ clip_ids: [id], speed }, ctx)) as Rec).ok).toBe(
          true,
        );
      }
      if (crossfadeAfter) {
        // A fully transparent picture: whatever shows through it is the still held beneath.
        const clear = joinPath(dir, "clear.png");
        await ff([
          "-y",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=black@0:s=${W}x${H},format=rgba`,
          "-frames:v",
          "1",
          clear,
        ]);
        const trackId = String(
          (await loadTimeline(ctx.store)).tracks.find((t) => (t.clips ?? []).length > 0)!.id,
        );
        const after = (await addClipsTool(
          {
            entries: [
              {
                media_ref: await libRef(ctx, clear, "image"),
                timeline_in: SLOT,
                timeline_out: SLOT + AFTER,
                track_id: trackId,
              },
            ],
          },
          ctx,
        )) as Rec;
        expect(after.ok, JSON.stringify(after)).toBe(true);
        const nextId = String((after.clips as Rec[])[0].id);
        const tr = (await setTransitionTool(
          { clip_id: nextId, transition_in: { kind: "crossfade", duration: crossfadeAfter } },
          ctx,
        )) as Rec;
        expect(tr.ok, JSON.stringify(tr)).toBe(true);
      }

      // The preview's side: the real generator, then the index and frames it wrote.
      const abs = (await ctx.store.resolveRef(ref))!;
      expect(await makeStillFramePack(ctx.store, ctx.runner, ref), "frames made").toBe(true);
      const index = parsePackIndex(await ctx.store.readText(joinPath(dir, animIndexRel(abs))));
      expect(index, "index readable").not.toBeNull();
      const packBytes = new Uint8Array(await fsp.readFile(joinPath(dir, animPackRel(abs))));
      const ranges = splitPngStream(packBytes);
      expect(ranges?.length, "one PNG per frame").toBe(index!.timing.pts.length);
      // Each pack frame's bar position, decoded the way any reader would decode a PNG.
      const frameX: number[] = [];
      for (let i = 0; i < ranges!.length; i++) {
        const png = joinPath(dir, `f${i}.png`);
        await fsp.writeFile(png, packBytes.subarray(ranges![i][0], ranges![i][1]));
        frameX.push(barX(await raw(["-i", png, "-vf", `scale=${W}:${H}`], `${png}.raw`), H / 2));
      }

      // The export's side: the delivered file, every frame.
      const res = (await exportTimelineTool({ name: "out" }, ctx)) as Rec;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const ended = await Promise.race([
        whenExportEnds(String(res.job_id)),
        new Promise<null>((r) => setTimeout(() => r(null), 60_000)),
      ]);
      expect(ended?.state, "the export finished").toBe("done");
      const out = await ctx.store.exportPath("out.mp4");
      const video = await raw(["-i", out, "-vf", `crop=iw:2:0:${H / 2 - 1}`], `${out}.raw`);
      const rowBytes = W * 3 * 2;
      const delivered = Array.from({ length: video.length / rowBytes }, (_, k) =>
        barX(video.subarray(k * rowBytes), 0),
      );
      expect(delivered.length).toBe(SLOT + AFTER);

      // At every project frame, the frame the preview picks shows the bar where the export shows it.
      const timeline = await loadTimeline(ctx.store);
      const picked: number[] = [];
      for (let k = 0; k < SLOT + AFTER; k++) {
        const layer = buildScene(timeline, k / FPS, new Map()).layers.find((l) => l.source === ref);
        picked.push(
          layer?.still
            ? frameX[
                stillFrameShown(
                  index!.timing,
                  FPS,
                  layer.still.k,
                  layer.still.len,
                  layer.still.speed,
                )
              ]
            : -1,
        );
      }
      // H.264 moves a 4 px edge by a pixel at most.
      const off = picked.map((x, k) => (Math.abs(x - delivered[k]) <= 1 ? "." : "X")).join("");
      expect(off, `preview ${JSON.stringify(picked)}\nexport  ${JSON.stringify(delivered)}`).toBe(
        ".".repeat(SLOT + AFTER),
      );
      // ...and the test can tell: the picture really moves, and a held still is really seen held.
      expect(new Set(delivered).size).toBeGreaterThan(3);
      if (crossfadeAfter)
        expect(
          delivered[SLOT + crossfadeAfter / 2 - 1],
          "held past its end",
        ).toBeGreaterThanOrEqual(0);
    },
    180_000,
  );
});
