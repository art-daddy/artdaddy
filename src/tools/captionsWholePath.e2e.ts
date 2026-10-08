// Whole-path smoke for the caption/text work: drive the REAL tools against a REAL project, render
// with the BUNDLED ffmpeg, and read the PIXELS. Nothing here asserts a filtergraph string — that is
// exactly the shape of test that once passed 38 times over an export containing zero caption pixels.
//
// `npx vitest run --config vitest.smoke.config.ts src/tools/captionsWholePath.e2e.ts`
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addCaptionsTool } from "./captions";
import {
  ff,
  have,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeRunner,
  openE2EDoc,
  regionScopes,
  renderMp4,
  resetE2EDocuments,
  srcSolid,
  srcTone,
} from "./__e2e";
import { transcriptCacheSlot } from "./transcribe";
import { addClipsTool, addTextClipsTool, updateTextTool } from "../timeline/placement";
import { getTimelineTool } from "../timeline/ops";
import { ensureTimeline, loadTimeline, applyOp } from "../timeline/engine";
import type { ClientToolContext } from "./context";

type Rec = Record<string, unknown>;

/** Seed `ref`'s transcript where a finished transcription leaves it (whisper's JSON, in the app
 *  cache, under the file), so add_captions reads these words through its real door without
 *  running whisper. */
async function seedTranscript(
  ctx: ClientToolContext,
  ref: string,
  words: Array<[string, number, number]>,
): Promise<void> {
  const src = await ctx.store.resolveRef(ref);
  const slot = await transcriptCacheSlot(ctx, String(src), "small", undefined);
  const cache = await ctx.store.appCache();
  if (!src || !slot.key || !cache) throw new Error(`cannot seed a transcript for ${ref}`);
  const ms = (s: number): number => Math.round(s * 1000);
  await cache.put(slot.namespace, slot.key, {
    result: { language: "en" },
    transcription: words.length
      ? [
          {
            offsets: { from: ms(words[0][1]), to: ms(words[words.length - 1][2]) },
            text: words.map(([w]) => ` ${w}`).join(""),
            tokens: words.map(([w, start, end]) => ({
              text: ` ${w}`,
              offsets: { from: ms(start), to: ms(end) },
              p: 1,
            })),
          },
        ]
      : [],
  });
}

const dirs: string[] = [];
async function project(bed: string = "black"): Promise<{ ctx: ClientToolContext; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-cap-e2e-"));
  dirs.push(dir);
  const ctx = mkCtx(dir);
  await ensureTimeline(ctx.store);
  await openE2EDoc(dir);
  // Black by default so text is the only thing that can raise luma. The preset comparison uses a
  // GREY bed instead: `boxed` draws a BLACK background box, which on black is invisible by
  // construction — measuring it there would prove nothing either way.
  const bedFile = await srcSolid(path.join(dir, "bed.mp4"), { color: bed, dur: 6 });
  const ref = await libRef(ctx, bedFile, "video");
  const r = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 180 }] },
    ctx,
  )) as Rec;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return { ctx, dir };
}

/** Mean luma (0..1) of the rendered frame at `atSec`, optionally of a region (`vf`, e.g. a crop).
 *  White text on black: more/bigger/brighter glyphs raise it, and nothing else in these projects
 *  can. */
async function inkAt(
  ctx: ClientToolContext,
  dir: string,
  mp4: string,
  atSec: number,
  vf?: string,
): Promise<number> {
  const png = path.join(
    dir,
    `f_${Math.round(atSec * 1000)}_${Math.random().toString(36).slice(2, 8)}.png`,
  );
  return (await regionScopes(ctx, mp4, png, { atSec, vf })).luma;
}

/** The band a centred title sits in. Whole-frame luma is measured on a 240 px thumbnail and
 *  reported to three decimals, which cannot see a thin italic title on a portrait canvas at all:
 *  `editorial` read as "changed nothing" once it was drawn in its real (light) font. */
const TITLE_BAND = "crop=iw:ih*0.2:0:ih*0.4";

/** Darkest-to-brightest luma (0..255) in a region of the frame at `atSec`. */
async function lumaRange(mp4: string, atSec: number, vf: string): Promise<number> {
  const r = await nodeRunner.run("ffmpeg", [
    "-hide_banner",
    "-ss",
    String(atSec),
    "-i",
    mp4,
    "-frames:v",
    "1",
    "-vf",
    `${vf},signalstats,metadata=print`,
    "-f",
    "null",
    "-",
  ]);
  const get = (k: string): number =>
    Number(new RegExp(`lavfi\\.signalstats\\.${k}=(\\d+)`).exec(r.stderr)?.[1]);
  return get("YMAX") - get("YMIN");
}

