// Phase 2 (UJ-012): inspect_media costs what it shows. Frames are seeked, never decoded from the
// start; each carries the coordinate grid and is measured (sharpness, noise) on its own pixels;
// loudness is read over the span looked at; `overview` is one storyboard of the span's scenes; and
// a long transcript is never waited on. These drive the real tool against the ffmpeg (and, where
// the model is installed, the whisper) the app ships, and check what comes back.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/inspectMedia.smoke.e2e.ts
import { spawnSync } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { inspectMediaTool } from "./inspect";
import { joinPath } from "./store";
import { runWhisper, whisperModelPath } from "./transcribe";
import { registerBackgroundTranscriber } from "./transcriptQueue";
import { decodeCountingRunner, ff, libRef, longFixture, mkCtx, nodeFs, nodeRunner } from "./__e2e";

// The grid's labels are drawn with the bundled font, as in the app.
vi.mock("@tauri-apps/api/path", async () => {
  const p = await import("node:path");
  return { resolveResource: async (r: string) => p.resolve(process.cwd(), "src-tauri", r) };
});

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const FPS = 30;
const GOP = 120;
/** Wall-clock CEILINGS. The tight guarantee is the work (frames ffmpeg decodes), which no other
 *  load can change; time is asserted only as a ceiling far below what the old paths cost (minutes)
 *  that still holds when the pre-push hook runs every e2e file at once. A 1.5x end-vs-start TIME
 *  ratio here failed that run on a correct build (one look took 3.2 s, another 0.8 s). */
const LOOK_CEILING_MS = 30_000;
// One level under the OS temp dir, so the data root (two levels up) is where the app's own e2e
// runs keep the whisper model.
const proj = joinPath(os.tmpdir(), `artdaddy-inspect-media-${Date.now()}`);
const ctx: ClientToolContext = mkCtx(proj);
const media = (name: string): string => path.join(proj, "src", name);

beforeAll(async () => {
  await fsp.mkdir(path.join(proj, "src"), { recursive: true });
});
afterAll(async () => {
  await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined);
});

async function jpegSize(file: string): Promise<{ jpeg: boolean; w: number; h: number }> {
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
  const s = (JSON.parse(r.stdout) as { streams: Array<{ width: number; height: number }> })
    .streams[0];
  return { jpeg: buf[0] === 0xff && buf[1] === 0xd8, w: s.width, h: s.height };
}

async function grey(file: string, w: number, h: number): Promise<Uint8Array> {
  const out = `${file}.gray.raw`;
  await ff([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    file,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    out,
  ]);
  return new Uint8Array(await fsp.readFile(out)).subarray(0, w * h);
}

