// Does `hold` actually STEP in the exported video?
//
// The sampler and the ffmpeg compiler agree in the property tests, but both could agree on the
// wrong thing, and neither runs ffmpeg. This renders a real file and reads its luma: with a held
// opacity the picture must still be dark at the midpoint, where a linear ramp would be half up.
// This is the "38 caption tests green, zero caption pixels" lesson applied to easing.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";

function bundled(name: string): string | null {
  const dir = path.resolve(process.cwd(), "src-tauri/binaries");
  const suffix =
    process.platform === "win32"
      ? "-x86_64-pc-windows-msvc.exe"
      : process.platform === "darwin"
        ? "-aarch64-apple-darwin"
        : "-x86_64-unknown-linux-gnu";
  const p = path.join(dir, `${name}${suffix}`);
  return existsSync(p) ? p : null;
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
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-hold-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/** Mean luma of the single frame at `atSec`. */
async function lumaAt(file: string, atSec: number): Promise<number> {
  const r = await run(FF!, [
    "-hide_banner",
    "-ss",
    atSec.toFixed(3),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "signalstats,metadata=print",
    "-f",
    "null",
    "-",
  ]);
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.stderr);
  expect(m, `no signalstats at ${atSec}s: ${r.stderr.slice(-300)}`).toBeTruthy();
  return Number(m![1]);
}

/** A white clip on a black canvas carrying the given opacity curve.
 *
 *  `buildRenderCommand` consumes the SECONDS view (renderTimelineToPath converts first), so every
 *  time here is seconds. Writing frames instead makes a 4-second clip claim to be 120 seconds and
 *  the ramp barely leaves zero — which is exactly how this test first "failed".
 */
function curve(src: string, opacity: Record<string, unknown>[]): Timeline {
  return {
    canvas: { width: 320, height: 240, fps: 30 },
    tracks: [
      {
        id: "v0",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "a",
            kind: "video",
            media_ref: src,
            timeline_in: 0,
            timeline_out: 4,
            source_in: 0,
            source_out: 4,
            opacity,
          },
        ],
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const timeline = (src: string, ease?: string): Timeline =>
  curve(src, [ease ? { t: 0, v: 0, ease } : { t: 0, v: 0 }, { t: 4, v: 1 }]);

/** A plain white source, the brightest thing an opacity curve can reveal. */
async function white(dir: string): Promise<string> {
  const src = path.join(dir, "white.mp4");
  const mk = await run(FF!, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=320x240:r=30:d=4",
    "-pix_fmt",
    "yuv420p",
    src,
  ]);
  expect(mk.code, mk.stderr.slice(-300)).toBe(0);
  return src;
}

const maybe = FF ? describe : describe.skip;

maybe("hold easing (real ffmpeg)", () => {
  async function renderBoth() {
    const dir = await scratch();
    const src = await white(dir);
    const lin = path.join(dir, "linear.mp4");
    const held = path.join(dir, "hold.mp4");
    const a = await run(FF!, buildRenderCommand(timeline(src), lin).args);
    const b = await run(FF!, buildRenderCommand(timeline(src, "hold"), held).args);
    expect(a.code, `linear render: ${a.stderr.slice(-500)}`).toBe(0);
    expect(b.code, `hold render: ${b.stderr.slice(-500)}`).toBe(0);
    return { lin, held };
  }

  it("holds the value flat where a linear ramp would be half way up", async () => {
    const { lin, held } = await renderBoth();
    const midLinear = await lumaAt(lin, 2);
    const midHeld = await lumaAt(held, 2);
    // Linear is genuinely part-way up; held is still at the start value.
    expect(midLinear).toBeGreaterThan(40);
    expect(midHeld).toBeLessThan(midLinear / 2);
  }, 180_000);

  it("releases at the NEXT key, not at the end of the clip", async () => {
    // The failure direction: a `hold` that never releases looks identical for the whole clip, and
    // a two-key curve cannot tell the difference because its step lands on the last frame. Step
    // in the MIDDLE and sample both sides of it.
    const dir = await scratch();
    const src = await white(dir);
    const out = path.join(dir, "step-mid.mp4");
    const r = await run(
      FF!,
      buildRenderCommand(
        curve(src, [
          { t: 0, v: 0, ease: "hold" },
          { t: 2, v: 1, ease: "hold" },
          { t: 4, v: 1 },
        ]),
        out,
      ).args,
    );
    expect(r.code, `render: ${r.stderr.slice(-500)}`).toBe(0);
    const before = await lumaAt(out, 1.5);
    const after = await lumaAt(out, 3);
    expect(before).toBeLessThan(30); // still down
    expect(after).toBeGreaterThan(before + 100); // and fully up after the step
  }, 180_000);
});
