// Same export twice = same pixels. A blend-mode clip that is also semi-transparent differed in 89
// of 90 frames between renders of ONE graph (Phase 2 saw up to 10 levels): the blend chain's
// overlay onto its transparent canvas raced between slice threads. Two exports of one project
// must be the same video, and inspect_timeline's frame is only "the export's frame" if the
// export is deterministic. Each case renders the export's own graph three times, threaded as
// the app runs it, and compares every frame's hash.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/blendDeterminism.smoke.e2e.ts
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Timeline } from "./model";
import { buildRenderCommand } from "./render";
import { BLEND_KINDS } from "./renderPlan";
import { shippedSidecar } from "../test/sidecars";

const FF = shippedSidecar("ffmpeg");

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(FF!, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    child.on("close", (c) => resolve({ code: c ?? -1, out, err }));
  });
}

let dir = "";
let base = "";
let top = "";
beforeAll(async () => {
  if (!FF) return;
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-blenddet-"));
  base = path.join(dir, "base.mp4");
  top = path.join(dir, "top.mp4");
  for (const [file, src] of [
    [base, "testsrc2=s=640x360:r=30:d=3"],
    [top, "mandelbrot=s=640x360:r=30"],
  ] as const) {
    const r = await run([
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      src,
      "-t",
      "3",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    expect(r.code, r.err.slice(-300)).toBe(0);
  }
});
afterAll(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/** Per-frame hashes of the export's own graph, encoded losslessly. */
async function hashes(tl: Timeline, tag: string): Promise<string[]> {
  const out = path.join(dir, `${tag}.mkv`);
  const args = [...buildRenderCommand(tl, out).args];
  const i = args.indexOf("-c:v");
  args.splice(i, 6, "-c:v", "ffv1");
  const r = await run(args);
  expect(r.code, r.err.slice(-600)).toBe(0);
  const h = await run(["-v", "error", "-i", out, "-map", "0:v", "-f", "framemd5", "-"]);
  return h.out
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").pop()!.trim());
}

const clip = (id: string, media: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "video",
  media_ref: media,
  timeline_in: 0,
  timeline_out: 3,
  source_in: 0,
  source_out: 3,
  ...extra,
});

function layered(look: Record<string, unknown>): Timeline {
  return {
    canvas: { width: 640, height: 360, fps: 30 },
    tracks: [
      { id: "v0", kind: "video", z: 0, clips: [clip("a", base)] },
      { id: "v1", kind: "video", z: 1, clips: [clip("b", top, look)] },
    ],
  } as unknown as Timeline;
}

const blends = BLEND_KINDS.filter((b) => b !== "normal");
const CASES: [string, Record<string, unknown>][] = [
  ...blends.map(
    (b) => [`${b} at 0.8 opacity`, { blend: b, opacity: 0.8 }] as [string, Record<string, unknown>],
  ),
  [
    "screen, animated opacity",
    {
      blend: "screen",
      opacity: [
        { t: 0, v: 0.2 },
        { t: 3, v: 0.9 },
      ],
    },
  ],
  ["screen, faded in", { blend: "screen", fade: { in: 30 } }],
  ["overlay, rotated at 0.6 opacity", { blend: "overlay", rotate: 12, opacity: 0.6 }],
  ["normal at 0.8 opacity", { opacity: 0.8 }],
];

describe.runIf(FF)("an export renders the same pixels every time", () => {
  it.each(CASES)(
    "%s: three renders, every frame identical",
    async (name, look) => {
      const tl = layered(look);
      const tag = name.replace(/\W+/g, "_");
      const runs = [
        await hashes(tl, `${tag}1`),
        await hashes(tl, `${tag}2`),
        await hashes(tl, `${tag}3`),
      ];
      expect(runs[0].length).toBe(90);
      const differing = runs[0].filter((h, k) => h !== runs[1][k] || h !== runs[2][k]).length;
      expect(differing, `${differing} of 90 frames differ between renders`).toBe(0);
    },
    300_000,
  );
});
