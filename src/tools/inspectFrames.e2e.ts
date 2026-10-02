// Frames the agent looks at are re-sent every round once the app owns the history (Phase 1,
// option A, docs/USER_JOURNEY_ANALYSIS.md). Two things must hold of the FILES, so this drives the
// real tools against real ffmpeg and reads what was written:
//   * they are small: JPEG, 512 px longest edge for inspect_media, 768 px for inspect_timeline
//     (1024 px PNGs were ~1 MB each; 30 of them a round would approach the 64 MB request cap);
//   * a frame file never changes after the round that showed it. inspect_timeline wrote
//     `tl_<frame>.png`, so a later look at the same frame number OVERWROTE an earlier one, and the
//     re-sent history would have shown the model a later edit under an earlier result.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/inspectFrames.e2e.ts
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "./command";
import type { ClientToolContext } from "./context";
import { inspectMediaTool, inspectTimelineTool } from "./inspect";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { ensureTimeline } from "../timeline/engine";
import { addClipsTool } from "../timeline/placement";
import { applyColorTool } from "../timeline/props";
import { installE2EDocuments, resetE2EDocuments, flushE2EDoc, libRef, openE2EDoc } from "./__e2e";

type Rec = Record<string, unknown>;

const nodeRunner: CommandRunner = {
  run(program, args): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(program, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e) }));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  },
};

const nodeFs: FsLike = {
  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
  readTextFile: (p) => fsp.readFile(p, "utf8"),
  async writeTextFile(p, c) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, c);
  },
  async readBytes(p) {
    const b = await fsp.readFile(p);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  },
  async writeBytes(p, bytes) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, bytes);
  },
  async rename(src, dst) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rename(src, dst);
  },
  async readDir(p) {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  },
  async remove(p) {
    await fsp.rm(p, { recursive: true, force: true });
  },
  async copyFile(src, dst) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  },
  async mkdir(p) {
    await fsp.mkdir(p, { recursive: true });
  },
};

const proj = joinPath(os.tmpdir(), `artdaddy-frames-${Date.now()}`);
const ctx: ClientToolContext = { store: new ProjectStoreAccess(proj, nodeFs), runner: nodeRunner };

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined);
});

/** What is actually in the file: codec and size, from ffprobe, plus the JPEG magic bytes. */
async function frameFacts(file: string): Promise<{ jpeg: boolean; w: number; h: number; bytes: number }> {
  const buf = await fsp.readFile(file);
  const r = await nodeRunner.run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    file,
  ]);
  const s = (JSON.parse(r.stdout) as { streams: Array<{ width: number; height: number }> }).streams[0];
  return { jpeg: buf[0] === 0xff && buf[1] === 0xd8, w: s.width, h: s.height, bytes: buf.length };
}

async function ffmpeg(args: string[]): Promise<void> {
  const r = await nodeRunner.run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  expect(r.code, r.stderr).toBe(0);
}

describe("frames the agent sees are small, and never change after the round that showed them", () => {
  it("inspect_media: video frames and stills are JPEG, at most 512 px on the long edge", async () => {
    await nodeFs.mkdir(proj);
    const video = joinPath(proj, "wide.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=6", "-pix_fmt", "yuv420p", video]);
    const still = joinPath(proj, "photo.png");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1600x1200:rate=1", "-frames:v", "1", still]);

    const vref = await libRef(ctx, video, "video");
    const v = (await inspectMediaTool({ media_ref: vref, max_frames: 3 }, ctx)) as Rec;
    expect(v.ok).toBe(true);
    const vatts = v._attachments as Array<{ path: string }>;
    expect(vatts).toHaveLength(3);
    for (const a of vatts) {
      const f = await frameFacts(a.path);
      expect(f.jpeg).toBe(true);
      expect(Math.max(f.w, f.h)).toBe(512);
      expect(f.bytes).toBeLessThan(150_000);
    }

    const sref = await libRef(ctx, still, "image");
    const s = (await inspectMediaTool({ media_ref: sref }, ctx)) as Rec;
    expect(s.ok).toBe(true);
    const sf = await frameFacts((s._attachments as Array<{ path: string }>)[0].path);
    expect(sf.jpeg).toBe(true);
    expect(Math.max(sf.w, sf.h)).toBeLessThanOrEqual(512);
  });

  it("inspect_timeline: frames are JPEG at most 768 px, and a later look never overwrites an earlier one", async () => {
    const video = joinPath(proj, "tall.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=4", "-pix_fmt", "yuv420p", video]);
    const ref = await libRef(ctx, video, "video");
    await openE2EDoc(proj);
    await ensureTimeline(ctx.store); // seeded canvas: 1080x1920 @ 30
    const placed = (await addClipsTool({ entries: [{ media_ref: ref, timeline_in: 0, timeline_out: 90 }] }, ctx)) as Rec;
    expect(placed.ok).toBe(true);
    await flushE2EDoc(proj);

    const first = (await inspectTimelineTool({ start_frame: 30 }, ctx)) as Rec;
    expect(first.ok).toBe(true);
    const firstPath = (first._attachments as Array<{ path: string }>)[0].path;
    const f = await frameFacts(firstPath);
    expect(f.jpeg).toBe(true);
    expect(Math.max(f.w, f.h)).toBe(768);
    const firstBytes = await fsp.readFile(firstPath);

    // Edit, then look at the SAME frame number again.
    const clipId = (placed.created as Array<{ clip_id: string }>)[0].clip_id;
    expect(((await applyColorTool({ clip_ids: [clipId], saturation: 0 }, ctx)) as Rec).ok).toBe(true);
    await flushE2EDoc(proj);
    const second = (await inspectTimelineTool({ start_frame: 30 }, ctx)) as Rec;
    expect(second.ok).toBe(true);
    const secondPath = (second._attachments as Array<{ path: string }>)[0].path;

    expect(secondPath).not.toBe(firstPath);
    // The earlier round's frame is exactly what that round showed.
    expect(Buffer.compare(await fsp.readFile(firstPath), firstBytes)).toBe(0);
    // And the edit is visible in the new one (desaturated: the two frames differ).
    expect(Buffer.compare(await fsp.readFile(secondPath), firstBytes)).not.toBe(0);
  });
});
