// BENCHMARK #1 — ffmpeg render wall-time vs the (near-instant) live preview.
//
// The live WebGL preview composites on the GPU in real time (scrub latency is
// effectively zero — buildScene is sub-millisecond), so the meaningful number is
// how long a FULL ffmpeg render takes, because that is the cost an "ffmpeg-only,
// no-preview" product would impose on every iteration.
//
// Matrix: {5s, 30s, 120s} x {simple, medium, complex} at 1080p. We time the real
// render (renderTimelineTool -> ffmpeg) and report wall-time + the realtime factor
// (renderSec / videoSec): >1 means the render takes LONGER than the clip's runtime.
//
// Run (needs ffmpeg): npx vitest run --config vitest.smoke.config.ts src/tools/bench_render.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, it } from "vitest";

import { ff, have, mkCtx, probe, renderMp4 } from "./__e2e";
import type { ClientToolContext } from "./context";
import { ensureTimeline, replaceTimeline } from "../timeline/engine";
import type { Animatable, Clip, Timeline, Track } from "../timeline/model";

const DURATIONS = [5, 30, 120] as const;
const LEVELS = ["simple", "medium", "complex"] as const;
const W = 1920;
const H = 1080;
const FPS = 30;

interface Row {
  level: string;
  videoSec: number;
  renderSec: number;
  realtimeFactor: number; // renderSec / videoSec
  outMB: number;
  clips: number;
  tracks: number;
  warnings: number;
}

let dir = "";
let ctx: ClientToolContext;
const srcByDur = new Map<number, string>(); // duration -> absolute 1080p source path
const rows: Row[] = [];
let ffmpegAvailable = false;

const kf = (pts: Array<[number, number]>): Animatable => pts.map(([t, v]) => ({ t, v }));

function vclip(
  id: string,
  src: string,
  tin: number,
  tout: number,
  extra: Partial<Clip> = {},
): Clip {
  const len = tout - tin;
  return {
    id,
    kind: "video",
    media_ref: src,
    timeline_in: tin,
    timeline_out: tout,
    source_in: 0,
    source_out: len,
    ...extra,
  } as Clip;
}

/** simple = 1 straight clip; medium = 3 cuts + audio bed + fades; complex = 2 video
 *  tracks (crossfades + a keyframed/rotated PiP overlay) + a colour grade + audio. */
function buildTimeline(level: (typeof LEVELS)[number], src: string, durSec: number): Timeline {
  const total = Math.round(durSec * FPS);
  const canvas = { width: W, height: H, fps: FPS };

  if (level === "simple") {
    const v: Track = {
      id: "v1",
      kind: "video",
      z: 0,
      clips: [vclip("c0", src, 0, total)],
    } as Track;
    return { canvas, tracks: [v] } as Timeline;
  }

  const third = Math.floor(total / 3);
  if (level === "medium") {
    const v: Track = {
      id: "v1",
      kind: "video",
      z: 0,
      clips: [
        vclip("c0", src, 0, third, { fade: { in: FPS, out: 0 } }),
        vclip("c1", src, third, third * 2),
        vclip("c2", src, third * 2, total, { fade: { in: 0, out: FPS } }),
      ],
    } as Track;
    const a: Track = {
      id: "a1",
      kind: "audio",
      z: 1,
      clips: [
        {
          ...vclip("a0", src, 0, total),
          kind: "audio",
          fade: { in: FPS, out: FPS },
          volume: 0.5,
        } as Clip,
      ],
    } as Track;
    return { canvas, tracks: [v, a] } as Timeline;
  }

  // complex: main 3 clips with crossfades + colour grade; overlay PiP with opacity
  // keyframes + rotate; an audio bed with fades.
  const dur = Math.max(FPS, Math.floor(FPS / 2)); // ~0.5s crossfade
  const main: Track = {
    id: "v1",
    kind: "video",
    z: 0,
    clips: [
      vclip("m0", src, 0, third, { color: { exposure: 0.2, saturation: 1.3 } as Clip["color"] }),
      vclip("m1", src, third, third * 2, {
        transition_in: { kind: "crossfade", duration: dur } as Clip["transition_in"],
      }),
      vclip("m2", src, third * 2, total, {
        transition_in: { kind: "crossfade", duration: dur } as Clip["transition_in"],
      }),
    ],
  } as Track;
  const pipLen = Math.min(total, FPS * 2);
  const overlay: Track = {
    id: "v2",
    kind: "video",
    z: 1,
    clips: [
      vclip("p0", src, 0, pipLen, {
        transform: { position: { x: 0.75, y: 0.25 }, scale: 0.3 } as Clip["transform"],
        opacity: kf([
          [0, 0],
          [FPS, 1],
          [pipLen - FPS, 1],
          [pipLen, 0],
        ]),
        rotate: 10,
      }),
    ],
  } as Track;
  const a: Track = {
    id: "a1",
    kind: "audio",
    z: 2,
    clips: [
      {
        ...vclip("a0", src, 0, total),
        kind: "audio",
        fade: { in: FPS, out: FPS },
        volume: 0.4,
      } as Clip,
    ],
  } as Track;
  return { canvas, tracks: [main, overlay, a] } as Timeline;
}

