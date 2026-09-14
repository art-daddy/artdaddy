// Bundled-sidecar e2e — opt-in smoke lane (vitest.smoke.config.ts). Resolves the
// ACTUAL Tauri sidecar binaries staged at src-tauri/binaries/<name>-<host-triple>
// (what the packaged desktop app ships) — NOT the dev PATH copies — and proves
// they spawn on THIS OS and support exactly what render.ts emits (libx264 +
// yuv420p + aac + mp4). Guards the "works in CI, breaks in the signed build" class:
// a wrong host triple, a stripped build missing an encoder, or an unspawnable
// binary. Skips cleanly if the sidecars aren't staged yet (fresh clone, before
// `npm run setup:sidecars`).
//   npx vitest run --config vitest.smoke.config.ts src/tools/sidecar.e2e.ts
import { execSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nodeFs, nodeRunner } from "./__e2e";
import { joinPath } from "./store";

/** Host target-triple the way setup-sidecars.mjs stages them (rustc host, else a
 *  platform guess) — must match so we resolve the SAME file Tauri bundles. */
function hostTriple(): string {
  try {
    const m = execSync("rustc -vV", { encoding: "utf8" }).match(/host:\s*(\S+)/);
    if (m) return m[1];
  } catch {
    /* rustc missing -> platform guess below */
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

const EXT = process.platform === "win32" ? ".exe" : "";
const BIN = path.join(process.cwd(), "src-tauri", "binaries");
const triple = hostTriple();
const ffmpegBin = path.join(BIN, `ffmpeg-${triple}${EXT}`);
const ffprobeBin = path.join(BIN, `ffprobe-${triple}${EXT}`);
const ROOT = joinPath(os.tmpdir(), `artdaddy-sidecar-${Date.now()}`);
let STAGED = false;

beforeAll(async () => {
  STAGED = (await nodeFs.exists(ffmpegBin)) && (await nodeFs.exists(ffprobeBin));
  await nodeFs.mkdir(ROOT);
});
afterAll(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

describe("bundled ffmpeg sidecar (current OS)", () => {
  it("resolves + spawns the staged sidecar pair for this host triple", async () => {
    if (!STAGED) return;
    const r = await nodeRunner.run(ffmpegBin, ["-hide_banner", "-version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ffmpeg version/i);
    const p = await nodeRunner.run(ffprobeBin, ["-hide_banner", "-version"]);
    expect(p.code).toBe(0);
    expect(p.stdout).toMatch(/ffprobe version/i);
  }, 30_000);

  it("supports the encoders + muxer render.ts emits (libx264, aac, mp4)", async () => {
    if (!STAGED) return;
    const enc = await nodeRunner.run(ffmpegBin, ["-hide_banner", "-encoders"]);
    expect(enc.code).toBe(0);
    expect(enc.stdout).toMatch(/\blibx264\b/); // -c:v libx264
    expect(enc.stdout).toMatch(/\baac\b/); // -c:a aac
    const mux = await nodeRunner.run(ffmpegBin, ["-hide_banner", "-muxers"]);
    expect(mux.stdout).toMatch(/\bmp4\b/); // .mp4 output
  }, 30_000);

  it("renders an mp4 with render.ts's exact codec tail, read back by the sidecar ffprobe", async () => {
    if (!STAGED) return;
    // Synthesize a tiny A/V source THROUGH the sidecar (exercises decode + lavfi too).
    const src = joinPath(ROOT, "src.mp4");
    const gen = await nodeRunner.run(ffmpegBin, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:size=64x48:rate=30:duration=0.3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.3",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      src,
    ]);
    expect(gen.code).toBe(0);
    // The exact codec tail from buildRenderCommand: -c:v libx264 -pix_fmt yuv420p -r fps (-c:a aac).
    const out = joinPath(ROOT, "out.mp4");
    const r = await nodeRunner.run(ffmpegBin, [
      "-y",
      "-i",
      src,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-c:a",
      "aac",
      "-t",
      "0.3",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(await nodeFs.exists(out)).toBe(true);
    const probe = await nodeRunner.run(ffprobeBin, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      out,
    ]);
    expect(probe.code).toBe(0);
    expect(probe.stdout).toMatch(/h264/);
    expect(probe.stdout).toMatch(/aac/);
  }, 60_000);
});
