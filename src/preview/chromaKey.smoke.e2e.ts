// Conformance: what the PREVIEW means by chroma `similarity` must be what the EXPORT means.
//
// A production session (feedback d03ab792) died in the gap. The shader keyed on RGB distance
// (0..√3), ffmpeg keys on chroma-plane distance (0..1). The user's preview still showed green, so
// the model raised similarity 0.30 -> 0.42 to remove it; the preview barely moved, while in the
// export 0.42 is past the threshold where WHITE is inside the key. An orange-and-white cat
// exported as a floating nose and mouth.
//
// This walks a grid of colours against the BUNDLED ffmpeg and asserts the shared definition
// predicts what ffmpeg actually does — a table conformance check, not one hand-picked colour,
// because the whole failure was "this one colour behaves differently from the one I tried".
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { keyAlpha, keyDistance } from "./chromaKey";

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

function run(program: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ code: -1, stderr: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

const scratches: string[] = [];
async function scratch(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-key-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

const GREEN: [number, number, number] = [0, 1, 0];

/** Key a solid `hex` patch against green and read the resulting ALPHA PLANE. Encoding to yuv420p
 *  would silently DISCARD alpha and report every colour as kept, so the alpha is extracted as a
 *  greyscale image and measured — the actual output of the key, not a proxy for it. */
async function ffmpegKeeps(hex: string, similarity: number): Promise<boolean> {
  const cwd = await scratch();
  const out = path.join(cwd, "alpha.png");
  const r = await run(FF!, [
    ...["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${hex}:s=64x64:d=1`],
    ...[
      "-filter_complex",
      `[0:v]chromakey=0x00FF00:${similarity}:0.0,format=yuva420p,alphaextract[a]`,
    ],
    ...["-map", "[a]", "-frames:v", "1", out],
  ]);
  expect(r.code, `render failed: ${r.stderr.slice(-300)}`).toBe(0);
  const s = await run(FF!, [
    ...["-hide_banner", "-i", out, "-vf", "signalstats,metadata=print", "-f", "null", "-"],
  ]);
  const vals = [...s.stderr.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) =>
    Number(m[1]),
  );
  expect(vals.length, "no alpha measured").toBeGreaterThan(0);
  return vals.reduce((a, b) => a + b, 0) / vals.length > 127;
}

const rgbOf = (hex: string): [number, number, number] => [
  parseInt(hex.slice(2, 4), 16) / 255,
  parseInt(hex.slice(4, 6), 16) / 255,
  parseInt(hex.slice(6, 8), 16) / 255,
];

// Spread across the chroma plane: the backing itself, near-neutrals (the ones that bit us), warm
// fur tones, and colours far from green.
const COLOURS = [
  "0x00FF00", // the backing
  "0xFFFFFF", // white fur — keyed at 0.42, kept at 0.30
  "0xC8C8C8",
  "0x808080",
  "0xFFA500", // orange fur
  "0xFFC0CB", // nose
  "0x0000FF",
  "0xFF0000",
  "0x00AA55", // greenish but not the key
];

describe.skipIf(!FF)("chroma similarity means the same thing in both backends", () => {
  it("predicts ffmpeg's keep/remove decision for every colour at every similarity", async () => {
    const mismatches: string[] = [];
    for (const hex of COLOURS) {
      for (const sim of [0.1, 0.3, 0.42, 0.6]) {
        const predicted = keyAlpha(rgbOf(hex), GREEN, sim, 0) > 0.5;
        const actual = await ffmpegKeeps(hex, sim);
        if (predicted !== actual)
          mismatches.push(
            `${hex} @ ${sim}: preview says ${predicted ? "keep" : "key"}, ffmpeg ${actual ? "kept" : "keyed"} (d=${keyDistance(rgbOf(hex), GREEN).toFixed(3)})`,
          );
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);

  it("puts white inside the key exactly where ffmpeg does — the value that broke the cat", () => {
    // Measured against the bundled ffmpeg: white flips between 0.36 and 0.38.
    const d = keyDistance([1, 1, 1], GREEN);
    expect(d).toBeGreaterThan(0.36);
    expect(d).toBeLessThan(0.38);
    // The regression in one line: at the value the model settled on, white is gone.
    expect(keyAlpha([1, 1, 1], GREEN, 0.42, 0)).toBe(0);
    expect(keyAlpha([1, 1, 1], GREEN, 0.3, 0)).toBe(1);
  });

  it("ramps linearly across blend rather than smoothly, as chromakey does", () => {
    const d = keyDistance([1, 1, 1], GREEN);
    const sim = d - 0.05;
    // Halfway up a 0.1-wide ramp is 0.5 under a linear law; a smoothstep would give 0.5 here too,
    // so check a quarter point, where the two laws genuinely differ (0.25 vs ~0.156).
    expect(keyAlpha([1, 1, 1], GREEN, sim, 0.2)).toBeCloseTo(0.25, 2);
  });
});
