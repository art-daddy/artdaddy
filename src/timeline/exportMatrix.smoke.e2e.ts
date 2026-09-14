// Every delivery preset COMBINATION, through the bundled ffmpeg, checked on the file it writes.
//
// exportPresets.smoke.e2e.ts covers one downscale (480p) and one frame-rate DROP (24). A user
// reported the export "not working" at max resolution and fps, which is the opposite direction on
// both axes and was never run. The table drives the behaviour, so walk the table: verifying the
// members that happen to be easy is evidence about those members only.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import type { ExportResolution } from "./exportOptions";
import { buildRenderCommand } from "./render";

function bundled(name: string): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const suffix =
    process.platform === "win32"
      ? "-x86_64-pc-windows-msvc.exe"
      : process.platform === "darwin"
        ? "-aarch64-apple-darwin"
        : "-x86_64-unknown-linux-gnu";
  const p = path.join(dir, `${name}${suffix}`);
  return existsSync(p) ? p : null;
}
const FF = bundled("ffmpeg");
const FP = bundled("ffprobe");

function run(program: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    child.on("close", (c) => resolve({ code: c ?? -1, out, err }));
  });
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-preset-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const DUR = 2;
const CANVAS = { width: 1080, height: 1920, fps: 30 }; // a vertical phone project, the reported shape

