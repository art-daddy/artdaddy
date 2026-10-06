// The still-reader classifier against the shipped ffmpeg itself. stillReader() copies ffmpeg's own
// probe rules; this holds the copy to the original, by asking ffprobe which reader it chose AND by
// running the loop option the classifier implies on the real file (a wrong "own" would hang a
// JPEG, a wrong "single" fails the whole export with "Option loop not found").
//   npx vitest run --config vitest.smoke.config.ts src/media/stillReader.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ff, nodeRunner } from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { exportPasses, STILL_HEAD_BYTES, stillLoopArgs, stillPlays, stillReader } from "./stillReader";

const DIR = joinPath(os.tmpdir(), `artdaddy-stillreader-${Date.now()}`);
const SINGLE_PICTURE = /(^|,)(\w+_pipe|image2)(,|$)/;
/** ffprobe's format name for each reader the classifier names. */
const FORMAT_OF = { gif: "gif", apng: "apng", webp_anim: "webp_anim", mov: "mov,mp4,m4a,3gp,3g2,mj2" };

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** A real PNG chunk (with its CRC), so ffmpeg reads the file as written. */
const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};
/** `apng` with an ancillary text chunk of `size` bytes inserted right after IHDR. */
async function apngWithTextFirst(apng: string, out: string, size: number): Promise<void> {
  const b = new Uint8Array(await fsp.readFile(apng));
  const ihdrEnd = 8 + 12 + 13;
  const text = pngChunk("tEXt", new Uint8Array(size).fill(0x41));
  await fsp.writeFile(out, Buffer.concat([b.subarray(0, ihdrEnd), text, b.subarray(ihdrEnd)]));
}

const v = (lavfi: string) => ["-f", "lavfi", "-i", lavfi];
/** 1 s of a red square crossing transparency at 10 fps: a real animation, with alpha. */
const MOVING =
  "color=c=black@0:s=200x120:r=10:d=1,format=rgba[bg];color=c=red:s=40x40:r=10:d=1,format=rgba[sq];[bg][sq]overlay=x='t*80':y=40";
const STILL = "testsrc2=s=200x120:d=1";
/** The smallest animations: a 2-frame blink. An APNG of 8 frames or fewer HANGS `-stream_loop -1`
 *  (measured: 2..8 hang, 9+ do not), so the 10-frame file alone could not see it. */
const BLINK = (r: number) => [...v(MOVING), "-frames:v", "2", "-r", String(r)];
/** Six frames with irregular delays (7,13,5,20,7 cs), as real stickers are timed. */
const IRREGULAR = [
  ...v("color=black:s=240x20:r=100:d=0.6,format=rgba[bg];color=white:s=4x20:r=100:d=0.6,format=rgba[fg];[bg][fg]overlay=x='n*4'"),
  "-vf",
  "select='eq(n\\,0)+eq(n\\,7)+eq(n\\,20)+eq(n\\,25)+eq(n\\,45)+eq(n\\,52)'",
  "-fps_mode",
  "passthrough",
];

beforeAll(async () => {
  await fsp.mkdir(DIR, { recursive: true });
  const at = (n: string) => joinPath(DIR, n);
  await ff(["-y", "-v", "error", ...v(STILL), "-frames:v", "1", at("photo.jpg")]);
  await ff(["-y", "-v", "error", ...v(STILL), "-frames:v", "1", at("shot.png")]);
  await ff(["-y", "-v", "error", ...v(STILL), "-frames:v", "1", at("paint.bmp")]);
  await ff(["-y", "-v", "error", ...v(STILL), "-frames:v", "1", at("scan.tiff")]);
  await ff(["-y", "-v", "error", ...v(STILL), "-frames:v", "1", "-c:v", "libwebp", at("web.webp")]);
  await ff(["-y", "-v", "error", ...v(`${STILL},format=rgba`), "-frames:v", "1", "-c:v", "libwebp", at("alpha.webp")]);
  await ff(["-y", "-v", "error", ...v(MOVING), "-c:v", "libwebp_anim", "-loop", "0", at("anim.webp")]);
  await ff(["-y", "-v", "error", ...v(STILL), "-frames:v", "1", at("still.gif")]);
  await ff(["-y", "-v", "error", ...v(MOVING), at("anim.gif")]);
  await ff(["-y", "-v", "error", ...v(MOVING), "-f", "apng", "-plays", "0", at("anim_apng.png")]);
  await ff(["-y", "-v", "error", ...BLINK(2), "-f", "apng", "-plays", "0", at("blink_apng.png")]);
  await ff(["-y", "-v", "error", ...IRREGULAR, "-f", "apng", "-plays", "0", at("irregular_apng.png")]);
  await ff(["-y", "-v", "error", ...BLINK(2), at("blink.gif")]);
  await ff(["-y", "-v", "error", ...IRREGULAR, at("irregular.gif")]);
  await ff(["-y", "-v", "error", ...BLINK(2), "-c:v", "libwebp_anim", "-loop", "0", at("blink.webp")]);
  await ff(["-y", "-v", "error", ...IRREGULAR, "-c:v", "libwebp_anim", "-loop", "0", at("irregular.webp")]);
  // A set play count: a play-N APNG is read once and held by the export; a WebP plays its count.
  await ff(["-y", "-v", "error", ...BLINK(2), "-f", "apng", "-plays", "1", at("blink_once_apng.png")]);
  await ff(["-y", "-v", "error", ...v(MOVING), "-f", "apng", "-plays", "2", at("twice_apng.png")]);
  await ff(["-y", "-v", "error", ...v(MOVING), "-c:v", "libwebp_anim", "-loop", "2", at("twice.webp")]);
  await ff(["-y", "-v", "error", ...v(STILL), "-frames:v", "1", "-c:v", "libaom-av1", "-still-picture", "1", "-cpu-used", "8", at("modern.avif")]);
  await apngWithTextFirst(at("anim_apng.png"), at("apng_text_500.png"), 500);
  await apngWithTextFirst(at("anim_apng.png"), at("apng_text_3000.png"), 3000);
  // Named for what they are not: ffmpeg goes by content, so must the classifier.
  await fsp.copyFile(at("anim.gif"), at("gif_named.png"));
  await fsp.copyFile(at("shot.png"), at("png_named.gif"));
  await fsp.copyFile(at("photo.jpg"), at("jpeg_named.png"));
}, 120_000);
afterAll(async () => {
  await fsp.rm(DIR, { recursive: true, force: true }).catch(() => undefined);
});

