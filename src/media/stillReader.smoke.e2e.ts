// The still-reader classifier against the shipped ffmpeg itself. stillReader() copies ffmpeg's own
// probe rules; this holds the copy to the original, by asking ffprobe which reader it chose AND by
// running the loop option the classifier implies on the real file (a wrong "own" would hang a
// JPEG, a wrong "single" fails the whole export with "Option loop not found").
//   npx vitest run --config vitest.smoke.config.ts src/media/stillReader.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ff, gifLoopAtEnd, nodeFs, nodeRunner, webpWithBigProfile } from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { probeStillFacts } from "./stillProbe";
import { stillLoop } from "./stillReader";

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
/** 16 frames of 2048 x 2048: one pass is over the export's budget for looping in memory. */
const BIG = [
  ...v("color=c=black@0:s=2048x2048:r=10:d=1.6,format=rgba[bg];color=c=red:s=256x256:r=10:d=1.6,format=rgba[sq];[bg][sq]overlay=x='t*1000':y=896"),
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
  // A GIF's own count: none (once), 2 (three times), and 1 kept at the end of the file (twice).
  await ff(["-y", "-v", "error", ...v(MOVING), "-loop", "-1", at("once.gif")]);
  await ff(["-y", "-v", "error", ...v(MOVING), "-loop", "2", at("thrice.gif")]);
  await gifLoopAtEnd(at("once.gif"), at("tail_loop.gif"), 1);
  // An APNG whose first frame is not a key frame (drawn OVER, nothing disposed: as Pillow writes
  // them), and one too big to hold a pass of in memory.
  await apngFirstFrameOps(at("anim_apng.png"), at("over_first_apng.png"), 0, 1);
  await ff(["-y", "-v", "error", ...BIG, "-f", "apng", "-plays", "0", at("big_apng.png")]);
  // A WebP that plays twice, its count behind a 70 KB colour profile.
  await webpWithBigProfile(at("twice.webp"), at("big_profile.webp"), 70_000);
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
  "once.gif",
  "thrice.gif",
  "tail_loop.gif",
  "over_first_apng.png",
  "big_apng.png",
  "big_profile.webp",
];

/** The passes Chromium plays each file (measured with ImageDecoder in the app's WebView: a GIF with
 *  no loop extension once, count N N+1 times; APNG/WebP count N N times; 0 forever). The export
 *  must play the same; Infinity is a still that loops for its whole clip. */
const BROWSER_PASSES: Record<string, number> = {
  "once.gif": 1,
  "thrice.gif": 3,
  "tail_loop.gif": 2,
  "blink_once_apng.png": 1,
  "twice_apng.png": 2,
  "twice.webp": 2,
  "big_profile.webp": 2,
};

const hashes = (md5: string) =>
  md5.split("\n").filter((l) => /^0,/.test(l)).map((l) => l.split(",").pop()!.trim());
const readRange = (file: string) => (offset: number, length: number) =>
  nodeFs.readRange!(file, offset, length).catch(() => null);