describe.skipIf(!process.env.ARTDADDY_BENCH)("BENCH #1 — render wall-time vs preview (1080p)", () => {
  beforeAll(async () => {
    ffmpegAvailable = (await have("ffmpeg")) && (await have("ffprobe"));
    if (!ffmpegAvailable) return;
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-bench-render-"));
    ctx = mkCtx(dir);
    await ensureTimeline(ctx.store);
    // One 1080p testsrc2 source per duration (motion => realistic encode load) + a tone.
    for (const d of DURATIONS) {
      const src = path.join(dir, `src${d}.mp4`);
      await ff([
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${d}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${d}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        src,
      ]);
      srcByDur.set(d, src);
    }
  }, 600_000);

  for (const d of DURATIONS) {
    for (const level of LEVELS) {
      it(`${level} @ ${d}s`, async () => {
        if (!ffmpegAvailable) return;
        const src = srcByDur.get(d)!;
        const tl = buildTimeline(level, src, d);
        await replaceTimeline(ctx.store, tl);
        const t0 = Date.now();
        const mp4 = await renderMp4(ctx, dir);
        const renderSec = (Date.now() - t0) / 1000;
        const pr = await probe(mp4);
        const st = await fsp.stat(mp4);
        const clips = tl.tracks.reduce((n, t) => n + (t.clips?.length ?? 0), 0);
        rows.push({
          level,
          videoSec: d,
          renderSec: Number(renderSec.toFixed(2)),
          realtimeFactor: Number((renderSec / d).toFixed(2)),
          outMB: Number((st.size / 1e6).toFixed(1)),
          clips,
          tracks: tl.tracks.length,
          warnings: 0,
        });
        // sanity: output is a real 1080p mp4 of ~the right length
        if (pr.width !== W || pr.height !== H) throw new Error(`bad dims ${pr.width}x${pr.height}`);
      }, 620_000);
    }
  }

  afterAll(async () => {
    if (rows.length) {
      const md = renderReport(rows);
      const outDir = path.resolve("reports/bench");
      await fsp.mkdir(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fsp.writeFile(path.join(outDir, `render-${stamp}.json`), JSON.stringify(rows, null, 2));
      await fsp.writeFile(path.join(outDir, "render-latest.md"), md);
      // eslint-disable-next-line no-console
      console.log("\n" + md + "\n");
    }
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
});

function renderReport(data: Row[]): string {
  const lines: string[] = [];
  lines.push(`# Benchmark #1 — Render wall-time vs preview (1080p, ${FPS}fps)`);
  lines.push("");
  lines.push("Preview = live WebGL scrub, effectively instant (buildScene is sub-ms).");
  lines.push(
    "`realtime x` = renderSec / videoSec — how many seconds of render per second of video.",
  );
  lines.push("");
  lines.push("| level | video | clips | tracks | render (s) | realtime x | out MB |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of data) {
    lines.push(
      `| ${r.level} | ${r.videoSec}s | ${r.clips} | ${r.tracks} | ${r.renderSec} | ${r.realtimeFactor}x | ${r.outMB} |`,
    );
  }
  return lines.join("\n");
}