describe("frames cost a seek each, wherever they are (UJ-012)", () => {
  let ref = "";
  beforeAll(async () => {
    ref = await libRef(ctx, await longFixture({ seconds: 14 * 60, fps: FPS, gop: GOP }), "video");
  }, 600_000);

  it("six frames over a 14-minute 1080p file take seconds, each a 512 px JPEG", async () => {
    const t0 = performance.now();
    const r = (await inspectMediaTool({ media_ref: ref }, ctx)) as Any;
    const ms = performance.now() - t0;
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    expect(r.frames).toHaveLength(6);
    expect(r.frames[5].t).toBeGreaterThan(14 * 60 - 140);
    for (const a of r._attachments as Array<{ path: string }>) {
      const f = await jpegSize(a.path);
      expect(f.jpeg).toBe(true);
      expect([f.w, f.h]).toEqual([512, 288]);
    }
    expect(typeof r.sharpness).toBe("number");
    console.log(`[inspect_media] 6 frames over 14 min: ${Math.round(ms)} ms`); // eslint-disable-line no-console
    expect(ms).toBeLessThan(LOOK_CEILING_MS);
  });

  it("decodes at most a GOP per frame, at the end of the file as at its start", async () => {
    const decoded: number[] = [];
    const r = (await inspectMediaTool(
      { media_ref: ref, start_seconds: 123.4, end_seconds: 14 * 60 - 3 },
      { ...ctx, runner: decodeCountingRunner(decoded) },
    )) as Any;
    expect(r.frames_attached).toBe(6);
    console.log(`[inspect_media] frames decoded per frame: ${decoded}`); // eslint-disable-line no-console
    expect(decoded).toHaveLength(6);
    for (const n of decoded) expect(n).toBeLessThanOrEqual(GOP + 30);

    // The same look at the first and the last 6 s of the file: the work is the seek's, not the
    // position's. The old way decoded everything before the frame.
    const look = async (start: number): Promise<{ frames: number[]; ms: number }> => {
      await fsp.rm(path.join(proj, "internals", "cache", "inspect"), {
        recursive: true,
        force: true,
      });
      const frames: number[] = [];
      const t0 = performance.now();
      const x = (await inspectMediaTool(
        { media_ref: ref, start_seconds: start, end_seconds: start + 6 },
        { ...ctx, runner: decodeCountingRunner(frames) },
      )) as Any;
      expect(x.frames_attached).toBe(6);
      return { frames, ms: performance.now() - t0 };
    };
    const atStart = await look(0);
    const atEnd = await look(14 * 60 - 6);
    console.log(
      `[inspect_media] start ${atStart.frames} (${Math.round(atStart.ms)} ms), end ${atEnd.frames} (${Math.round(atEnd.ms)} ms)`,
    ); // eslint-disable-line no-console
    for (const n of [...atStart.frames, ...atEnd.frames]) expect(n).toBeLessThanOrEqual(GOP + 30);
    const total = (a: number[]): number => a.reduce((s, n) => s + n, 0);
    expect(total(atEnd.frames)).toBeLessThanOrEqual(total(atStart.frames) + 6 * GOP);
    expect(atEnd.ms).toBeLessThan(LOOK_CEILING_MS);
  });
});

