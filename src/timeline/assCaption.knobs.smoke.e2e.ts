// Pixel conformance for the caption knobs: the SAME table the unit walk uses
// (assCaption.knobs.test.ts), but burned through the bundled ffmpeg's libass and compared as
// pixels.
//
// Why both lanes exist: a changed .ass string is necessary but NOT sufficient. libass silently
// ignores an override tag it does not understand, so a knob can reach the file and still paint
// nothing — which is the same shape as the regression where every caption test asserted the
// filtergraph contained `ass=` while the video had zero caption pixels.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assFor, CANVAS, KNOB_NAMES, KNOBS } from "./__captionKnobs";

function bundledFfmpeg(): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const names =
    process.platform === "win32"
      ? ["ffmpeg-x86_64-pc-windows-msvc.exe"]
      : process.platform === "darwin"
        ? ["ffmpeg-aarch64-apple-darwin", "ffmpeg-x86_64-apple-darwin"]
        : ["ffmpeg-x86_64-unknown-linux-gnu"];
  for (const n of names) {
    const p = path.join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

const FF = bundledFfmpeg();
const FONTS_SRC = path.resolve(process.cwd(), "src-tauri/resources/fonts");
const MID_SEC = 1;

function run(
  program: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, windowsHide: true });
    let err = "";
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", (e) => resolve({ code: -1, err: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, err }));
  });
}

let dir = "";

/** Burn `ass` onto a black canvas and return the frame at `atSec` as PNG bytes. The graph
 *  references the .ass by BARE name, so ffmpeg runs with the scratch dir as cwd — a Windows drive
 *  colon would otherwise be eaten by ffmpeg's filter-option splitter. */
async function frame(tag: string, ass: string, atSec: number): Promise<Buffer> {
  const name = `${tag}.ass`;
  const png = `${tag}.png`;
  await fsp.writeFile(path.join(dir, name), ass);
  const r = await run(
    FF!,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${CANVAS.w}x${CANVAS.h}:r=25:d=2`,
      "-vf",
      `ass=f=${name}:fontsdir=fonts`,
      "-ss",
      String(atSec),
      "-frames:v",
      "1",
      "-update",
      "1",
      png,
    ],
    dir,
  );
  expect(r.code, `ffmpeg failed for ${tag}: ${r.err.slice(-500)}`).toBe(0);
  return fsp.readFile(path.join(dir, png));
}

/** Max luma in the frame — libass paints white text ~235 on a ~16 black canvas. */
async function maxLuma(png: string): Promise<number> {
  const r = await run(
    FF!,
    ["-hide_banner", "-i", png, "-vf", "signalstats,metadata=print", "-f", "null", "-"],
    dir,
  );
  let max = -1;
  for (const m of r.err.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g))
    max = Math.max(max, Number(m[1]));
  return max;
}

beforeAll(async () => {
  if (!FF) return;
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-capknobs-"));
  await fsp.mkdir(path.join(dir, "fonts"), { recursive: true });
  for (const f of await fsp.readdir(FONTS_SRC)) {
    await fsp.copyFile(path.join(FONTS_SRC, f), path.join(dir, "fonts", f));
  }
});
afterAll(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(!FF)("every CaptionSpec knob reaches the PIXELS", () => {
  it("the baseline caption actually paints, and paints reproducibly", async () => {
    // Both controls in one place: if the baseline were blank, "the two frames differ" below would
    // be meaningless; if PNG output were non-deterministic, it would be worthless.
    const knob = KNOBS.color;
    const a = await frame("ctl-a", assFor(knob, "base"), MID_SEC);
    const b = await frame("ctl-b", assFor(knob, "base"), MID_SEC);
    expect(
      await maxLuma(path.join(dir, "ctl-a.png")),
      "the baseline caption painted nothing",
    ).toBeGreaterThan(120);
    expect(
      a.equals(b),
      "the same .ass rendered two different frames — this lane cannot conclude anything",
    ).toBe(true);
  });

  it.each(KNOB_NAMES)("%s", async (name) => {
    const knob = KNOBS[name];
    const at = knob.atSec ?? MID_SEC;
    const base = await frame(`${name}-base`, assFor(knob, "base"), at);
    const varied = await frame(`${name}-var`, assFor(knob, "varied"), at);
    expect(
      base.equals(varied),
      `'${name}' changed the .ass but painted an identical frame — libass is ignoring it`,
    ).toBe(false);
  });
});
