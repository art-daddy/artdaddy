// Every picture the model is SHOWN is small, whatever the source (Phase 1b, UJ-019 residual).
//
// 2026-10-05: a user's Sony footage (4K 10-bit 4:2:2 H.264) made 0.19.3's PNG frames 16-bit,
// ~2.5 MB each, and ~19 of them filled the server's 64 MB request limit. Phase 1 moved inspect
// frames to small JPEGs, but inspect_color still attached a 1024 px PNG, and on an image it
// attached the original file. History frames over 2 MB are never re-sent, so on such footage the
// model was told about a frame it never saw. Judged on what the model actually receives: the
// bytes the app re-sends for these results.
//   npx vitest run --config vitest.smoke.config.ts src/tools/modelImages.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { historyAttachments } from "../agent/historyFrames";
import type { Turn } from "../store/chatTranscript";
import { ensureTimeline } from "../timeline/engine";
import { setCanvasTool } from "../timeline/ops";
import { addClipsTool } from "../timeline/placement";
import { ff, flushE2EDoc, installE2EDocuments, libRef, mkCtx, openE2EDoc, resetE2EDocuments } from "./__e2e";
import { readImageSize } from "./imageDims";
import { inspectColorTool } from "./inspect";
import { joinPath } from "./store";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = path.join(os.tmpdir(), `artdaddy-model-images-${Date.now()}`);
/** The longest edge of any picture the model is shown. */
const MAX_EDGE = 768;

beforeAll(() => installE2EDocuments());
afterAll(async () => {
  await resetE2EDocuments();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** A Sony-like clip: 4K, 50 fps, 10-bit 4:2:2 H.264 with PCM sound, busy enough to be large. */
async function sonyLike(file: string): Promise<string> {
  await ff([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=50,noise=alls=12:allf=t",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv422p10le",
    "-profile:v", "high422", "-c:a", "pcm_s16be", "-f", "mov", file,
  ]);
  return file;
}

/** What the model receives for one attached picture: its bytes, as the app would re-send them. */
async function shown(ctx: Any, attachments: Any[]): Promise<Uint8Array[]> {
  const turns = [
    {
      parts: [
        {
          kind: "tool_result",
          call_id: "call_1",
          frame_refs: attachments.map((a: Any) => ({ path: a.path, caption: a.caption })),
        },
      ],
    },
  ] as unknown as Turn[];
  const sent = await historyAttachments(turns, ctx.store);
  return sent.map((a) => Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0)));
}

function judge(label: string, bytes: Uint8Array[], expected: number): string[] {
  const problems: string[] = [];
  if (bytes.length !== expected)
    problems.push(`${label}: the model receives ${bytes.length} of ${expected} pictures`);
  for (const b of bytes) {
    const size = readImageSize(b);
    const jpeg = b[0] === 0xff && b[1] === 0xd8;
    if (!jpeg) problems.push(`${label}: a picture is not a JPEG`);
    if (!size || Math.max(size.width, size.height) > MAX_EDGE)
      problems.push(`${label}: a picture is ${size ? `${size.width}x${size.height}` : "unreadable"}`);
    if (b.length > 512 * 1024) problems.push(`${label}: a picture is ${(b.length / 1e6).toFixed(2)} MB`);
  }
  return problems;
}

describe("every picture the model is shown is small (UJ-019)", () => {
  it("inspect_color on 10-bit 4:2:2 camera footage, a big still, and a placed clip", async () => {
    const dir = joinPath(root, "p");
    await fsp.mkdir(dir, { recursive: true });
    const ctx = mkCtx(dir);
    await openE2EDoc(dir);
    await ensureTimeline(ctx.store);
    const clip = await libRef(ctx, await sonyLike(path.join(root, "C0001.MP4")), "video");
    const still = path.join(root, "DSC0001.jpg");
    await ff([
      "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=6000x4000,noise=alls=20:allf=t",
      "-frames:v", "1", "-q:v", "2", still,
    ]);
    const photo = await libRef(ctx, still, "image");
    const problems: string[] = [];

    const onMedia = (await inspectColorTool({ media_ref: clip, reference: photo }, ctx)) as Any;
    expect(onMedia.ok, JSON.stringify(onMedia).slice(0, 300)).toBe(true);
    problems.push(...judge("media_ref + reference", await shown(ctx, onMedia._attachments), 2));

    expect(((await setCanvasTool({ width: 1920, height: 1080, fps: 25 }, ctx)) as Any).ok).toBe(true);
    const placed = (await addClipsTool({ entries: [{ media_ref: clip, timeline_in: 0, timeline_out: 25 }] }, ctx)) as Any;
    expect(placed.ok, JSON.stringify(placed).slice(0, 300)).toBe(true);
    await flushE2EDoc(dir);
    const onClip = (await inspectColorTool({ clip_id: placed.created[0].clip_id }, ctx)) as Any;
    expect(onClip.ok, JSON.stringify(onClip).slice(0, 300)).toBe(true);
    problems.push(...judge("clip_id", await shown(ctx, onClip._attachments), 1));

    expect(problems, problems.join("\n")).toEqual([]);
  }, 240_000);
});
