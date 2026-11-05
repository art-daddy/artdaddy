// I-S3-1 with the real ffmpeg: a gentler rung changes how the work is done, never what is made. The same
// project is exported at every rung through the real export door, each file is read back, and they must agree
// on size, length, frame count, audio and picture. The commands are read too, so a rung that changed nothing
// (the flag ignored, the cap lost on the way) cannot pass for one that worked.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/exportRungs.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClientToolContext } from "../tools/context";
import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  probe,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { ensureTimeline } from "./engine";
import { listExportRecords, whenExportEnds, whenExportsSettle } from "./exportQueue";
import type { Rung } from "./exportPlan";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-rungs-${Date.now()}`);
const FRAMES = 180; // three clips of two seconds at 30 fps

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await whenExportsSettle();
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** A project of three clips of one real source, and a context whose runner remembers every ffmpeg command. */
async function project(): Promise<{ ctx: ClientToolContext; commands: string[][] }> {
  const dir = joinPath(ROOT, "rungs");
  await nodeFs.mkdir(dir);
  await openE2EDoc(dir);
  const base = mkCtx(dir);
  await ensureTimeline(base.store);
  expect(((await setCanvasTool({ width: 640, height: 360, fps: 30 }, base)) as Rec).ok).toBe(true);
  const src = joinPath(dir, "src.mp4");
  await ff([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    src,
  ]); // prettier-ignore
  const ref = await libRef(base, src, "video");
  const placed = (await addClipsTool(
    {
      entries: [0, 1, 2].map((i) => ({
        media_ref: ref,
        timeline_in: i * 60,
        timeline_out: (i + 1) * 60,
      })),
    },
    base,
  )) as Rec;
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  const commands: string[][] = [];
  const ctx: ClientToolContext = {
    ...base,
    runner: {
      run: async (program, args, signal, cwd, onStdout) => {
        if (program === "ffmpeg") commands.push([...args]);
        return nodeRunner.run(program, args, signal, cwd, onStdout);
      },
    },
  };
  return { ctx, commands };
}

async function frames(file: string): Promise<number> {
  const r = await nodeRunner.run("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file,
  ]); // prettier-ignore
  return Number(r.stdout.trim());
}

/** Average PSNR of `a` against `b` in dB (Infinity when identical). */
async function psnr(a: string, b: string): Promise<number> {
  const r = await nodeRunner.run("ffmpeg", [
    "-v", "info", "-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-",
  ]); // prettier-ignore
  const m = /average:(\S+)/.exec(r.stderr);
  if (!m) throw new Error(`no PSNR in ffmpeg output: ${r.stderr.slice(-400)}`);
  return m[1] === "inf" ? Number.POSITIVE_INFINITY : Number(m[1]);
}

describe("every rung makes the same video", () => {
  it("delivers the same size, length, frames, audio and picture at the normal, gentle and gentlest rungs", async () => {
    const { ctx, commands } = await project();
    const files: string[] = [];
    const encodes: string[][] = [];
    for (const rung of [0, 1, 2] as Rung[]) {
      const before = commands.length;
      const res = (await exportTimelineTool(
        { name: `rung${rung}` },
        ctx,
        rung === 0 ? undefined : { from: 0, minRung: rung },
      )) as Rec;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const ended = await whenExportEnds(String(res.job_id));
      expect(ended?.state, JSON.stringify(ended)).toBe("done");
      expect(listExportRecords().find((r) => r.job_id === res.job_id)?.rung ?? 0).toBe(rung);
      files.push(await ctx.store.exportPath(`rung${rung}.mp4`));
      // The command that made the file: the one that writes the staged output, with its progress stream.
      const made = commands.slice(before).find((c) => c.includes("-progress"));
      expect(made, `no encode command seen at rung ${rung}`).toBeTruthy();
      encodes.push(made!);
    }

    const [normal, ...gentler] = files;
    const reference = await probe(normal);
    expect(reference.width).toBe(640);
    expect(reference.height).toBe(360);
    expect(reference.hasAudio).toBe(true);
    expect(await frames(normal)).toBe(FRAMES);
    const bytes = (await fsp.stat(normal)).size;
    expect(bytes).toBeGreaterThan(0);

    for (const file of gentler) {
      const got = await probe(file);
      expect({ w: got.width, h: got.height, audio: got.hasAudio }).toEqual({
        w: reference.width,
        h: reference.height,
        audio: true,
      });
      expect(Math.abs(got.vDurationS - reference.vDurationS)).toBeLessThan(0.05);
      expect(Math.abs(got.aDurationS - reference.aDurationS)).toBeLessThan(0.1);
      expect(await frames(file)).toBe(FRAMES);
      const size = (await fsp.stat(file)).size;
      expect(size / bytes).toBeGreaterThan(0.75);
      expect(size / bytes).toBeLessThan(1.33);
      // Not the same bytes (threads change how x264 splits its work) but the same picture.
      expect(await psnr(file, normal)).toBeGreaterThan(35);
    }

    // The rungs really were different commands, and the caps never exceed what a rung allows.
    const caps = encodes.map((c) =>
      c.flatMap((a, i) => (a === "-threads:v" ? [Number(c[i + 1])] : [])),
    );
    expect(encodes[1]).not.toEqual(encodes[0]);
    expect(encodes[2]).not.toEqual(encodes[1]);
    expect(Math.max(...caps[1])).toBeLessThanOrEqual(2);
    expect(Math.max(...caps[2])).toBeLessThanOrEqual(2);
    expect(Math.min(...caps[2])).toBe(1);
  }, 600_000);
});