const FILES = [
  "photo.jpg",
  "shot.png",
  "paint.bmp",
  "scan.tiff",
  "web.webp",
  "alpha.webp",
  "anim.webp",
  "still.gif",
  "anim.gif",
  "anim_apng.png",
  "blink_apng.png",
  "irregular_apng.png",
  "blink.gif",
  "irregular.gif",
  "blink.webp",
  "irregular.webp",
  "blink_once_apng.png",
  "twice_apng.png",
  "twice.webp",
  "modern.avif",
  "apng_text_500.png",
  "apng_text_3000.png",
  "gif_named.png",
  "png_named.gif",
  "jpeg_named.png",
];

describe("stillReader agrees with the shipped ffmpeg", () => {
  it.each(FILES)("%s", async (name) => {
    const file = joinPath(DIR, name);
    const head = new Uint8Array((await fsp.readFile(file)).subarray(0, STILL_HEAD_BYTES));
    const verdict = stillReader(head);
    const plays = stillPlays(head);
    const probe = await nodeRunner.run("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", file]);
    const format = probe.stdout.trim().replace(/"/g, "");
    if (verdict === "picture") expect(format, `${name}: classifier says picture`).toMatch(SINGLE_PICTURE);
    else expect(format, `${name}: classifier says ${verdict}`).toBe(FORMAT_OF[verdict!]);
    // The outcome, not the label: the option this reader is given opens the real file and loops it
    // well past the animation's own length, promptly (a wrong option hangs or fails). A file the
    // export plays a set number of times instead ends, and the export holds its last frame
    // (render.ts tpad), the way exportPasses says.
    const loop = stillLoopArgs(verdict!, 30, plays);
    const passes = exportPasses(verdict!, plays);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    const r = await nodeRunner
      .run("ffmpeg", ["-v", "error", ...loop, "-t", "3.5", "-i", file, "-vf", "fps=10", "-f", "framemd5", "-"], ac.signal)
      .finally(() => clearTimeout(timer));
    expect(ac.signal.aborted, `${name} hung under ${loop.join(" ")}`).toBe(false);
    expect(r.code, `${name} under ${loop.join(" ")}: ${r.stderr}`).toBe(0);
    // A one-picture loop's last frame keeps its own duration past -t; the export cuts every clip at
    // its out point, so what matters is that it filled the span.
    const frames = r.stdout.split("\n").filter((l) => /^0,/.test(l)).length;
    if (passes === Infinity) expect(frames, `${name}: frames over 3.5 s`).toBeGreaterThanOrEqual(35);
    else {
      // It ends after the passes it says (the export holds it), and never loops on past them.
      const once = (await nodeRunner.run("ffmpeg", ["-v", "error", "-i", file, "-vf", "fps=10", "-f", "framemd5", "-"])).stdout;
      const perPass = once.split("\n").filter((l) => /^0,/.test(l)).length;
      expect(passes, `${name}: a count the export can hold to`).not.toBeNull();
      expect(frames, `${name}: ${passes} pass(es) of ${perPass} frames`).toBe(perPass * passes!);
    }
  }, 60_000);
});
