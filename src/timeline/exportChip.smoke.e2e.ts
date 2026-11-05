// AT-S4-1 with the real ffmpeg and this PC's real graphics chip (exporter document 19.7): the same project exported at Full
// quality and at Fast, through the real export door, must be the same VIDEO made two ways. Each file is read back, and the
// artifacts are compared (not the instructions that made them): size, length, frames and audio agree; Full carries x264's
// own signature in its bitstream and Fast does not (so the chip really did the encode); Fast's picture is the same picture.
// Skipped where no graphics encoder works.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/exportChip.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { chipEncodeArgs } from "./chipTest";
import { CHIP_PREFERENCE, type ChipMaker } from "./exportEncoder";
import { listExportRecords, whenExportEnds, whenExportsSettle } from "./exportQueue";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";

type Rec = Record<string, unknown>;

// The chip's lookup answers with whichever maker's encoder this PC really has (found below by encoding with it).
const state = vi.hoisted(() => ({ maker: null as ChipMaker | null }));
vi.mock("./chipTest", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chipTest")>();
  return {
    ...real,
    findChip: vi.fn(async (sizeClass: "hd" | "uhd") => ({
      chip: state.maker
        ? {
            maker: state.maker,
            adapter: { maker: state.maker, device: "smoke", driver: "0" },
            sizeClass,
            ok: true as const,
            result: "passed" as const,
            ssimMilli: 0,
            ms: 0,
          }
        : null,
      events: [],
    })),
  };
});

const ROOT = joinPath(os.tmpdir(), `artdaddy-chip-export-${Date.now()}`);
const FRAMES = 180; // three clips of two seconds at 30 fps

/** The first maker whose encoder runs on this PC, in the app's order of preference. */
async function workingMaker(): Promise<ChipMaker | null> {
  await fsp.mkdir(ROOT, { recursive: true });
  for (const maker of CHIP_PREFERENCE) {
    const out = joinPath(ROOT, `works-${maker}.mp4`);
    const r = await nodeRunner.run("ffmpeg", chipEncodeArgs(maker, "hd", out));
    await fsp.rm(out, { force: true });
    if (r.code === 0) return maker;
  }
  return null;
}
const MAKER = await workingMaker();
state.maker = MAKER;

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await whenExportsSettle();
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** A vertical project of three clips of one real source, and a context whose runner remembers every ffmpeg command. */
async function project(): Promise<{ ctx: ClientToolContext; commands: string[][] }> {
  const dir = joinPath(ROOT, "proj");
  await nodeFs.mkdir(dir);
  await openE2EDoc(dir);
  const base = mkCtx(dir);
  await ensureTimeline(base.store);
  expect(((await setCanvasTool({ width: 1080, height: 1920, fps: 30 }, base)) as Rec).ok).toBe(
    true,
  );
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

/** Whether x264's own signature (the SEI text it writes into every stream it encodes) is in the file. */
async function madeByX264(file: string): Promise<boolean> {
  return (await fsp.readFile(file)).includes("x264 - core");
}

describe.skipIf(MAKER === null)(
  "Fast and Full quality make the same video, with the real graphics chip",
  () => {
    it("delivers the same size, length, frames, audio and picture; the chip did the Fast encode and the processor the Full one", async () => {
      const { ctx, commands } = await project();
      const run = async (mode: "quality" | "fast", name: string) => {
        const before = commands.length;
        const started = Date.now();
        const res = (await exportTimelineTool({ name }, { ...ctx, exportMode: mode })) as Rec;
        expect(res.ok, JSON.stringify(res)).toBe(true);
        const ended = await whenExportEnds(String(res.job_id));
        expect(ended?.state, JSON.stringify(ended)).toBe("done");
        const seconds = (Date.now() - started) / 1000;
        const made = commands.slice(before).find((c) => c.includes("-progress"));
        expect(made, `no encode command seen for ${mode}`).toBeTruthy();
        const record = listExportRecords().find((r) => r.job_id === res.job_id);
        return { file: await ctx.store.exportPath(`${name}.mp4`), command: made!, seconds, record };
      };
      // Fast first: once the processor has measured this tiny project (1.6 s), the chip's predicted saving is under a quarter
      // and the app, rightly, no longer offers it (I-S4-8).
      const fast = await run("fast", "fast");
      const full = await run("quality", "full");
      // eslint-disable-next-line no-console
      console.log(
        `chip ${MAKER}: full ${full.seconds.toFixed(1)} s, fast ${fast.seconds.toFixed(1)} s`,
      );

      // The commands are what they say: the processor's own encode, exactly as before, and the chip's.
      const codec = (c: string[]) => c[c.lastIndexOf("-c:v") + 1];
      expect(codec(full.command)).toBe("libx264");
      expect(full.command).not.toContain("-preset");
      expect(codec(fast.command)).toBe(
        { amd: "h264_amf", nvidia: "h264_nvenc", intel: "h264_qsv" }[MAKER!],
      );
      expect(full.record?.encoder).toBeUndefined(); // the processor's normal setting needs no record
      expect(fast.record?.encoder).toBe(MAKER);

      // The artifacts: the same video.
      const a = await probe(full.file);
      const b = await probe(fast.file);
      expect({ w: b.width, h: b.height, audio: b.hasAudio }).toEqual({
        w: 1080,
        h: 1920,
        audio: true,
      });
      expect({ w: a.width, h: a.height, audio: a.hasAudio }).toEqual({
        w: 1080,
        h: 1920,
        audio: true,
      });
      expect(Math.abs(b.vDurationS - a.vDurationS)).toBeLessThan(0.05);
      expect(Math.abs(b.aDurationS - a.aDurationS)).toBeLessThan(0.1);
      expect(await frames(full.file)).toBe(FRAMES);
      expect(await frames(fast.file)).toBe(FRAMES);
      // Two ways of encoding one picture: not the same bytes, the same picture.
      expect(await psnr(fast.file, full.file)).toBeGreaterThan(32);
      const sizes = [(await fsp.stat(full.file)).size, (await fsp.stat(fast.file)).size];
      expect(sizes[0]).toBeGreaterThan(0);
      expect(sizes[1] / sizes[0]).toBeGreaterThan(0.4);
      expect(sizes[1] / sizes[0]).toBeLessThan(4);

      // The artifact says who encoded it: only the processor leaves x264's signature in the stream.
      expect(await madeByX264(full.file)).toBe(true);
      expect(await madeByX264(fast.file)).toBe(false);
    }, 600_000);
  },
);
