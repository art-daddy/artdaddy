// Pixel conformance for the animatable properties: every entry in ANIM_PROPS, animated through
// the PRODUCTION `writeAnim`, rendered by real ffmpeg, and measured on the artifact.
//
// animProps.test.ts walks the same table against the data model. That catches a wrong PATH — the
// bug where five of eight properties silently showed nothing — but it cannot catch a path that
// resolves and still renders nothing, because it never runs the renderer. Verifying one property
// live (`opacity`) and declaring the other seven working is exactly the mistake this file exists
// to make impossible.
//
// NOT part of the unit suite: `npx vitest run --config vitest.smoke.config.ts`.
import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ANIM_PROPS, writeAnim } from "./animProps";
import type { Clip, Timeline } from "./model";
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
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-animpx-"));
  scratches.push(d);
  return d;
}
afterAll(async () => {
  for (const d of scratches)
    await fsp.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/** The frame at `atSec` as PNG bytes. Two frames that are byte-identical are the same picture. */
async function frameAt(dir: string, file: string, atSec: number, tag: string): Promise<Buffer> {
  const png = path.join(dir, `${tag}-${atSec}.png`);
  const r = await run(FF!, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    atSec.toFixed(3),
    "-i",
    file,
    "-frames:v",
    "1",
    "-update",
    "1",
    png,
  ]);
  expect(r.code, `extract at ${atSec}s: ${r.stderr.slice(-300)}`).toBe(0);
  return fsp.readFile(png);
}

/** Mean volume (dBFS) of the window starting at `atSec`. */
async function volumeAt(file: string, atSec: number): Promise<number> {
  const r = await run(FF!, [
    "-hide_banner",
    "-ss",
    atSec.toFixed(3),
    "-t",
    "0.5",
    "-i",
    file,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  expect(m, `no volumedetect at ${atSec}s: ${r.stderr.slice(-300)}`).toBeTruthy();
  return Number(m![1]);
}

/** A STATIC white clip. Static is the whole point: if the source moved on its own, every property
 *  below would "change the frame" whether or not it did anything, which is how this file first
 *  passed with the exporter deliberately broken. A white rectangle on a black canvas moves,
 *  grows, rotates and fades visibly, so no transform can hide in it. */
async function source(dir: string): Promise<string> {
  const src = path.join(dir, "src.mp4");
  const r = await run(FF!, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=320x240:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4:sample_rate=48000",
    "-shortest",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    src,
  ]);
  expect(r.code, r.stderr.slice(-300)).toBe(0);
  return src;
}

/** From/to for each property, chosen far enough apart that no rendering tolerance can hide it. */
const RANGE: Record<string, [number, number]> = {
  "transform.position.x": [0.25, 0.75],
  "transform.position.y": [0.25, 0.75],
  "transform.scale": [0.3, 0.9],
  "transform.scale_x": [0.3, 0.9],
  "transform.scale_y": [0.3, 0.9],
  rotate: [0, 60],
  opacity: [0.05, 1],
  volume: [0.02, 1],
};

/** `buildRenderCommand` consumes the SECONDS view, so every time here is seconds. The clip is
 *  built with the SAME writeAnim the Inspector and the keyframe lane use — a hand-written patch
 *  would prove the renderer works and leave the table itself unverified. */
function timelineFor(src: string, propPath: string, isAudio: boolean): Timeline {
  const [from, to] = RANGE[propPath];
  const base = {
    id: "a",
    kind: isAudio ? "audio" : "video",
    media_ref: src,
    timeline_in: 0,
    timeline_out: 4,
    source_in: 0,
    source_out: 4,
    // A sub-canvas scale so a position change has somewhere to move to.
    ...(isAudio ? {} : { transform: { position: { x: 0.5, y: 0.5 }, scale: 0.5 } }),
  } as unknown as Clip;
  const clip = {
    ...base,
    ...writeAnim(base, propPath, [
      { t: 0, v: from },
      { t: 4, v: to },
    ]),
  };
  return {
    canvas: { width: 320, height: 240, fps: 30 },
    tracks: [{ id: "t0", kind: isAudio ? "audio" : "video", z: 0, clips: [clip] }],
  } as unknown as Timeline;
}

const maybe = FF ? describe : describe.skip;

maybe("every animatable property reaches the exported file", () => {
  it.each(ANIM_PROPS.map((p) => [p.path, p.group] as const))(
    "%s",
    async (propPath, group) => {
      const isAudio = group === "audio";
      const dir = await scratch();
      const src = await source(dir);
      const out = path.join(dir, "out.mp4");
      const r = await run(FF!, buildRenderCommand(timelineFor(src, propPath, isAudio), out).args);
      expect(r.code, `render for ${propPath}: ${r.stderr.slice(-600)}`).toBe(0);

      if (isAudio) {
        // Two points that must DIFFER, and in the direction the curve asks for.
        const early = await volumeAt(out, 0.25);
        const late = await volumeAt(out, 3.25);
        expect(late, `'${propPath}' animated but the level never moved`).toBeGreaterThan(early + 6);
      } else {
        const early = await frameAt(dir, out, 0.5, "early");
        const late = await frameAt(dir, out, 3.5, "late");
        expect(
          early.equals(late),
          `'${propPath}' animated but rendered an identical frame — the property is inert in export`,
        ).toBe(false);
      }
    },
    180_000,
  );

  it("an animated rotation leaves the uncovered corner CLEAN, not smeared", async () => {
    // The defect this walk found: ffmpeg's rotate does not clear the uncovered corners between
    // frames, so `c=none` left the previous frame's pixels there. A constant angle hid it, and a
    // curve starting at 0 exported completely unrotated. "The frames differ" would not have caught
    // a partial smear, so check the corner directly against a background it cannot be confused
    // with: red underneath, white on top.
    const dir = await scratch();
    const src = await source(dir);
    const red = path.join(dir, "red.mp4");
    const mk = await run(FF!, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x240:r=30:d=4",
      "-pix_fmt",
      "yuv420p",
      red,
    ]);
    expect(mk.code, mk.stderr.slice(-300)).toBe(0);

    const out = path.join(dir, "rot.mp4");
    const clip = {
      id: "w",
      kind: "video",
      media_ref: src,
      timeline_in: 0,
      timeline_out: 4,
      source_in: 0,
      source_out: 4,
      transform: { position: { x: 0.5, y: 0.5 }, scale: 0.5 },
    } as unknown as Clip;
    const tl = {
      canvas: { width: 320, height: 240, fps: 30 },
      tracks: [
        {
          id: "bg",
          kind: "video",
          z: 0,
          clips: [
            {
              id: "r",
              kind: "video",
              media_ref: red,
              timeline_in: 0,
              timeline_out: 4,
              source_in: 0,
              source_out: 4,
            },
          ],
        },
        {
          id: "fg",
          kind: "video",
          z: 1,
          clips: [
            {
              ...clip,
              ...writeAnim(clip, "rotate", [
                { t: 0, v: 0 },
                { t: 4, v: 60 },
              ]),
            },
          ],
        },
      ],
    } as unknown as Timeline;
    const r = await run(FF!, buildRenderCommand(tl, out).args);
    expect(r.code, `render: ${r.stderr.slice(-600)}`).toBe(0);

    // A 4x4 patch just inside the top-left of the rotated clip's box, well after it has turned.
    const png = path.join(dir, "corner.png");
    await run(FF!, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "3.5",
      "-i",
      out,
      "-frames:v",
      "1",
      "-update",
      "1",
      png,
    ]);
    const s = await run(FF!, [
      "-hide_banner",
      "-i",
      png,
      "-vf",
      "crop=4:4:82:62,signalstats,metadata=print",
      "-f",
      "null",
      "-",
    ]);
    const luma = Number(/YAVG=([\d.]+)/.exec(s.stderr)?.[1]);
    expect(
      luma,
      `the corner reads ${luma} — white (~235) means the previous frame smeared through`,
    ).toBeLessThan(150);
  }, 180_000);

  it("the control: with NO animation the two sampled frames are identical", async () => {
    // Without this, "the frames differ" could mean the SOURCE is moving rather than the property.
    // That is not hypothetical: an animated test pattern made every property above pass while the
    // exporter was deliberately ignoring one of them.
    const dir = await scratch();
    const src = await source(dir);
    const out = path.join(dir, "static.mp4");
    const still = {
      canvas: { width: 320, height: 240, fps: 30 },
      tracks: [
        {
          id: "t0",
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
              transform: { position: { x: 0.5, y: 0.5 }, scale: 0.5 },
            },
          ],
        },
      ],
    } as unknown as Timeline;
    const r = await run(FF!, buildRenderCommand(still, out).args);
    expect(r.code, r.stderr.slice(-600)).toBe(0);
    const a = await frameAt(dir, out, 0.5, "ctl-a");
    const b = await frameAt(dir, out, 3.5, "ctl-b");
    expect(a.equals(b), "the baseline picture moves on its own — the walk proves nothing").toBe(
      true,
    );
  }, 180_000);
});