describe("the numbers come from the pictures", () => {
  it("blur lowers sharpness; grain raises noise", async () => {
    const make = async (name: string, vf: string): Promise<string> => {
      const out = media(name);
      await ff([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=1280x720:rate=${FPS}:duration=4`,
        ...(vf ? ["-vf", vf] : []),
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "12",
        out,
      ]);
      return libRef(ctx, out, "video");
    };
    const look = async (ref: string): Promise<Any> =>
      (await inspectMediaTool({ media_ref: ref, max_frames: 3 }, ctx)) as Any;
    const sharp = await look(await make("sharp.mp4", ""));
    const blurred = await look(await make("blurred.mp4", "gblur=sigma=4"));
    const grainy = await look(await make("grainy.mp4", "noise=alls=25:allf=t"));
    console.log(
      "[inspect_media] sharpness",
      sharp.sharpness,
      blurred.sharpness,
      "noise",
      sharp.noise_sigma,
      grainy.noise_sigma,
    ); // eslint-disable-line no-console
    expect(blurred.sharpness).toBeLessThan(sharp.sharpness / 3);
    expect(grainy.noise_sigma).toBeGreaterThan(sharp.noise_sigma + 1);
  });
});

describe("frames and stills carry the grid", () => {
  /** Mean of one pixel column over the middle of the frame. */
  const column = (px: Uint8Array, w: number, h: number, x: number): number => {
    let s = 0;
    for (let y = Math.round(h * 0.3); y < Math.round(h * 0.7); y++) s += px[y * w + x];
    return s / (Math.round(h * 0.7) - Math.round(h * 0.3));
  };
  const expectGrid = (px: Uint8Array, w: number, h: number): void => {
    const bg = column(px, w, h, Math.round(w * 0.525));
    const core = Math.max(...[-1, 0, 1].map((d) => column(px, w, h, Math.round(w * 0.5) + d)));
    const edge = Math.min(...[-2, -1, 1, 2].map((d) => column(px, w, h, Math.round(w * 0.5) + d)));
    expect(core, "no light core on the 0.5 line").toBeGreaterThan(bg + 35);
    expect(edge, "no dark stroke beside it").toBeLessThan(bg - 8);
    expect(Math.abs(column(px, w, h, Math.round(w * 0.525) + 3) - bg)).toBeLessThan(6);
  };

  it("on a video frame", async () => {
    const out = media("grey.mp4");
    await ff([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x808080:s=1280x720:r=30:d=2",
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    const r = (await inspectMediaTool(
      { media_ref: await libRef(ctx, out, "video"), max_frames: 1 },
      ctx,
    )) as Any;
    expect(r.coordinate_grid).toBe("0-1, origin top-left");
    const file = (r._attachments as Array<{ path: string }>)[0].path;
    expectGrid(await grey(file, 512, 288), 512, 288);
  });

  it("on a still", async () => {
    const out = media("grey.png");
    await ff([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x808080:s=800x600",
      "-frames:v",
      "1",
      out,
    ]);
    const r = (await inspectMediaTool({ media_ref: await libRef(ctx, out, "image") }, ctx)) as Any;
    expect(r.coordinate_grid).toBe("0-1, origin top-left");
    const file = (r._attachments as Array<{ path: string }>)[0].path;
    expect(await jpegSize(file)).toMatchObject({ jpeg: true, w: 512, h: 384 });
    expectGrid(await grey(file, 512, 384), 512, 384);
  });
});

describe("loudness", () => {
  it("reads the EBU calibration tone as -23 LUFS, and a clip at half volume 6 dB lower", async () => {
    const out = media("tone.mov");
    await ff([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=320x180:r=30:d=10",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.0707946*sin(2*PI*1000*t)|0.0707946*sin(2*PI*1000*t):s=48000:d=10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "pcm_s16le",
      "-shortest",
      out,
    ]);
    const ref = await libRef(ctx, out, "video");
    const r = (await inspectMediaTool({ media_ref: ref, max_frames: 1 }, ctx)) as Any;
    expect(r.loudness.integrated_lufs).toBeCloseTo(-23, 0);
    expect(r.loudness.true_peak_dbtp).toBeCloseTo(-23, 0);
    expect(r.loudness.rms_dbfs).toBeCloseTo(-26, 0);

    // The same file placed on a timeline at volume 0.5, its sound on the linked audio clip.
    const clip = {
      media_ref: ref,
      source_in: 0,
      source_out: 300,
      timeline_in: 0,
      timeline_out: 300,
      link_group: "L",
    };
    await nodeFs.writeTextFile(
      joinPath(proj, "internals", "timeline.json"),
      JSON.stringify({
        units: "frames",
        canvas: { width: 320, height: 180, fps: 30 },
        tracks: [
          { id: "v1", kind: "video", z: 0, clips: [{ id: "v", kind: "video", ...clip }] },
          {
            id: "a1",
            kind: "audio",
            z: 0,
            clips: [{ id: "a", kind: "audio", ...clip, volume: 0.5 }],
          },
        ],
        failures: [],
      }),
    );
    const c = (await inspectMediaTool({ clip_id: "v", max_frames: 1 }, ctx)) as Any;
    expect(c.loudness.clip_volume).toBe(0.5);
    expect(c.loudness.after_clip_volume.integrated_lufs).toBeCloseTo(-29, 0);
  });

  // Every chunk a sidecar writes became one message to the page, and the page's thread can only
  // queue so many: four 10-minute looks in parallel (~6,000 per-frame log lines each) overflowed
  // it, the runs' exits were lost and the app's IPC stopped answering (2026-10-07). What the pass
  // hands back must stay a few KB however long the span is, with the figures unchanged.
  it("a 10-minute span hands back a few KB of output, not a log line per 100 ms", async () => {
    // 601 s: just over the inline transcript limit, so the look queues the transcript instead
    // of running whisper on a tone, and the only sidecar doing real work is the loudness pass.
    const out = media("tone10min.flac");
    await ff([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.0707946*sin(2*PI*1000*t)|0.0707946*sin(2*PI*1000*t):s=48000:d=601",
      "-c:a",
      "flac",
      out,
    ]);
    const ref = await libRef(ctx, out, "audio");
    const stderrBytes: number[] = [];
    const watching: CommandRunner = {
      async run(program, args, signal, cwd, onStdout) {
        const r = await nodeRunner.run(program, args, signal, cwd, onStdout);
        if (args.some((a) => a.includes("ebur128"))) stderrBytes.push(r.stderr.length);
        return r;
      },
    };
    const r = (await inspectMediaTool({ media_ref: ref }, { ...ctx, runner: watching })) as Any;
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    expect(stderrBytes).toHaveLength(1);
    expect(stderrBytes[0]).toBeLessThan(16 * 1024);
    expect(r.loudness.integrated_lufs).toBeCloseTo(-23, 0);
    expect(r.loudness.true_peak_dbtp).toBeCloseTo(-23, 0);
    expect(r.loudness.rms_dbfs).toBeCloseTo(-26, 0);
  });
});

describe("overview: one storyboard of the span's scenes", () => {
  /** 28 scenes of 30 s, each a flat colour of its own brightness: 14 minutes of 1080p. */
  async function scenes(): Promise<string> {
    const out = path.join(
      os.tmpdir(),
      "artdaddy-e2e-fixtures",
      `scenes28x30_1080p${FPS}_g${GOP}.mp4`,
    );
    if (existsSync(out)) return out;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const inputs: string[] = [];
    for (let i = 0; i < 28; i++) {
      const y = ((i * 37) % 220) + 16;
      const hex = y.toString(16).padStart(2, "0");
      inputs.push("-f", "lavfi", "-i", `color=c=0x${hex}${hex}${hex}:s=1920x1080:r=${FPS}:d=30`);
    }
    const tmp = `${out}.part.mp4`;
    await ff([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      `${Array.from({ length: 28 }, (_, i) => `[${i}:v]`).join("")}concat=n=28:v=1:a=0`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      String(GOP),
      "-pix_fmt",
      "yuv420p",
      tmp,
    ]);
    await fsp.rename(tmp, out);
    return out;
  }

  it("shows every scene of a 14-minute 1080p file exactly once, in a few seconds", async () => {
    const ref = await libRef(ctx, await scenes(), "video");
    const decoded: number[] = [];
    const t0 = performance.now();
    const r = (await inspectMediaTool(
      { media_ref: ref, overview: true },
      { ...ctx, runner: decodeCountingRunner(decoded) },
    )) as Any;
    const ms = performance.now() - t0;
    expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
    const times = r.overview.tile_times as number[];
    const total = decoded.reduce((s, n) => s + n, 0);
    console.log(
      `[inspect_media] overview of 14 min: ${Math.round(ms)} ms, ${times.length} tiles, ${total} frames decoded in ${decoded.length} processes`,
    ); // eslint-disable-line no-console
    expect(times).toHaveLength(28);
    expect(new Set(times.map((t) => Math.floor(t / 30))).size).toBe(28); // one tile per scene
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    const sheet = await jpegSize((r._attachments as Array<{ path: string }>)[0].path);
    expect(sheet).toMatchObject({ jpeg: true, w: 6 * 160, h: 5 * 90 }); // 28 tiles: 6 columns, 5 rows
    expect(r.frames).toBeUndefined();
    // The work: a keyframe per candidate, not the file (25,200 frames) — a pass over the whole file
    // took 33.8 s on the 80-minute recording, the seeks ~3-4 s.
    expect(total).toBeLessThan((14 * 60 * FPS) / 20);
    expect(ms).toBeLessThan(LOOK_CEILING_MS);
  });

  it("keeps a portrait source's shape", async () => {
    const out = media("portrait.mp4");
    await ff([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x303030:s=1080x1920:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xd0d0d0:s=1080x1920:r=30:d=4",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0",
      "-g",
      "30",
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    const r = (await inspectMediaTool(
      { media_ref: await libRef(ctx, out, "video"), overview: true },
      ctx,
    )) as Any;
    expect(r.overview.tile_times).toHaveLength(2);
    const sheet = await jpegSize((r._attachments as Array<{ path: string }>)[0].path);
    expect(sheet).toMatchObject({ w: 2 * 90, h: 160 }); // 90x160 tiles, not 160x90 stretched
  });
});

describe("transcript: never waited on when long", () => {
  /** The words, synthesised with Windows' own TTS; null where there is none. */
  function speechWav(): string | null {
    if (process.platform !== "win32") return null;
    const out = path.join(proj, "src", "speech.wav");
    const ps = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}')`,
      "$s.Speak('The quick brown fox jumps over the lazy dog. This sentence is spoken at six minutes.')",
      "$s.Dispose()",
    ].join("; ");
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true });
    return r.status === 0 && existsSync(out) ? out : null;
  }

  /** 12 minutes of sound with speech at 6:00 (silence otherwise, or a tone without TTS). 48 kHz on
   *  purpose: the shipped ffmpeg's AAC encoder stalls forever on 16 kHz audio that follows a few
   *  seconds of digital silence (measured 2026-10-03; see the doc), which is what this was at
   *  first. Finite inputs, so nothing here can run on. */
  async function longTalk(): Promise<{ file: string; speech: boolean }> {
    const speech = speechWav();
    const out = media("talk.m4a");
    const silence = ["-f", "lavfi", "-t", "360", "-i", "anullsrc=r=48000:cl=stereo"];
    const mid = speech
      ? ["-i", speech]
      : ["-f", "lavfi", "-t", "5", "-i", "sine=frequency=440:sample_rate=48000"];
    await ff([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...silence,
      ...mid,
      ...silence,
      "-filter_complex",
      "[1:a]aresample=48000,aformat=channel_layouts=stereo[b];[0:a][b][2:a]concat=n=3:v=0:a=1",
      "-c:a",
      "aac",
      out,
    ]);
    return { file: out, speech: speech !== null };
  }

  it("a whole 12-minute file returns at once with the transcript queued in the background", async () => {
    const { file } = await longTalk();
    const ref = await libRef(ctx, file, "audio");
    const queued: Array<[string, string]> = [];
    const unregister = registerBackgroundTranscriber(proj, {
      prioritize: (s, l) => (queued.push([s, l]), true),
    });
    let whisperRuns = 0;
    const counting: CommandRunner = {
      run(program, args, signal, cwd, onStdout) {
        if (program === "whisper-cli") whisperRuns++;
        return nodeRunner.run(program, args, signal, cwd, onStdout);
      },
    };
    try {
      const t0 = performance.now();
      const r = (await inspectMediaTool({ media_ref: ref }, { ...ctx, runner: counting })) as Any;
      const ms = performance.now() - t0;
      expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
      expect(r.transcript.status).toBe("in_progress");
      expect(whisperRuns).toBe(0);
      expect(queued).toHaveLength(1);
      expect(queued[0][0].replace(/\\/g, "/")).toBe(file.replace(/\\/g, "/"));
      expect(r.loudness.integrated_lufs).not.toBeNull(); // the sound is still measured
      // Never waited on: whisper did not run (above), so the time is the loudness pass's. 12
      // minutes inline would take minutes; the ceiling is far under that and survives a busy run.
      expect(ms).toBeLessThan(LOOK_CEILING_MS);
    } finally {
      unregister();
    }
  });

  const model = whisperModelPath(proj, "small");
  it.skipIf(!existsSync(model))(
    "a window of it is transcribed now, from that window's audio only, on the file's timeline",
    async () => {
      const { file, speech } = await longTalk();
      const ref = await libRef(ctx, file, "audio");
      const wavSeconds: number[] = [];
      const watching: CommandRunner = {
        async run(program, args, signal, cwd, onStdout) {
          if (program === "whisper-cli") {
            const wav = args[args.indexOf("-f") + 1];
            // The same ffprobe the tool runs (any platform), not a hard-coded Windows binary.
            const p = await nodeRunner.run("ffprobe", [
              "-v",
              "error",
              "-show_entries",
              "format=duration",
              "-of",
              "csv=p=0",
              wav,
            ]);
            wavSeconds.push(Number(p.stdout.trim()));
          }
          return nodeRunner.run(program, args, signal, cwd, onStdout);
        },
      };
      const r = (await inspectMediaTool(
        { media_ref: ref, start_seconds: 355, end_seconds: 380, word_timestamps: true },
        { ...ctx, runner: watching },
      )) as Any;
      expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
      expect(wavSeconds).toHaveLength(1);
      expect(wavSeconds[0]).toBeGreaterThan(24);
      expect(wavSeconds[0]).toBeLessThan(26); // the window, not 12 minutes
      if (speech) {
        const words = (r.transcript.words as Array<[string, number, number]>) ?? [];
        console.log("[inspect_media] window words:", words.slice(0, 8)); // eslint-disable-line no-console
        expect(words.length).toBeGreaterThan(3);
        // Spoken at 6:00 of the FILE: the times are on the file's timeline, not the window's.
        for (const [, s] of words) expect(s).toBeGreaterThanOrEqual(355);
        expect(words.map((w) => w[0].toLowerCase()).join(" ")).toMatch(/fox|dog|quick/);
      }
    },
    600_000,
  );

  // Found in QA (2026-10-03): whisper loads the whole file it is handed, so a window read through
  // `-ot/-d` from an 80-minute extract cost 11.9 s against 7.3 s for the window's own WAV. With the
  // whole-file extract on disk, the window is now CUT from it, and must still land on the file's
  // timeline.
  it.skipIf(!existsSync(model))(
    "a window is cut from the whole file's extract when one is on disk, on the file's timeline",
    async () => {
      const { file, speech } = await longTalk();
      const ref = await libRef(ctx, file, "audio");
      // A whole-file run that extracted the audio and was then stopped leaves the extract behind.
      let stopFirstWhisper = true;
      const ffInputs: string[] = [];
      const whisperInputs: string[] = [];
      const runner: CommandRunner = {
        run(program, args, signal, cwd, onStdout) {
          if (program === "ffmpeg") ffInputs.push(args[args.indexOf("-i") + 1]);
          if (program === "whisper-cli") {
            whisperInputs.push(args[args.indexOf("-f") + 1]);
            if (stopFirstWhisper) {
              stopFirstWhisper = false;
              return Promise.resolve({ code: 1, stdout: "", stderr: "stopped" });
            }
          }
          return nodeRunner.run(program, args, signal, cwd, onStdout);
        },
      };
      // As the app names it: the store's path for the ref, which every cache key is built from.
      const src = (await ctx.store.resolveRef(ref))!;
      await expect(runWhisper({ ...ctx, runner }, src)).rejects.toThrow(/whisper-cli failed/);
      const extract = whisperInputs[0];
      expect(existsSync(extract)).toBe(true);
      ffInputs.length = 0;
      const r = (await inspectMediaTool(
        { media_ref: ref, start_seconds: 350, end_seconds: 375, word_timestamps: true },
        { ...ctx, runner },
      )) as Any;
      expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
      // The window's audio came out of the extract, not the source, and whisper read only that.
      expect(
        ffInputs.map((p) => p.replace(/\\/g, "/")),
        JSON.stringify({ ffInputs, extract, whisperInputs }),
      ).toContain(extract.replace(/\\/g, "/"));
      expect(whisperInputs.at(-1)).not.toBe(extract);
      if (speech) {
        const words = (r.transcript.words as Array<[string, number, number]>) ?? [];
        expect(words.length).toBeGreaterThan(3);
        for (const [, s] of words) expect(s).toBeGreaterThanOrEqual(350);
        expect(words[0][1]).toBeGreaterThan(359.5); // spoken at 6:00 of the FILE
        expect(words.map((w) => w[0].toLowerCase()).join(" ")).toMatch(/fox|dog|quick/);
      }
    },
    600_000,
  );
});