describe("stillReader agrees with the shipped ffmpeg", () => {
  it.each(FILES)("%s", async (name) => {
    const file = joinPath(DIR, name);
    const { reader: verdict, facts } = await probeStillFacts(readRange(file), nodeRunner, file);
    const probe = await nodeRunner.run("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", file]);
    const format = probe.stdout.trim().replace(/"/g, "");
    if (verdict === "picture") expect(format, `${name}: classifier says picture`).toMatch(SINGLE_PICTURE);
    else expect(format, `${name}: classifier says ${verdict}`).toBe(FORMAT_OF[verdict!]);
    // The outcome, not the label: the export's own way of looping this still (stillLoop: input
    // options, and for an APNG a loop over its decoded frames) opens the real file and loops it well
    // past the animation's own length, promptly (a wrong option hangs or fails). A file the export
    // plays a set number of times instead ends after them, and the export holds its last frame.
    const loop = stillLoop(verdict!, 30, facts);
    expect(loop.passes, `${name}: the passes a browser plays`).toBe(BROWSER_PASSES[name] ?? Infinity);
    // The export's own rate conversion (render.ts): a bare fps filter pads frames past the end of a
    // stream that ends, which would count a held still as one that plays on.
    const FPS10 = "fps=fps=10:start_time=0:round=near:eof_action=round";
    const vf = loop.graph ? `${loop.graph},trim=duration=3.5,${FPS10}` : FPS10;
    const how = `${loop.input.join(" ")} ${loop.graph ?? ""}`.trim();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    const r = await nodeRunner
      .run("ffmpeg", ["-v", "error", ...loop.input, ...(loop.graph ? [] : ["-t", "3.5"]), "-i", file, "-vf", vf, "-f", "framemd5", "-"], ac.signal)
      .finally(() => clearTimeout(timer));
    expect(ac.signal.aborted, `${name} hung under ${how}`).toBe(false);
    expect(r.code, `${name} under ${how}: ${r.stderr}`).toBe(0);
    // A one-picture loop's last frame keeps its own duration past -t; the export cuts every clip at
    // its out point, so what matters is that it filled the span.
    const frames = r.stdout.split("\n").filter((l) => /^0,/.test(l)).length;
    const passes = loop.passes;
    if (passes === Infinity) expect(frames, `${name}: frames over 3.5 s`).toBeGreaterThanOrEqual(35);
    else {
      // It plays the passes it says, in order, and after them shows only its last frame (the export
      // holds it): never a further pass. Judged on the pictures in order, each run of repeats as one:
      // the rate filter repeats a frame for as long as it lasts, and a GIF with data after its last
      // picture holds that picture longer in the loop (its timing says so; the parity smoke holds
      // the preview to it frame by frame).
      const once = hashes((await nodeRunner.run("ffmpeg", ["-v", "error", "-i", file, "-vf", FPS10, "-f", "framemd5", "-"])).stdout);
      const runs = (h: string[]) => h.filter((x, i) => i === 0 || x !== h[i - 1]);
      const played = Array.from({ length: passes }, () => once).flat();
      expect(runs(hashes(r.stdout)), `${name}: ${passes} pass(es) of ${once.length} frames, then its last`).toEqual(runs(played));
    }
    // Every frame the loop decodes is the frame one pass decodes there, pass after pass (no rate
    // conversion to blur it): a loop that leaves an earlier frame on the canvas, or stops early,
    // differs here.
    const raw = await nodeRunner.run("ffmpeg", [
      "-v", "error", ...loop.input, ...(loop.graph ? [] : ["-t", "3.5"]), "-i", file,
      ...(loop.graph ? ["-vf", `${loop.graph},trim=duration=3.5`] : []),
      "-fps_mode", "passthrough", "-f", "framemd5", "-",
    ]);
    expect(raw.code, `${name} decoded under ${how}: ${raw.stderr}`).toBe(0);
    const pass = hashes((await nodeRunner.run("ffmpeg", ["-v", "error", "-i", file, "-fps_mode", "passthrough", "-f", "framemd5", "-"])).stdout);
    const looped = hashes(raw.stdout);
    if (passes !== Infinity) expect(looped.length, `${name}: ${passes} whole passes`).toBe(passes * pass.length);
    looped.forEach((h, i) => expect(h, `${name}: frame ${i} under ${how}`).toBe(pass[i % pass.length]));
  }, 60_000);
});

/** An APNG's first frame with these dispose/blend ops (the frame covers the whole canvas). */
async function apngFirstFrameOps(apng: string, out: string, dispose: number, blend: number): Promise<void> {
  const b = new Uint8Array(await fsp.readFile(apng));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 8; at + 8 <= b.length; at += 12 + dv.getUint32(at)) {
    if (String.fromCharCode(...b.subarray(at + 4, at + 8)) !== "fcTL") continue;
    b[at + 8 + 24] = dispose;
    b[at + 8 + 25] = blend;
    dv.setUint32(at + 8 + 26, crc32(b.subarray(at + 4, at + 8 + 26)));
    break;
  }
  await fsp.writeFile(out, b);
}

describe("keyFirst says when the shipped ffmpeg can loop an APNG by seeking back to its start", () => {
  // The rule picks how a big APNG loops: `-threads 1 -stream_loop` works only from a key first frame.
  // Every dispose/blend pair of the first frame, judged by ffmpeg itself.
  const PAIRS = [0, 1, 2].flatMap((dispose) => [0, 1].map((blend) => [dispose, blend] as const));
  it.each(PAIRS)("dispose %i, blend %i", async (dispose, blend) => {
    const file = joinPath(DIR, `ops_d${dispose}_b${blend}.png`);
    await apngFirstFrameOps(joinPath(DIR, "anim_apng.png"), file, dispose, blend);
    const { facts } = await probeStillFacts(readRange(file), nodeRunner, file);
    const r = await nodeRunner.run("ffmpeg", [
      "-v", "error", "-threads", "1", "-stream_loop", "-1", "-t", "3.5", "-i", file,
      "-fps_mode", "passthrough", "-f", "framemd5", "-",
    ]);
    // 10 frames a pass: three and a half passes when it loops, one when it cannot seek back.
    const loops = hashes(r.stdout).length >= 35;
    expect(facts.keyFirst === true, `${hashes(r.stdout).length} frames, exit ${r.code}`).toBe(loops);
  }, 60_000);
});