/** Ink on a frame with NO text at all. Every "did it render?" assertion is made against this
 *  rather than a guessed constant: the lightest preset (a thin font at a modest size) legitimately
 *  paints far less than the heaviest, and a fixed threshold just encodes one preset's weight. */
let baselineInk = 0;

let ffmpegAvailable = false;
beforeAll(async () => {
  installE2EDocuments();
  ffmpegAvailable = await have("ffmpeg");
  if (ffmpegAvailable) {
    const { ctx, dir } = await project();
    baselineInk = await inkAt(ctx, dir, await renderMp4(ctx, dir), 1);
  }
}, 300_000);
afterAll(async () => {
  await resetE2EDocuments();
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const title = (over: Rec = {}): Rec => ({
  timeline_in: 0,
  duration: 150,
  content: "HELLO THERE",
  ...over,
});

describe.skipIf(!process.env.VITEST)("caption + text tools, end to end in pixels", () => {
  it("renders a plain title as visible pixels at all", async () => {
    if (!ffmpegAvailable) return;
    const { ctx, dir } = await project();
    expect(((await addTextClipsTool({ entries: [title()] }, ctx)) as Rec).ok).toBe(true);
    const mp4 = await renderMp4(ctx, dir);
    expect(await inkAt(ctx, dir, mp4, 1)).toBeGreaterThan(baselineInk + 0.002);
  }, 180_000);

  it("every style preset paints something, and they are not one look in six names", async () => {
    if (!ffmpegAvailable) return;
    const presets = ["clean-white", "boxed", "punchy", "headline", "editorial", "minimal"];
    // Grey bed: white glyphs raise luma, a dark background box lowers it. Both are real changes.
    const grey = await project("gray");
    const greyMp4 = await renderMp4(grey.ctx, grey.dir);
    const greyBaseline = await inkAt(grey.ctx, grey.dir, greyMp4, 1, TITLE_BAND);
    const greyRange = await lumaRange(greyMp4, 1, TITLE_BAND);

    const ink: Record<string, number> = {};
    for (const preset of presets) {
      const { ctx, dir } = await project("gray");
      expect(
        ((await addTextClipsTool({ entries: [title({ style: { preset } })] }, ctx)) as Rec).ok,
        preset,
      ).toBe(true);
      const mp4 = await renderMp4(ctx, dir);
      ink[preset] = await inkAt(ctx, dir, mp4, 1, TITLE_BAND);
      // Painted at all: judged by the band's luma RANGE, which an empty grey band does not have.
      // The mean cannot tell: a white fill inside a black outline (headline) can average to the bed.
      const range = await lumaRange(mp4, 1, TITLE_BAND);
      expect(range, `${preset} painted nothing on the band (range ${range})`).toBeGreaterThan(
        greyRange + 40,
      );
    }
    // `boxed` lays a dark background behind the words; `clean-white` is bare glyphs. If the preset
    // reached the plan in name only these would be indistinguishable.
    console.log("[captions] preset ink on the title band:", { greyBaseline, ...ink }); // eslint-disable-line no-console
    expect(
      ink.boxed,
      `boxed (${ink.boxed}) should sit darker than clean-white (${ink["clean-white"]})`,
    ).toBeLessThan(ink["clean-white"]);
    // And the six are not one look wearing six names.
    expect(new Set(Object.values(ink).map((v) => v.toFixed(3))).size).toBeGreaterThan(3);
  }, 900_000);

  // The export draws each family from the fonts the app SHIPS. If they do not reach libass, every
  // family falls back to the same system font and these three render identically, on every OS:
  // that is how the caption suite once passed on Windows and macOS while testing no bundled font.
  it("draws each family with its own bundled font, not one system fallback", async () => {
    if (!ffmpegAvailable) return;
    const families = ["Anton", "Poppins", "Playfair Display"];
    const empty = await project();
    const bandBase = await inkAt(
      empty.ctx,
      empty.dir,
      await renderMp4(empty.ctx, empty.dir),
      1,
      TITLE_BAND,
    );
    const ink: Record<string, number> = {};
    for (const font of families) {
      const { ctx, dir } = await project();
      const r = (await addTextClipsTool(
        { entries: [title({ style: { font, size: "l" } })] },
        ctx,
      )) as Rec;
      expect(r.ok, `${font}: ${JSON.stringify(r)}`).toBe(true);
      ink[font] = await inkAt(ctx, dir, await renderMp4(ctx, dir), 1, TITLE_BAND);
      expect(ink[font], `${font} drew nothing`).toBeGreaterThan(bandBase + 0.002);
    }
    console.log("[captions] font ink on the title band:", { bandBase, ...ink }); // eslint-disable-line no-console
    for (let i = 0; i < families.length; i++)
      for (let j = i + 1; j < families.length; j++)
        expect(
          Math.abs(ink[families[i]] - ink[families[j]]),
          `${families[i]} and ${families[j]} drew the same glyphs: ${JSON.stringify(ink)}`,
        ).toBeGreaterThan(0.002);
  }, 900_000);

  it("size tiers get bigger, in that order", async () => {
    if (!ffmpegAvailable) return;
    const ink: number[] = [];
    for (const size of ["s", "m", "l", "xl"]) {
      const { ctx, dir } = await project();
      expect(
        ((await addTextClipsTool({ entries: [title({ style: { size } })] }, ctx)) as Rec).ok,
      ).toBe(true);
      ink.push(await inkAt(ctx, dir, await renderMp4(ctx, dir), 1));
    }
    for (let i = 1; i < ink.length; i++) {
      expect(ink[i], `tier ${i} not larger than ${i - 1}: ${ink.join(", ")}`).toBeGreaterThan(
        ink[i - 1],
      );
    }
  }, 900_000);

  it("animated presets CHANGE between two frames; a static one does not", async () => {
    if (!ffmpegAvailable) return;
    // The rule for time-varying behaviour: sample two points and assert they differ. A single frame
    // cannot tell "animating" from "inert".
    const runs = [
      "1\n00:00:01,000 --> 00:00:02,000\nx\n", // placeholder, unused
    ];
    void runs;
    const content = [
      { text: "one" },
      { text: "two" },
      { text: "three" },
      { text: "four" },
      { text: "five" },
    ];
    for (const preset of ["typewriter", "word-reveal", "word-highlight", "karaoke"]) {
      const { ctx, dir } = await project();
      const r = (await addTextClipsTool(
        { entries: [title({ content, animation: { preset } })] },
        ctx,
      )) as Rec;
      expect(r.ok, `${preset}: ${JSON.stringify(r)}`).toBe(true);
      const mp4 = await renderMp4(ctx, dir);
      const early = await inkAt(ctx, dir, mp4, 0.3);
      const late = await inkAt(ctx, dir, mp4, 4.5);
      expect(Math.abs(late - early), `${preset} looked identical at 0.3s and 4.5s`).toBeGreaterThan(
        0.0005,
      );
    }

    // Control: with no animation the same clip must look the SAME at both times, so the assertion
    // above is measuring animation rather than encoder noise.
    const { ctx, dir } = await project();
    await addTextClipsTool({ entries: [title({ content })] }, ctx);
    const mp4 = await renderMp4(ctx, dir);
    const a = await inkAt(ctx, dir, mp4, 0.3);
    const b = await inkAt(ctx, dir, mp4, 4.5);
    expect(Math.abs(b - a)).toBeLessThan(0.0005);
  }, 900_000);

  it("update_text actually repaints the frame", async () => {
    if (!ffmpegAvailable) return;
    const { ctx, dir } = await project();
    const add = (await addTextClipsTool(
      { entries: [title({ style: { size: "s" } })] },
      ctx,
    )) as Rec;
    const id = (add.created as Array<{ clip_id: string }>)[0].clip_id;
    const before = await inkAt(ctx, dir, await renderMp4(ctx, dir), 1);

    const up = (await updateTextTool({ clip_ids: [id], style: { size: "xl" } }, ctx)) as Rec;
    expect(up.ok, JSON.stringify(up)).toBe(true);
    const after = await inkAt(ctx, dir, await renderMp4(ctx, dir), 1);
    expect(after, `update_text changed nothing on screen (${before} -> ${after})`).toBeGreaterThan(
      before,
    );
  }, 300_000);

  it("update_text keeps the style fields it was not asked to change", async () => {
    if (!ffmpegAvailable) return;
    const { ctx, dir } = await project();
    const add = (await addTextClipsTool(
      { entries: [title({ style: { preset: "boxed", size: "l" } })] },
      ctx,
    )) as Rec;
    const id = (add.created as Array<{ clip_id: string }>)[0].clip_id;
    const boxed = await inkAt(ctx, dir, await renderMp4(ctx, dir), 1);

    // Change only the words. The box must survive — a wholesale style replace would drop it and the
    // frame would lose most of its ink.
    await updateTextTool({ clip_ids: [id], content: "DIFFERENT WORDS" }, ctx);
    const after = await inkAt(ctx, dir, await renderMp4(ctx, dir), 1);
    expect(after).toBeGreaterThan(boxed * 0.5);
  }, 300_000);
});

// UJ-030 / UJ-032, the whole path: add_captions cuts the speech to fit one line of the caption box,
// the export draws each caption at the size the preview shows, and on screen every one of them is ONE
// line inside the title-safe margins, on a wide canvas and on a tall one. Either half alone (the cut,
// or the size) can be right while the frame is wrong; this reads the frame.
describe.skipIf(!process.env.VITEST)("captions fit one line, end to end in pixels", () => {
  const SPEECH =
    "today we are going to look at how captions fit on a screen and why the size of the screen " +
    "and the size of the text decide how many words each caption can hold";

  /** Luma of one frame of `mp4` at `atSec`, row by row. */
  async function frameLuma(mp4: string, atSec: number): Promise<Buffer> {
    const raw = `${mp4}.${Math.round(atSec * 1000)}.gray`;
    await ff(
      ["-y", "-ss", String(atSec), "-i", mp4, "-frames:v", "1", "-f", "rawvideo"].concat([
        "-pix_fmt",
        "gray",
        raw,
      ]),
    );
    return fsp.readFile(raw);
  }

  for (const canvas of [
    { width: 640, height: 360 },
    { width: 360, height: 640 },
  ]) {
    it(`${canvas.width}x${canvas.height}: every caption is one line inside the frame`, async () => {
      if (!ffmpegAvailable) return;
      const { ctx, dir } = await project();
      await applyOp(ctx.store, "canvas", (tl) => {
        tl.canvas = { ...tl.canvas, ...canvas };
      });
      const tone = await srcTone(path.join(dir, "speech.wav"), { freq: 300, dur: 6 });
      const ref = await libRef(ctx, tone, "audio");
      const placed = (await addClipsTool(
        { entries: [{ media_ref: ref, timeline_in: 0 }] },
        ctx,
      )) as Rec;
      expect(placed.ok, JSON.stringify(placed)).toBe(true);
      const words = SPEECH.split(" ");
      await seedTranscript(
        ctx,
        ref,
        words.map((t, i) => [t, (i * 5.5) / words.length, ((i + 0.9) * 5.5) / words.length]),
      );
      const r = (await addCaptionsTool({ max_gap_seconds: 0 }, ctx)) as Rec;
      expect(r.ok, JSON.stringify(r)).toBe(true);

      const tl = await loadTimeline(ctx.store);
      const fps = Number(tl.canvas?.fps) || 30;
      const caps = tl.tracks
        .flatMap((t) => t.clips ?? [])
        .filter((c) => c.kind === "text")
        .sort((a, b) => Number(a.timeline_in) - Number(b.timeline_in));
      expect(caps.length, "the speech made more than one caption").toBeGreaterThan(1);
      const em = Math.round(canvas.height * 0.06); // the default caption size: 6% of the height
      const mp4 = await renderMp4(ctx, dir);
      for (const c of caps) {
        const mid = (Number(c.timeline_in) + Number(c.timeline_out)) / 2 / fps;
        const px = await frameLuma(mp4, mid);
        let [x0, x1, y0, y1] = [canvas.width, -1, canvas.height, -1];
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0; x < canvas.width; x++)
            if (px[y * canvas.width + x] > 128) {
              [x0, x1, y0, y1] = [
                Math.min(x0, x),
                Math.max(x1, x),
                Math.min(y0, y),
                Math.max(y1, y),
              ];
            }
        const what = `caption ${JSON.stringify(c.content)} at ${mid.toFixed(2)}s: ink x ${x0}..${x1}, y ${y0}..${y1}`;
        expect(x1, `${what}: nothing drawn`).toBeGreaterThan(x0);
        // One line: glyph ink spans about an em (ascenders to descenders); a second line adds a
        // whole line height on top.
        expect(y1 - y0, `${what}: taller than one line`).toBeLessThan(1.6 * em);
        // Inside the 5% title-safe margin on each side, give or take a pixel of antialiasing.
        expect(x0, what).toBeGreaterThanOrEqual(Math.floor(canvas.width * 0.05) - 2);
        expect(x1, what).toBeLessThanOrEqual(Math.ceil(canvas.width * 0.95) + 2);
      }
    }, 300_000);
  }
});

describe.skipIf(!process.env.VITEST)("subtitles, end to end in pixels", () => {
  const SRT =
    "1\n00:00:00,500 --> 00:00:01,500\nFirst caption.\n\n2\n00:00:04,000 --> 00:00:05,000\nSecond caption.\n";

  it("places an SRT's cues at their own timecodes, with a real gap between them", async () => {
    if (!ffmpegAvailable) return;
    const { ctx, dir } = await project();
    const srt = path.join(dir, "captions.srt");
    await fsp.writeFile(srt, SRT, "utf8");
    const ref = await libRef(ctx, srt, "subtitle");

    const r = (await addCaptionsTool({ subtitle_media_ref: ref }, ctx)) as Rec;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.count).toBe(2);

    const mp4 = await renderMp4(ctx, dir);
    const duringFirst = await inkAt(ctx, dir, mp4, 1.0);
    const inTheGap = await inkAt(ctx, dir, mp4, 2.75);
    const duringSecond = await inkAt(ctx, dir, mp4, 4.5);

    expect(duringFirst, "no caption at 1.0s").toBeGreaterThan(baselineInk + 0.001);
    expect(duringSecond, "no caption at 4.5s").toBeGreaterThan(baselineInk + 0.001);
    // The gap is what proves the TIMECODES were honoured rather than the text simply being on screen.
    expect(inTheGap, "caption still on screen during the authored gap").toBeLessThan(
      duringFirst / 2,
    );
  }, 300_000);

  it("groups the imported cues, and get_timeline collapses them to one row", async () => {
    if (!ffmpegAvailable) return;
    const { ctx, dir } = await project();
    const srt = path.join(dir, "captions.srt");
    await fsp.writeFile(srt, SRT, "utf8");
    const r = (await addCaptionsTool(
      { subtitle_media_ref: await libRef(ctx, srt, "subtitle") },
      ctx,
    )) as Rec;

    const shown = (await getTimelineTool({}, ctx)) as Rec;
    const tracks = (shown.timeline as { tracks: Array<{ kind: string; clips: Rec[] }> }).tracks;
    const textTrack = tracks.find((t) => t.kind === "text")!;
    expect(textTrack.clips).toHaveLength(1);
    expect(textTrack.clips[0].kind).toBe("caption_group");
    expect(textTrack.clips[0].caption_group).toBe(r.caption_group);
    expect(String(textTrack.clips[0].text)).toContain("First caption.");

    const detailed = (await getTimelineTool({ caption_detail: true }, ctx)) as Rec;
    const dTracks = (detailed.timeline as { tracks: Array<{ kind: string; clips: Rec[] }> }).tracks;
    expect(dTracks.find((t) => t.kind === "text")!.clips).toHaveLength(2);
    void dir;
  }, 300_000);

  it("restyles the whole imported group in one call, and the frame changes", async () => {
    if (!ffmpegAvailable) return;
    const { ctx, dir } = await project();
    const srt = path.join(dir, "captions.srt");
    await fsp.writeFile(srt, SRT, "utf8");
    const r = (await addCaptionsTool(
      { subtitle_media_ref: await libRef(ctx, srt, "subtitle") },
      ctx,
    )) as Rec;
    const before = await inkAt(ctx, dir, await renderMp4(ctx, dir), 1.0);

    const up = (await updateTextTool(
      { caption_group: r.caption_group as string, style: { preset: "boxed", size: "xl" } },
      ctx,
    )) as Rec;
    expect(up.ok, JSON.stringify(up)).toBe(true);
    expect(up.count).toBe(2);
    const after = await inkAt(ctx, dir, await renderMp4(ctx, dir), 1.0);
    expect(after, `group restyle did not reach the pixels (${before} -> ${after})`).toBeGreaterThan(
      before,
    );
  }, 300_000);

  it("refuses to place a subtitle as a clip, and the timeline stays clean", async () => {
    if (!ffmpegAvailable) return;
    const { ctx } = await project();
    const dir = dirs[dirs.length - 1];
    const srt = path.join(dir, "captions.srt");
    await fsp.writeFile(srt, SRT, "utf8");
    const ref = await libRef(ctx, srt, "subtitle");

    const r = (await addClipsTool(
      { entries: [{ media_ref: ref, timeline_in: 0, duration: 30 }] },
      ctx,
    )) as Rec;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/add_captions/);

    const tl = await loadTimeline(ctx.store);
    const textClips = tl.tracks.flatMap((t) => t.clips ?? []).filter((c) => c.kind === "text");
    expect(textClips).toHaveLength(0);
    void applyOp;
  }, 300_000);
});
