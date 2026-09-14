// Real-ffmpeg guards for the two defects that killed a production session (feedback
// d03ab792, project office_tour_video_1beef7, 2026-08-23):
//
//   1. `add_clips` on a still-GENERATING video created a linked AUDIO clip. The model landed
//      silent, so the graph carried `[N:a]` for a source with no audio stream and ffmpeg
//      rejected the WHOLE graph with EINVAL — every inspect_timeline and every export in that
//      project, not just the offending clip.
//   2. The agent tried to rescue it with `set_track a2 mute:true`. That did nothing, because
//      the render plan asked visibleTracks() for audio lanes too and never consulted
//      audibleTracks() — a muted lane was silent in the preview and still exported.
//
// Both were invisible to the unit suite, which asserts the filtergraph STRING: the string was
// exactly what the implementation intended to emit, and ffmpeg refused to run it. So these
// assert the ARTIFACT — ffmpeg's exit status and the audio actually present in the output.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { clearHasAudioCache } from "./placement";
import { buildRenderCommand, resolveClipSources } from "./render";
import type { ClientToolContext } from "../tools/context";

function bundled(stem: string): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const names =
    process.platform === "win32"
      ? [`${stem}-x86_64-pc-windows-msvc.exe`]
      : process.platform === "darwin"
        ? [`${stem}-aarch64-apple-darwin`, `${stem}-x86_64-apple-darwin`]
        : [`${stem}-x86_64-unknown-linux-gnu`];
  for (const n of names) {
    const p = path.join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}
const FF = bundled("ffmpeg");
const FP = bundled("ffprobe");

function run(
  program: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Just enough context for resolveClipSources: paths are already absolute, and the runner is a
 *  REAL ffprobe — a mocked one is what let this ship. `byteSize` mirrors the real store, because a
 *  fake that omits it silently turns the probe cache off and hides whatever it would have done. */
const ctx = (): ClientToolContext =>
  ({
    store: {
      resolveRef: async (s: string) => s,
      resolveMediaRef: async (s: string) => s,
      byteSize: async (p: string) => (await fsp.stat(p).catch(() => null))?.size ?? null,
    },
    runner: {
      run: (program: string, args: string[]) => run(program === "ffprobe" ? FP! : FF!, args),
    },
  }) as unknown as ClientToolContext;

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-astream-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});
beforeEach(() => clearHasAudioCache());

const CANVAS = { width: 320, height: 240, fps: 30 };

/** A video with NO audio stream — what an image-to-video model returns. */
async function silentVideo(cwd: string): Promise<string> {
  const p = path.join(cwd, "silent.mp4");
  const r = await run(FF!, [
    ...["-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=2"],
    ...["-pix_fmt", "yuv420p", p],
  ]);
  expect(r.code, `fixture failed: ${r.stderr.slice(-400)}`).toBe(0);
  const probe = await run(FP!, [
    ...["-v", "error", "-select_streams", "a", "-show_entries", "stream=index"],
    ...["-of", "csv=p=0", p],
  ]);
  expect(probe.stdout.trim(), "fixture must have NO audio stream").toBe("");
  return p;
}

/** A video that really does carry audio (a 440 Hz tone). */
async function noisyVideo(cwd: string): Promise<string> {
  const p = path.join(cwd, "noisy.mp4");
  const r = await run(FF!, [
    ...["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=30:d=2"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
    ...["-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p],
  ]);
  expect(r.code, `fixture failed: ${r.stderr.slice(-400)}`).toBe(0);
  return p;
}

/** Mean volume of the output in dBFS, or null when the file carries no audio stream at all.
 *  Reads the RENDERED FILE, so "the graph said volume=0" cannot pass for silence. */
async function meanVolumeDb(file: string): Promise<number | null> {
  const has = await run(FP!, [
    ...["-v", "error", "-select_streams", "a", "-show_entries", "stream=index"],
    ...["-of", "csv=p=0", file],
  ]);
  if (!has.stdout.trim()) return null;
  const r = await run(FF!, ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  return m ? Number(m[1]) : null;
}

/** `video` draws; `audio` is the LINKED audio clip add_clips creates beside it. */
function timeline(opts: { videoSrc: string; audioSrc: string; muted?: boolean }): Timeline {
  return {
    canvas: CANVAS,
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "clip_v",
            media_ref: opts.videoSrc,
            kind: "video",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
          },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        z: 0,
        ...(opts.muted ? { mute: true } : {}),
        clips: [
          {
            id: "aud_linked",
            media_ref: opts.audioSrc,
            kind: "audio",
            source_in: 0,
            source_out: 2,
            timeline_in: 0,
            timeline_out: 2,
          },
        ],
      },
    ],
  } as unknown as Timeline;
}

/** The production path: resolve (which is where the probe + disable lives), then build, then run. */
async function render(cwd: string, tl: Timeline, tag: string) {
  const out = path.join(cwd, `${tag}.mp4`);
  const warnings = await resolveClipSources(ctx(), tl);
  const plan = buildRenderCommand(tl, out);
  const r = await run(FF!, plan.args, cwd);
  return { out, code: r.code, stderr: r.stderr, warnings };
}

