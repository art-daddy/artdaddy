// The poster IS the thumbnail, so the only thing worth asserting is its PIXELS.
//
// Frame 0 was the poster for every asset, and a film that opens on black therefore got a black
// tile — indistinguishable from a broken thumbnail, and invisible to the unit suite because a
// string assertion on the ffmpeg args cannot tell "extracted a frame" from "extracted black".
// This runs the real bundled ffmpeg over a clip with a black intro and reads the luma back.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

function bundled(tool: "ffmpeg"): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const triples =
    process.platform === "win32"
      ? ["x86_64-pc-windows-msvc.exe"]
      : process.platform === "darwin"
        ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
        : ["x86_64-unknown-linux-gnu"];
  for (const t of triples) {
    const p = path.join(dir, `${tool}-${t}`);
    if (existsSync(p)) return p;
  }
  return null;
}

const FF = bundled("ffmpeg");

function run(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(FF as string, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += String(d)));
    p.stderr.on("data", (d) => (stderr += String(d)));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const dir = mkdtempSync(path.join(os.tmpdir(), "poster-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Mean luma of a still, via ffmpeg's signalstats. 0 = pure black.
 *  Throws rather than returning a sentinel: a sentinel compares as "dark" and would let a
 *  parse failure pass the black-frame assertion. */
async function meanLuma(file: string): Promise<number> {
  // `metadata=print` writes at INFO level, so `-v error` would hide the very line we parse.
  const r = await run([
    "-i",
    file,
    "-vf",
    "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f",
    "null",
    "-",
  ]);
  const m = /YAVG=([\d.]+)/.exec(`${r.stdout}${r.stderr}`);
  if (!m) throw new Error(`could not read luma from ${file}: ${r.stderr.slice(-400)}`);
  return Number(m[1]);
}

const SKIP_BLACK =
  "scale=-2:360,blackframe=amount=0," +
  "metadata=select:key=lavfi.blackframe.pblack:value=90:function=less,thumbnail=n=40";

/** The poster recipe mediaProxy uses, both attempts, against `src`. */
async function makePoster(src: string, out: string, seek: number): Promise<boolean> {
  const args = (vf: string): string[] => [
    "-v",
    "error",
    "-y",
    ...(seek > 0 ? ["-ss", seek.toFixed(2)] : []),
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    vf,
    "-q:v",
    "4",
    out,
  ];
  if ((await run(args(SKIP_BLACK))).code === 0 && existsSync(out)) return true;
  return (await run(args("scale=-2:360"))).code === 0 && existsSync(out);
}

async function synth(name: string, filters: string[]): Promise<string> {
  const src = path.join(dir, name);
  const inputs = filters.flatMap((f) => ["-f", "lavfi", "-i", f]);
  const concat =
    filters.length > 1
      ? [
          "-filter_complex",
          `${filters.map((_, i) => `[${i}]`).join("")}concat=n=${filters.length}:v=1:a=0`,
        ]
      : [];
  const r = await run([
    "-v",
    "error",
    "-y",
    ...inputs,
    ...concat,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    src,
  ]);
  expect(r.code, r.stderr).toBe(0);
  return src;
}

describe.skipIf(!FF)("the generated poster", () => {
  it("carries picture, not the black the film opens on", async () => {
    // 3s of black then 7s of orange — the shape that produced a black tile.
    const src = await synth("black-intro.mp4", [
      "color=c=black:s=320x180:d=3,format=yuv420p",
      "color=c=orange:s=320x180:d=7,format=yuv420p",
    ]);

    // Frame 0 — what shipped before. Proves the fixture really opens black, so the
    // assertion below cannot pass by accident.
    const frame0 = path.join(dir, "frame0.jpg");
    await run(["-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", "scale=-2:360", frame0]);
    expect(await meanLuma(frame0), "fixture must open on black").toBeLessThan(8);

    // 10% of a 10s clip is 1s — still inside the black intro, which is exactly why the
    // recipe cannot rely on the seek alone.
    const poster = path.join(dir, "poster.jpg");
    expect(await makePoster(src, poster, 1)).toBe(true);
    expect(
      await meanLuma(poster),
      "a black poster is indistinguishable from a missing thumbnail",
    ).toBeGreaterThan(30);
  });

  // The failure direction: skipping black frames writes NO file when every frame is black,
  // so without the plain second attempt such a clip would end up with no poster at all.
  it("still produces a poster for a clip that is black all the way through", async () => {
    const src = await synth("all-black.mp4", ["color=c=black:s=320x180:d=5,format=yuv420p"]);
    const poster = path.join(dir, "all-black.jpg");
    expect(await makePoster(src, poster, 0), "an all-black clip must still get a poster").toBe(
      true,
    );
  });
});