async function source(dir: string): Promise<string> {
  const src = path.join(dir, "src.mp4");
  const r = await run(FF!, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=s=1080x1920:r=30:d=${DUR}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${DUR}:sample_rate=48000`,
    "-shortest",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    src,
  ]);
  expect(r.code, r.err.slice(-300)).toBe(0);
  return src;
}

function timeline(src: string): Timeline {
  return {
    canvas: CANVAS,
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            kind: "video",
            media_ref: src,
            timeline_in: 0,
            timeline_out: DUR,
            source_in: 0,
            source_out: DUR,
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

/** What actually landed in the file: a plan that "looks right" is not an export that plays. */
async function probe(
  file: string,
): Promise<{ w: number; h: number; fps: number; frames: number; durS: number }> {
  const r = await run(FP!, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=width,height,r_frame_rate,nb_read_frames:format=duration",
    "-of",
    "default=nk=0:nw=1",
    file,
  ]);
  const get = (k: string): string => new RegExp(`^${k}=(.*)$`, "m").exec(r.out)?.[1]?.trim() ?? "";
  const [num, den] = get("r_frame_rate").split("/");
  return {
    w: Number(get("width")),
    h: Number(get("height")),
    fps: Math.round(Number(num) / Number(den || 1)),
    frames: Number(get("nb_read_frames")),
    durS: Number(get("duration")),
  };
}

const RESOLUTIONS: ExportResolution[] = ["source", "480p", "720p", "1080p", "1440p", "2160p"];
const RATES = [undefined, 24, 25, 30, 50, 60];

describe.runIf(FF && FP)("every resolution x frame-rate the dialog offers", () => {
  it.each(RESOLUTIONS.flatMap((res) => RATES.map((fps) => [res, fps] as const)))(
    "writes a playable file at %s / %s fps",
    async (resolution, fps) => {
      const dir = await scratch();
      const src = await source(dir);
      const out = path.join(dir, `${resolution}-${fps ?? "source"}.mp4`);

      const plan = buildRenderCommand(timeline(src), out, { resolution, fps, quality: "high" });
      const r = await run(FF!, plan.args);
      expect(r.code, `ffmpeg failed: ${r.err.slice(-500)}`).toBe(0);

      const got = await probe(out);
      const wantFps = fps ?? CANVAS.fps;
      expect(got.fps, "container frame rate").toBe(wantFps);
      // Both sides even, or no player will decode it.
      expect(got.w % 2, `odd width ${got.w}`).toBe(0);
      expect(got.h % 2, `odd height ${got.h}`).toBe(0);
      // 2160p on a 1080-wide project must NOT upscale ΓÇö it would invent detail and cost a fortune.
      const shrinks = ["480p", "720p", "1080p"].includes(String(resolution));
      if (!shrinks)
        expect(got.w, "must not upscale past the canvas").toBeLessThanOrEqual(CANVAS.width);
      // The thing the user actually noticed: a file with the right header and no pictures.
      expect(got.frames, "frames written").toBeGreaterThan(wantFps);
      expect(got.durS, "duration").toBeGreaterThan(DUR * 0.8);
      expect(got.durS, "duration").toBeLessThan(DUR * 1.5);
    },
    180_000,
  );
});

/** The real export door supplies branding, so a free-tier deliverable is main video + watermark
 *  + a CONCATENATED end card, ended by `-shortest` against a padded audio track. That path has
 *  the moving parts the plain one does not, and none of it had ever been run above 30fps. */
const BRAND = {
  watermark: path.resolve(process.cwd(), "src-tauri/resources/brand/watermark-9x16.png"),
  endcard: path.resolve(process.cwd(), "src-tauri/resources/brand/endcard-9x16.mp4"),
  endcardDuration: 2,
};

describe.runIf(FF && FP && existsSync(BRAND.endcard))("a BRANDED export with audio", () => {
  function withAudio(src: string): Timeline {
    const tl = timeline(src) as unknown as {
      tracks: Array<Record<string, unknown>>;
    };
    tl.tracks.push({
      id: "a1",
      kind: "audio",
      z: 1,
      clips: [
        {
          id: "aud",
          kind: "audio",
          media_ref: src,
          timeline_in: 0,
          timeline_out: DUR,
          source_in: 0,
          source_out: DUR,
        },
      ],
    });
    return tl as unknown as Timeline;
  }

  it.each([
    ["source", undefined],
    ["source", 60],
    ["2160p", 60],
    ["480p", 60],
    ["1080p", 24],
  ] as const)(
    "delivers at %s / %s fps, end card attached",
    async (resolution, fps) => {
      const dir = await scratch();
      const src = await source(dir);
      const out = path.join(dir, `brand-${resolution}-${fps ?? "src"}.mp4`);

      const plan = buildRenderCommand(withAudio(src), out, {
        resolution: resolution as ExportResolution,
        fps,
        quality: "high",
        branding: BRAND,
      });
      const r = await run(FF!, plan.args);
      expect(r.code, `ffmpeg failed: ${r.err.slice(-600)}`).toBe(0);

      const got = await probe(out);
      const wantFps = fps ?? CANVAS.fps;
      expect(got.fps).toBe(wantFps);
      expect(got.w % 2).toBe(0);
      expect(got.h % 2).toBe(0);
      // The card really is on the tail: the file must outrun the timeline by roughly its length.
      expect(got.durS, "end card missing from the tail").toBeGreaterThan(DUR + 1);
      // A container that reports a duration it cannot actually decode is the shape of "the file
      // does not work", so count the frames rather than trust the header.
      expect(got.frames, "frames written").toBeGreaterThan(wantFps);
      expect(got.frames / got.durS, "frames vs duration disagree").toBeGreaterThan(wantFps * 0.8);
    },
    180_000,
  );

  // The cases above probe only the VIDEO stream, so a branded export whose audio is silence
  // or the wrong length passes every one of them ΓÇö which is how "the app reported done and
  // the file was unusable" gets reported from the field. The branded path is where this can
  // bite: it is the one that appends a card and pads the audio to reach it.
  it("delivers audio that runs the whole file, and is not silence", async () => {
    const dir = await scratch();
    const src = await source(dir);
    const out = path.join(dir, "brand-audio.mp4");
    const plan = buildRenderCommand(withAudio(src), out, {
      resolution: "source" as ExportResolution,
      quality: "high",
      branding: BRAND,
    });
    const r = await run(FF!, plan.args);
    expect(r.code, `ffmpeg failed: ${r.err.slice(-600)}`).toBe(0);

    // ebur128 prints an `I:` line PER FRAME before its Summary. Reading the FIRST one gets an
    // opening frame ΓÇö -70 LUFS on any file, silent or not ΓÇö and would call every export
    // silent. Cost an hour of chasing a bug that was in this line.
    const integrated = (stderr: string): number => {
      const all = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
      return all.length ? Number(all[all.length - 1][1]) : NaN;
    };
    const loudnessOf = async (file: string): Promise<number> =>
      integrated(
        (await run(FF!, ["-hide_banner", "-nostats", "-i", file, "-filter_complex", "ebur128", "-f", "null", "-"])).err,
      );
    const durOf = async (file: string, stream: string): Promise<number> =>
      Number(
        (await run(FP!, ["-v", "error", "-select_streams", stream, "-show_entries", "stream=duration", "-of", "default=nk=1:nw=1", file])).out
          .trim()
          .split(/\r?\n/)[0],
      );

    // A fixture that was never audible would make the assertions below pass for the wrong
    // reason (or fail for one that isn't the exporter's).
    expect(await loudnessOf(src), "the test source itself has no audio").toBeGreaterThan(-60);

    const vDur = await durOf(out, "v:0");
    const aDur = await durOf(out, "a:0");
    expect(Math.abs(vDur - aDur), `audio ${aDur}s vs video ${vDur}s`).toBeLessThan(0.2);
    expect(await loudnessOf(out), "exported audio is digital silence").toBeGreaterThan(-60);
    // INT64_MAX timestamps out of the pad stage wreck the track while the file still looks
    // well-formed; ffmpeg only says so on stderr.
    expect(r.err, "muxer reported non-monotonic timestamps").not.toMatch(/Non-monotonic DTS/);
  }, 180_000);
});