describe.skipIf(!FF || !FP)("audio streams that the graph promises but the media lacks", () => {
  it("renders a timeline whose audio clip points at a source with NO audio stream", async () => {
    const cwd = await scratch();
    const silent = await silentVideo(cwd);
    const tl = timeline({ videoSrc: silent, audioSrc: silent });

    const { out, code, stderr, warnings } = await render(cwd, tl, "guarded");

    // The whole point: ffmpeg RUNS. Before the guard this was EINVAL (-22) with
    // "Stream specifier ':a' ... matches no streams" and no output file at all.
    expect(code, `ffmpeg failed: ${stderr.slice(-800)}`).toBe(0);
    expect(existsSync(out), "no output file").toBe(true);
    expect(warnings.join(" ")).toMatch(/no audio stream/i);
    // Dropped from the MIX, not merely silenced: there is nothing to encode.
    expect(await meanVolumeDb(out)).toBeNull();
  });

  it("still renders the audio that IS there — the guard is positive-only", async () => {
    const cwd = await scratch();
    const noisy = await noisyVideo(cwd);
    const tl = timeline({ videoSrc: noisy, audioSrc: noisy });

    const { out, code, stderr, warnings } = await render(cwd, tl, "kept");

    expect(code, `ffmpeg failed: ${stderr.slice(-800)}`).toBe(0);
    expect(warnings, "a real audio stream must not be warned about").toEqual([]);
    const db = await meanVolumeDb(out);
    expect(db, "the tone was dropped").not.toBeNull();
    expect(db!).toBeGreaterThan(-50);
  });

  it("keeps the timeline's full duration when the silent clip is the longest thing on it", async () => {
    const cwd = await scratch();
    const silent = await silentVideo(cwd);
    const tl = timeline({ videoSrc: silent, audioSrc: silent });
    // Audio outlasts the picture: dropping the CLIP rather than disabling it would shorten
    // the export to 2s and silently truncate the user's video.
    const audioClip = tl.tracks?.[1]?.clips?.[0] as Record<string, unknown>;
    audioClip.timeline_out = 4;
    audioClip.source_out = 4;

    const { out, code } = await render(cwd, tl, "duration");
    expect(code).toBe(0);
    const r = await run(FP!, [
      ...["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
    ]);
    expect(Number(r.stdout.trim())).toBeGreaterThan(3.5);
  });
});

describe.skipIf(!FF || !FP)("a muted lane must not reach the export", () => {
  it("mute:true silences the track in the RENDERED FILE", async () => {
    const cwd = await scratch();
    const noisy = await noisyVideo(cwd);

    const heard = await render(cwd, timeline({ videoSrc: noisy, audioSrc: noisy }), "unmuted");
    const silenced = await render(
      cwd,
      timeline({ videoSrc: noisy, audioSrc: noisy, muted: true }),
      "muted",
    );

    expect(heard.code, heard.stderr.slice(-500)).toBe(0);
    expect(silenced.code, silenced.stderr.slice(-500)).toBe(0);

    // Differential: the SAME timeline, one flag apart. Survives codec/ffmpeg drift in a way an
    // absolute threshold would not.
    const loud = await meanVolumeDb(heard.out);
    expect(loud, "control produced no audio, so the test proves nothing").not.toBeNull();
    expect(await meanVolumeDb(silenced.out), "muted track was exported anyway").toBeNull();
  });
});

describe.skipIf(!FF || !FP)("preview render options", () => {
  // inspect_timeline samples a few frames by ABSOLUTE time, but encoded the whole timeline at
  // deliverable quality to get them. Both options are absent by default, so a real export is
  // untouched — the golden gate covers that side.
  it("maxDurationSec stops the FILE early, and the frames before it are unaffected", async () => {
    const cwd = await scratch();
    const noisy = await noisyVideo(cwd);
    const tl = timeline({ videoSrc: noisy, audioSrc: noisy });
    await resolveClipSources(ctx(), tl);

    const durationOf = async (file: string): Promise<number> => {
      const r = await run(FP!, [
        ...["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      ]);
      return Number(r.stdout.trim());
    };

    const full = path.join(cwd, "full.mp4");
    expect((await run(FF!, buildRenderCommand(tl, full).args, cwd)).code).toBe(0);

    const capped = path.join(cwd, "capped.mp4");
    const r = await run(
      FF!,
      buildRenderCommand(tl, capped, { preset: "ultrafast", maxDurationSec: 0.5 }).args,
      cwd,
    );
    expect(r.code, r.stderr.slice(-600)).toBe(0);

    expect(await durationOf(full)).toBeGreaterThan(1.5);
    expect(await durationOf(capped)).toBeLessThan(1);

    // The sampled frame must be the SAME picture, or the speed-up bought a wrong answer.
    const frameLuma = async (file: string): Promise<number> => {
      const out = `${file}.png`;
      await run(FF!, ["-y", "-hide_banner", "-ss", "0.25", "-i", file, "-frames:v", "1", out]);
      const s = await run(FF!, [
        ...["-hide_banner", "-i", out, "-vf", "signalstats,metadata=print", "-f", "null", "-"],
      ]);
      return Number(/lavfi\.signalstats\.YAVG=([\d.]+)/.exec(s.stderr)?.[1] ?? NaN);
    };
    expect(await frameLuma(capped)).toBeCloseTo(await frameLuma(full), 0);
  });
});
