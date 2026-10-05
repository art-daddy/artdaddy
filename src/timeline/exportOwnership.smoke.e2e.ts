// UJ-022 with the real ffmpeg. An export started by the agent belongs to the export queue: it
// outlives the agent's turn (Stop, the next message, a project switch), the queue's Cancel kills
// the encode at once, neither leaves a partial behind, and the delivered file is a real mp4 even
// though ffmpeg wrote it under a `.partial` name (the container comes from `-f mp4`, not the name).
// The unit lane proves the wiring with a fake process; only a real ffmpeg proves the file.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/exportOwnership.smoke.e2e.ts
import { promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentToolContext } from "../tools/agentStore";
import type { ClientToolContext } from "../tools/context";
import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeFs,
  openE2EDoc,
  probe,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { ensureTimeline } from "./engine";
import { cancelExport, listExportRecords, whenExportEnds, whenExportsSettle } from "./exportQueue";
import { __setStagingBackend } from "./exportStaging";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-ownership-${Date.now()}`);
const LIST = joinPath(ROOT, "export-staging.json");

beforeAll(async () => {
  installE2EDocuments();
  await nodeFs.mkdir(ROOT);
  __setStagingBackend({ fs: nodeFs, root: ROOT });
});
afterAll(async () => {
  __setStagingBackend(null);
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

async function project(name: string, seconds: number): Promise<ClientToolContext> {
  const dir = joinPath(ROOT, name);
  await nodeFs.mkdir(dir);
  await openE2EDoc(dir);
  const ctx = mkCtx(dir);
  await ensureTimeline(ctx.store);
  expect(((await setCanvasTool({ width: 1280, height: 720, fps: 30 }, ctx)) as Rec).ok).toBe(true);
  const src = joinPath(dir, "src.mp4");
  await ff([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=s=1280x720:r=30:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    src,
  ]); // prettier-ignore
  const ref = await libRef(ctx, src, "video");
  const placed = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: seconds * 30 }] },
    ctx,
  )) as Rec;
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  return ctx;
}

async function partials(dir: string): Promise<string[]> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".partial"));
}

/** Start an export the way the agent does, and wait for ffmpeg to start writing it. */
async function agentExport(ctx: ClientToolContext, name: string) {
  const turn = new AbortController();
  const res = (await exportTimelineTool({ name }, agentToolContext(ctx, turn.signal))) as Rec;
  expect(res.ok, JSON.stringify(res)).toBe(true);
  const dest = await ctx.store.exportPath(`${name}.mp4`);
  const destDir = dest.slice(0, Math.max(dest.lastIndexOf("/"), dest.lastIndexOf("\\")));
  const t0 = Date.now();
  while ((await partials(destDir)).length === 0 && Date.now() - t0 < 60_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const staged = await partials(destDir);
  expect(staged, "ffmpeg never started writing").toHaveLength(1);
  return { turn, jobId: String(res.job_id), dest, destDir, partial: staged[0] };
}

const listed = async (): Promise<string[]> =>
  (await nodeFs.exists(LIST))
    ? (JSON.parse(await nodeFs.readTextFile(LIST)) as { staging: { path: string }[] }).staging.map(
        (e) => e.path,
      )
    : [];

describe("an agent's export belongs to the export queue (UJ-022)", () => {
  it("outlives the agent's turn and delivers a real mp4, leaving nothing behind", async () => {
    const ctx = await project("survives", 6);
    const { turn, jobId, dest, destDir, partial } = await agentExport(ctx, "survives");
    expect(partial).toMatch(/^\.survives\.mp4\.[a-z0-9]+\.partial$/);
    expect(await listed(), "recorded for the next launch while it is written").toEqual([
      joinPath(destDir, partial),
    ]);

    turn.abort(); // Stop, the next message, a project switch
    const ended = await whenExportEnds(jobId);
    expect(ended?.state, JSON.stringify(ended)).toBe("done");

    const got = await probe(dest);
    expect(got.width).toBe(1280);
    expect(got.height).toBe(720);
    expect(got.vDurationS).toBeGreaterThan(5.9);
    expect(got.vDurationS).toBeLessThan(6.1);
    expect(got.hasAudio).toBe(true);
    expect(await partials(destDir)).toEqual([]);
    expect(await listed()).toEqual([]);
    await whenExportsSettle();
    const ref = listExportRecords().find((r) => r.job_id === jobId)?.mediaRef;
    expect(ref, "the delivered file is catalogued for inspect_media").toMatch(/^media_/);
  }, 180_000);

  it("is killed by the queue's Cancel at once, leaving neither the file nor a partial", async () => {
    const ctx = await project("cancelled", 120);
    const { jobId, dest, destDir } = await agentExport(ctx, "cancelled");

    const t0 = Date.now();
    expect(cancelExport(jobId)).toBe(true);
    const ended = await whenExportEnds(jobId);
    const took = Date.now() - t0;
    expect(ended?.state, JSON.stringify(ended)).toBe("cancelled");
    // Two minutes of 720p cannot finish in this time: ffmpeg was killed, not waited for.
    expect(took).toBeLessThan(3_000);
    expect(await nodeFs.exists(dest)).toBe(false);
    expect(await partials(destDir)).toEqual([]);
    expect(await listed()).toEqual([]);
  }, 180_000);
});
