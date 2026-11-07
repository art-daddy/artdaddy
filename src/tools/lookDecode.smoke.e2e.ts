// Phase 4 (S1): a look decoded on the GPU is the SAME picture, and a GPU that fails costs time and never the look
// (tools/lookDecode.ts). Real ffmpeg (the one the app ships), the real decoder, a real project.
//
// The promise under test is about bytes, not about commands: the JPEG the agent is shown is identical with and
// without the GPU, for both looks (inspect_timeline and inspect_media), on a file with ONE keyframe (the worst
// case for a look: everything before the frame is decoded). On a PC with a hardware decoder, set
// ARTDADDY_EXPECT_GPU=1 to also require that the decoder really chose it, so a test run cannot pass by never using it.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/lookDecode.smoke.e2e.ts
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { inspectMediaTool, inspectTimelineTool } from "./inspect";
import { createLookDecoder, type LookDecoder } from "./lookDecode";
import { probePath } from "./media";
import { ProjectStoreAccess, joinPath } from "./store";
import { ensureTimeline } from "../timeline/engine";
import { addClipsTool } from "../timeline/placement";
import {
  flushE2EDoc,
  installE2EDocuments,
  libRef,
  longFixture,
  nodeFs,
  nodeRunner,
  openE2EDoc,
  resetE2EDocuments,
} from "./__e2e";

vi.mock("@tauri-apps/api/path", async () => {
  const p = await import("node:path");
  return { resolveResource: async (r: string) => p.resolve(process.cwd(), "src-tauri", r) };
});

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const FPS = 30;
const SECONDS = 90;
const ONE_KEYFRAME = 100_000;
const root = path.join(os.tmpdir(), `artdaddy-look-decode-${Date.now()}`);
const proj = joinPath(root, "p");
const ctx: ClientToolContext = { store: new ProjectStoreAccess(proj, nodeFs), runner: nodeRunner };

const realOs = (): "windows" | "macos" | "linux" =>
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const software = (): LookDecoder =>
  createLookDecoder({ os: () => "linux", storage: null, now: () => Date.now() });
const thisPc = (): LookDecoder =>
  createLookDecoder({ os: realOs, storage: null, now: () => Date.now() });

let fixture = "";
let ref = "";

async function clearCache(): Promise<void> {
  await fsp.rm(path.join(proj, "internals", "cache", "inspect"), { recursive: true, force: true });
}
const sha = async (file: string): Promise<string> =>
  createHash("sha256")
    .update(await fsp.readFile(file))
    .digest("hex");

async function timelineLook(
  decoder: LookDecoder,
  runner: CommandRunner = nodeRunner,
): Promise<string> {
  await clearCache();
  const r = (await inspectTimelineTool(
    { start_frame: (SECONDS - 5) * FPS },
    { ...ctx, runner, lookDecode: decoder },
  )) as Any;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.frames_attached).toBe(1);
  return sha(r._attachments[0].path);
}

async function mediaLook(
  decoder: LookDecoder,
  runner: CommandRunner = nodeRunner,
): Promise<string[]> {
  await clearCache();
  const r = (await inspectMediaTool(
    { media_ref: ref, start_seconds: 40, end_seconds: SECONDS - 1, max_frames: 3 },
    { ...ctx, runner, lookDecode: decoder },
  )) as Any;
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(r.frames_attached).toBe(3);
  return Promise.all((r._attachments as Any[]).map((a) => sha(a.path)));
}

beforeAll(async () => {
  installE2EDocuments();
  await fsp.mkdir(proj, { recursive: true });
  fixture = await longFixture({ seconds: SECONDS, fps: FPS, gop: ONE_KEYFRAME });
  ref = await libRef(ctx, fixture, "video");
  await openE2EDoc(proj);
  await ensureTimeline(ctx.store);
  const placed = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: SECONDS * FPS }] },
    ctx,
  )) as Any;
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  await flushE2EDoc(proj);
}, 300_000);

afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("a look on the GPU is the same picture", () => {
  it("this PC proves the hardware decoder (only required where ARTDADDY_EXPECT_GPU=1)", async () => {
    const probe = await probePath(nodeRunner, fixture);
    const flags = await thisPc().flags(nodeRunner, fixture, (probe.video ?? null) as Any);
    console.log(
      `[lookDecode] ${realOs()}: hardware decode ${flags.length ? flags.join(" ") : "not used"}`,
    ); // eslint-disable-line no-console
    if (process.env.ARTDADDY_EXPECT_GPU === "1") expect(flags.length).toBeGreaterThan(0);
  });

  it("inspect_timeline: the frame 85 s into a one-keyframe file has the same bytes with and without it", async () => {
    expect(await timelineLook(thisPc())).toBe(await timelineLook(software()));
  });

  it("inspect_media: every frame has the same bytes with and without it", async () => {
    expect(await mediaLook(thisPc())).toEqual(await mediaLook(software()));
  });
});

describe("a GPU that fails costs time, never the look", () => {
  /** A PC whose proof passes and whose look runs then fail the way a driver can: the proof is run in
   *  software both ways, and every look frame that asks for the GPU is given a decoder ffmpeg does not have. */
  function failingGpuRunner(seen: string[][]): CommandRunner {
    return {
      run(program, args, signal, cwd, onStdout) {
        let a = args;
        if (program === "ffmpeg" && args.includes("framemd5")) {
          const at = args.indexOf("-hwaccel");
          if (at >= 0) a = args.filter((_, i) => i !== at && i !== at + 1);
        } else if (program === "ffmpeg" && args.includes("-hwaccel")) {
          seen.push(args);
          a = args.map((x) => (x === "d3d11va" || x === "videotoolbox" ? "not_a_real_accel" : x));
        } else if (program === "ffmpeg" && args.includes("-frames:v")) seen.push(args);
        return nodeRunner.run(program, a, signal, cwd, onStdout);
      },
    };
  }
  const pretendWindows = (): LookDecoder =>
    createLookDecoder({ os: () => "windows", storage: null, now: () => Date.now() });

  it("inspect_timeline redoes the frame in software, returns the same bytes, and stops asking the GPU", async () => {
    const baseline = await timelineLook(software());
    const seen: string[][] = [];
    const decoder = pretendWindows();
    expect(await timelineLook(decoder, failingGpuRunner(seen))).toBe(baseline);
    expect(seen.some((a) => a.includes("-hwaccel"))).toBe(true); // the GPU was tried...
    seen.length = 0;
    expect(await timelineLook(decoder, failingGpuRunner(seen))).toBe(baseline);
    expect(seen.every((a) => !a.includes("-hwaccel"))).toBe(true); // ...and not again for this shape
  });

  it("inspect_media redoes each frame in software and returns the same bytes", async () => {
    const baseline = await mediaLook(software());
    const seen: string[][] = [];
    expect(await mediaLook(pretendWindows(), failingGpuRunner(seen))).toEqual(baseline);
    expect(seen.some((a) => a.includes("-hwaccel"))).toBe(true);
  });
});
