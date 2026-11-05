// The graphics-chip test against the real ffmpeg and this PC's real chips (exporter document 19.7, AT-S4-3 and AT-S4-4).
// The unit tests script ffmpeg's answers; this one asks the real thing, so a wrong reading of its report, a missing
// encoder or a leftover file cannot hide behind a script.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/chipTest.smoke.e2e.ts
// On a PC whose chip is expected to pass: ARTDADDY_SMOKE_EXPECT_CHIP=amd (or nvidia, intel).
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { __setExportFlag } from "../api/exportFlags";
import type { GraphicsAdapter, ProbeOutcome } from "../platform/host";
import { ff, nodeRunner } from "../tools/__e2e";
import { joinPath } from "../tools/store";
import {
  SSIM_FLOOR,
  TEST_FRAMES,
  __resetChipTests,
  chipEncodeArgs,
  chipTestSource,
  findChip,
  readSsim,
  referenceEncodeArgs,
  ssimArgs,
  type ChipDeps,
} from "./chipTest";
import { CHIP_MAKERS, type ChipMaker, type SizeClass } from "./exportEncoder";

const ROOT = joinPath(os.tmpdir(), `artdaddy-chip-${Date.now()}`);
const EXPECTED = process.env.ARTDADDY_SMOKE_EXPECT_CHIP;

beforeAll(async () => {
  await fsp.mkdir(ROOT, { recursive: true });
  for (const flag of ["chip_amd", "chip_nvidia", "chip_intel"] as const)
    __setExportFlag(flag, true);
});
afterAll(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

async function realProbe(
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<ProbeOutcome> {
  const started = Date.now();
  const timer = new AbortController();
  const handle = setTimeout(() => timer.abort(), options.timeoutMs);
  try {
    const result = await nodeRunner.run("ffmpeg", [...args], timer.signal);
    if (timer.signal.aborted) return { kind: "timeout" };
    return {
      kind: "ran",
      code: result.code ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(handle);
  }
}

/** The chip's test with the real ffmpeg and the real file system, for one maker the PC "reports". */
function realDeps(maker: ChipMaker): { deps: ChipDeps; dir: string } {
  const dir = joinPath(ROOT, `test-${maker}-${Math.random().toString(36).slice(2)}`);
  const memory = new Map<string, string>();
  const adapter: GraphicsAdapter = { maker, device: "0000", driver: "0.0" };
  return {
    dir,
    deps: {
      adapters: async () => [adapter],
      probe: realProbe,
      files: {
        dir: async () => dir,
        mkdir: async (path) => void (await fsp.mkdir(path, { recursive: true })),
        remove: async (path) => fsp.rm(path, { force: true }),
      },
      storage: {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => void memory.set(key, value),
      },
      now: () => Date.now(),
      release: "artdaddy@smoke",
    },
  };
}

describe("reading the real compare report", () => {
  it("finds thirty frames and a score for a sound encode of the test clip, as the verdict needs", async () => {
    const good = joinPath(ROOT, "good.mp4");
    await ff(referenceEncodeArgs("hd", good));
    const compared = await nodeRunner.run("ffmpeg", ssimArgs(good, "hd"));
    expect(compared.code, compared.stderr.slice(-400)).toBe(0);
    const seen = readSsim(compared.stderr);
    expect(seen.frames).toBe(TEST_FRAMES);
    expect(seen.ssim).not.toBeNull();
    expect(seen.ssim!).toBeGreaterThan(SSIM_FLOOR);
    expect(seen.ssim!).toBeLessThanOrEqual(1);
  });

  it("scores a black file, and a file one frame short, so that the verdict refuses them", async () => {
    const black = joinPath(ROOT, "black.mp4");
    await ff([
      "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", black,
    ]); // prettier-ignore
    const blackSeen = readSsim((await nodeRunner.run("ffmpeg", ssimArgs(black, "hd"))).stderr);
    expect(blackSeen.ssim).not.toBeNull();
    expect(blackSeen.ssim!).toBeLessThan(SSIM_FLOOR);

    const short = joinPath(ROOT, "short.mp4");
    await ff([
      "-y", "-v", "error", "-f", "lavfi", "-i", chipTestSource("hd"), "-frames:v", String(TEST_FRAMES - 1),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", short,
    ]); // prettier-ignore
    const shortSeen = readSsim((await nodeRunner.run("ffmpeg", ssimArgs(short, "hd"))).stderr);
    expect(shortSeen.frames).toBe(TEST_FRAMES - 1);

    // The other direction: one frame too many is also a wrong length. (The old form of the compare reported the
    // source's own count for a short file, so a chip that dropped a frame passed.)
    const long = joinPath(ROOT, "long.mp4");
    await ff([
      "-y", "-v", "error", "-f", "lavfi", "-i", chipTestSource("hd", TEST_FRAMES * 2), "-frames:v", String(TEST_FRAMES + 1),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", long,
    ]); // prettier-ignore
    const longSeen = readSsim((await nodeRunner.run("ffmpeg", ssimArgs(long, "hd"))).stderr);
    expect(longSeen.frames).toBe(TEST_FRAMES + 1);
  });

  it("reads nothing from a file ffmpeg cannot open", async () => {
    const compared = await nodeRunner.run("ffmpeg", ssimArgs(joinPath(ROOT, "missing.mp4"), "hd"));
    expect(compared.code).not.toBe(0);
    expect(readSsim(compared.stderr).ssim).toBeNull();
  });
});

describe("each maker's chip, on this PC", () => {
  for (const maker of CHIP_MAKERS) {
    for (const sizeClass of ["hd", "uhd"] as SizeClass[]) {
      it(`${maker} at ${sizeClass}: the verdict follows what the chip really does, quickly, and leaves no file`, async () => {
        // Ground truth: the encoder's own command, run directly.
        const direct = await nodeRunner.run(
          "ffmpeg",
          chipEncodeArgs(maker, sizeClass, joinPath(ROOT, `${maker}-${sizeClass}-direct.mp4`)),
        );
        const works = direct.code === 0;
        __resetChipTests();
        const { deps, dir } = realDeps(maker);
        const started = Date.now();
        const found = await findChip(sizeClass, { allowRun: true }, deps);
        const seconds = (Date.now() - started) / 1000;
        const results = found.events.map((event) => event.result);

        if (!works) {
          // A chip this PC does not have says so in seconds, is never offered, and nothing is left behind.
          expect(found.chip, JSON.stringify(found.events)).toBeNull();
          expect(seconds).toBeLessThan(30);
          expect(results.length).toBeGreaterThan(0);
          expect(
            results.every((result) => result === "no_device" || result === "encode_failed"),
          ).toBe(true);
        } else {
          // A chip that encodes is judged on its picture: never refused as missing, broken or too slow.
          for (const result of results)
            expect(["no_device", "encode_failed", "timed_out"]).not.toContain(result);
          if (EXPECTED === maker) {
            expect(found.chip, JSON.stringify(found.events)).not.toBeNull();
            expect(found.chip!.maker).toBe(maker);
            expect(found.chip!.sizeClass).toBe(sizeClass);
            expect(found.chip!.ssimMilli).toBeGreaterThan(Math.round(SSIM_FLOOR * 1000));
          }
        }
        expect(await fsp.readdir(dir).catch(() => [] as string[])).toEqual([]);
      });
    }
  }
});
