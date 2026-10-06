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
import { ensureTimeline } from "./engine";
import { whenExportEnds } from "./exportQueue";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
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
