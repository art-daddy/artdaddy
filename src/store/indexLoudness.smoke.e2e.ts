// 4g, the whole path on the shipped ffmpeg: a look at a long file is not waited on, the project's
// indexer measures it in the background, and the next look returns that measurement; a file the
// indexer measured at import is answered by its first look. Transcription is stubbed: it is not the
// subject, and the indexer would otherwise run whisper on every file here.
// Run: npx vitest run --config vitest.smoke.config.ts src/store/indexLoudness.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { IndexCoordinator } from "./indexCoordinator";
import type { CommandRunner } from "../tools/command";
import { inspectMediaTool } from "../tools/inspect";
import { peekLoudness } from "../tools/loudness";
import { joinPath } from "../tools/store";
import { ff, libRef, mkCtx, nodeRunner } from "../tools/__e2e";

const { reportAppError } = vi.hoisted(() => ({ reportAppError: vi.fn() }));
vi.mock("../api/appEvents", async (orig) => ({ ...(await orig<object>()), reportAppError }));
vi.mock("../tools/transcribe", async (orig) => ({
  ...(await orig<object>()),
  ensureTranscript: async () => ({ parsed: { segments: [] }, existed: true }),
  peekTranscript: async () => ({ language: "en", duration_seconds: 0, segments: [], words: [] }),
}));

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const proj = joinPath(os.tmpdir(), `artdaddy-index-loudness-${Date.now()}`);
const ctx = mkCtx(proj);
let index: IndexCoordinator;

beforeAll(async () => {
  await fsp.mkdir(path.join(proj, "src"), { recursive: true });
  index = new IndexCoordinator(
    ctx.store,
    () => nodeRunner,
    () => undefined,
    () => undefined,
  );
});
afterAll(async () => {
  index.dispose();
  await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined);
});

/** `minutes` of a stereo 1 kHz sine peaking at `amp` (0.0707946 is -23 dBFS), as FLAC. */
async function tone(name: string, minutes: number, amp: number): Promise<string> {
  const out = path.join(proj, "src", name);
  const s = `${amp}*sin(2*PI*1000*t)`;
  await ff([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${s}|${s}:s=48000:d=${minutes * 60}`,
    "-c:a",
    "flac",
    out,
  ]);
  return out;
}

/** A runner for the LOOK that counts the loudness passes run in it; the indexer has its own. */
function counting(): { runner: CommandRunner; passes: () => number } {
  let n = 0;
  return {
    runner: {
      run(program, args, signal, cwd, onStdout) {
        if (args.some((a) => a.includes("ebur128"))) n++;
        return nodeRunner.run(program, args, signal, cwd, onStdout);
      },
    },
    passes: () => n,
  };
}

describe("loudness of a long file, through the project's indexer (4g)", () => {
  it("a first look is not waited on, and the next look returns the background measurement", async () => {
    const ref = await libRef(ctx, await tone("long.flac", 11, 0.0707946), "audio");
    const look = counting();
    const at = { ...ctx, runner: look.runner };
    const t0 = performance.now();
    const first = (await inspectMediaTool({ media_ref: ref }, at)) as Any;
    const firstMs = performance.now() - t0;
    expect(first.ok, JSON.stringify(first).slice(0, 400)).toBe(true);
    expect(first.loudness.status).toBe("in_progress");

    const second = (await inspectMediaTool({ media_ref: ref }, at)) as Any;
    expect(second.loudness.integrated_lufs).toBeCloseTo(-23, 0);
    expect(second.loudness.true_peak_dbtp).toBeCloseTo(-23, 0);
    expect(second.loudness.rms_dbfs).toBeCloseTo(-26, 0);

    const t1 = performance.now();
    const third = (await inspectMediaTool({ media_ref: ref }, at)) as Any;
    const thirdMs = performance.now() - t1;
    expect(third.loudness).toEqual(second.loudness);
    console.log(
      `[4g] 11 min: first look ${Math.round(firstMs)} ms, third ${Math.round(thirdMs)} ms`,
    ); // eslint-disable-line no-console
    expect(look.passes()).toBe(0); // every measurement was the indexer's
    expect(reportAppError).not.toHaveBeenCalled();
  });

  it("a file measured when it was imported is answered by its first look", async () => {
    const ref = await libRef(ctx, await tone("imported.flac", 11, 0.0354813), "audio"); // -29 dBFS
    const abs = (await ctx.store.resolveRef(ref))!;
    index.indexSource(abs);
    const t0 = performance.now();
    while (!(await peekLoudness(ctx, abs, null, null))) {
      expect(performance.now() - t0, "the import's measurement never landed").toBeLessThan(120_000);
      await new Promise((r) => setTimeout(r, 200));
    }
    const look = counting();
    const r = (await inspectMediaTool({ media_ref: ref }, { ...ctx, runner: look.runner })) as Any;
    expect(r.loudness.integrated_lufs).toBeCloseTo(-29, 0);
    expect(r.loudness.rms_dbfs).toBeCloseTo(-32, 0);
    expect(look.passes()).toBe(0);
  });
});
