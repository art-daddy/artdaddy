// S3b with the real ffmpeg and the real disk: a person whose drive has no room for the video chooses another folder,
// and the video appears THERE, a real mp4 that plays; nothing is left at the folder that had no room. The unit tests
// prove the request is sent to the folder; this proves the file is where they chose, which is what they asked for.
//
// The only thing stood in for is the native free-space reading of the first folder (it says there is almost none): the
// reading itself is the app process's own, measured by its own tests. The question, the tool, the queue, the render,
// the rename into place and the file system are all real.
//   npx vitest run --config vitest.smoke.config.ts src/timeline/exportSaveTo.smoke.e2e.ts
import { execFileSync } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as host from "../platform/host";
import {
  __resetExportQuestions,
  answerQuestion,
  chooseQuestionFolder,
  mountQuestionHost,
  useExportQuestions,
} from "../store/exportQuestionHost";
import { useExportJob } from "../store/exportJob";
import type { ClientToolContext } from "../tools/context";
import {
  ff,
  installE2EDocuments,
  libRef,
  mkCtx,
  nodeRunner,
  openE2EDoc,
  probe,
  resetE2EDocuments,
} from "../tools/__e2e";
import { joinPath } from "../tools/store";
import { ensureTimeline } from "./engine";
import {
  __resetExportQueue,
  isDestinationReserved,
  listExportRecords,
  whenExportEnds,
  whenExportsSettle,
  whenExportTelemetrySettles,
} from "./exportQueue";
import { exportTool } from "./exportItems";
import { setCanvasTool } from "./ops";
import { addClipsTool } from "./placement";

type Rec = Record<string, unknown>;

const ROOT = joinPath(os.tmpdir(), `artdaddy-saveto-${Date.now()}`);
const FIRST = joinPath(ROOT, "first");
const SECOND = joinPath(ROOT, "second");
const FRAMES = 120; // four seconds at 30 fps
const GB = 1024 ** 3;

let unmountHost: () => void = () => undefined;
let realFree = 100 * GB;

beforeAll(async () => {
  installE2EDocuments();
  await fsp.mkdir(FIRST, { recursive: true });
  await fsp.mkdir(SECOND, { recursive: true });
  const stats = await fsp.statfs(ROOT);
  realFree = Number(stats.bavail) * Number(stats.bsize);
  // The first folder says it has almost no room; every other place has what the disk really has.
  vi.spyOn(host, "resolveExportResources").mockImplementation(async (destination: string) => ({
    total_memory_bytes: 16 * GB,
    available_memory_bytes: 12 * GB,
    scratch_free_bytes: realFree,
    destination_free_bytes: destination.replace(/\\/g, "/").startsWith(FIRST) ? 100 : realFree,
    budgets: { memoryBytes: 8 * GB, temporaryBytes: 18 * GB, executionSeconds: 28_800 },
  }));
});
afterEach(async () => {
  await whenExportsSettle();
  unmountHost();
  unmountHost = () => undefined;
  __resetExportQuestions();
  __resetExportQueue();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await resetE2EDocuments();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => undefined);
});

/** A project of one real clip, and a context on the real disk and the real ffmpeg. */
async function project(name: string): Promise<ClientToolContext> {
  const dir = joinPath(ROOT, name);
  await fsp.mkdir(dir, { recursive: true });
  await openE2EDoc(dir);
  const ctx = mkCtx(dir);
  await ensureTimeline(ctx.store);
  expect(((await setCanvasTool({ width: 640, height: 360, fps: 30 }, ctx)) as Rec).ok).toBe(true);
  const src = joinPath(dir, "src.mp4");
  await ff([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    src,
  ]); // prettier-ignore
  const ref = await libRef(ctx, src, "video");
  const placed = (await addClipsTool(
    { entries: [{ media_ref: ref, timeline_in: 0, timeline_out: FRAMES }] },
    ctx,
  )) as Rec;
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  return ctx;
}

/** Export once for nothing but what it teaches the app about this project (how big its file is), so the next export
 *  of it can be judged against a drive's room. Written to its own folder, which the later checks never look at. */
async function learnSize(ctx: ClientToolContext): Promise<void> {
  const warm = joinPath(ROOT, "warmup");
  await fsp.mkdir(warm, { recursive: true });
  const res = (await exportTool(
    { name: "warm", output_path: joinPath(warm, "warm.mp4") },
    ctx,
  )) as Rec;
  expect(res.ok, JSON.stringify(res)).toBe(true);
  const ended = await whenExportEnds(String(res.job_id));
  expect(ended?.state, JSON.stringify(ended)).toBe("done");
  // What the export taught the app is written once its report is, after the file is in place.
  await whenExportsSettle();
  await whenExportTelemetrySettles();
  const known = useExportJob.getState().calibrations;
  expect(known.length).toBeGreaterThan(0);
  // A native run reports its temporary space; this one has no native process, so it is none.
  useExportJob.setState({
    calibrations: known.map((sample) => ({ ...sample, temporaryBytes: 0 })),
  });
  __resetExportQueue();
}

const asked = () => useExportQuestions.getState().open;
const names = async (dir: string): Promise<string[]> => (await fsp.readdir(dir)).sort();

/** The person picks a folder and presses Continue, and the request runs to its end. The same question coming back (the
 *  request was not sent to the folder) is a failure of the feature, reported at once instead of waiting for a timeout. */
async function chooseAndFinish(
  request: Promise<unknown>,
  folder: string,
  by: "dialog" | "card" = "dialog",
): Promise<Rec> {
  const open = asked()!;
  expect(chooseQuestionFolder(open.id, folder)).toBe(true);
  expect(answerQuestion(open.id, "continue", by)).toBe("accepted");
  let finished = false;
  const watched = request.finally(() => (finished = true));
  await vi.waitFor(() => expect(finished || asked() !== null).toBe(true), { timeout: 120_000 });
  expect(asked(), "the same question came back: the request was not sent to the folder").toBeNull();
  return (await watched) as Rec;
}

describe("saving the video somewhere else when the drive has no room", () => {
  it("puts a real, playable mp4 in the folder the person chose, and leaves nothing at the one with no room", async () => {
    const ctx = await project("proj-moved");
    await learnSize(ctx);
    unmountHost = mountQuestionHost();

    // The person asks for the video in the folder with no room.
    const request = exportTool({ name: "reel", output_path: joinPath(FIRST, "reel.mp4") }, ctx);
    await vi.waitFor(() => expect(asked()).not.toBeNull(), { timeout: 60_000 });
    const open = asked()!;
    expect(open.question.kind).toBe("output_space");
    expect(open.question.folderBox).toBe("save_to");
    expect(open.folder?.now).toBe(FIRST);
    // Nothing has been written, reserved or queued while the question is open.
    expect(await names(FIRST)).toEqual([]);
    expect(isDestinationReserved(joinPath(FIRST, "reel.mp4"))).toBe(false);
    expect(listExportRecords()).toHaveLength(0);

    // They choose another folder and press Continue.
    const res = await chooseAndFinish(request, SECOND);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.saved_to).toBe("reel.mp4");
    // The assistant is told the person chose, not where.
    expect(JSON.stringify(res)).not.toContain("second");
    const ended = await whenExportEnds(String(res.job_id));
    expect(ended?.state, JSON.stringify(ended)).toBe("done");
    expect(ended?.destPath).toBe(joinPath(SECOND, "reel.mp4"));

    // THE OUTCOME: the file is in the folder they chose and it is a whole video; the other folder is untouched.
    expect(await names(SECOND)).toEqual(["reel.mp4"]);
    expect(await names(FIRST)).toEqual([]);
    const made = await probe(joinPath(SECOND, "reel.mp4"));
    expect(made.width).toBe(640);
    expect(made.height).toBe(360);
    expect(made.hasAudio).toBe(true);
    expect(made.vDurationS).toBeGreaterThan(3.9);
    const counted = await nodeRunner.run("ffprobe", [
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", joinPath(SECOND, "reel.mp4"),
    ]); // prettier-ignore
    expect(Number(counted.stdout.trim())).toBe(FRAMES);
    // The destination that had no room was never held.
    expect(isDestinationReserved(joinPath(FIRST, "reel.mp4"))).toBe(false);
  }, 300_000);

  it("never overwrites a file that is already in the folder they chose", async () => {
    const ctx = await project("proj-numbered");
    await learnSize(ctx);
    unmountHost = mountQuestionHost();
    const theirs = joinPath(SECOND, "mine.mp4");
    await fsp.writeFile(theirs, "THEIR FILE, NOT A VIDEO");

    const request = exportTool({ name: "mine", output_path: joinPath(FIRST, "mine.mp4") }, ctx);
    await vi.waitFor(() => expect(asked()).not.toBeNull(), { timeout: 60_000 });
    const res = await chooseAndFinish(request, SECOND, "card");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect((await whenExportEnds(String(res.job_id)))?.state).toBe("done");

    expect(await fsp.readFile(theirs, "utf8")).toBe("THEIR FILE, NOT A VIDEO");
    expect(res.saved_to).toBe("mine 2.mp4");
    expect((await probe(joinPath(SECOND, "mine 2.mp4"))).width).toBe(640);
  }, 300_000);

  it("keeps the exact name the person gave the file, dots and all", async () => {
    const ctx = await project("proj-dotted");
    await learnSize(ctx);
    unmountHost = mountQuestionHost();
    const named = "Interview 2024.10.05 v1.2";
    const request = exportTool({ name: "x", output_path: joinPath(FIRST, `${named}.mp4`) }, ctx);
    await vi.waitFor(() => expect(asked()).not.toBeNull(), { timeout: 60_000 });
    const target = joinPath(ROOT, "dotted");
    await fsp.mkdir(target, { recursive: true });
    const res = await chooseAndFinish(request, target);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect((await whenExportEnds(String(res.job_id)))?.state).toBe("done");
    expect(await names(target)).toEqual([`${named}.mp4`]);
    expect((await probe(joinPath(target, `${named}.mp4`))).width).toBe(640);
  }, 300_000);

  // A person who picks an external drive picks its ROOT. `subst` makes a drive letter of a folder (no administrator
  // needed), so the root of a real drive path is exercised on the real disk.
  it.skipIf(process.platform !== "win32")(
    "saves at the root of a drive, the folder a person who picks a whole drive chooses",
    async () => {
      const letter = [..."ZYXWVUTSRQPON"].find((l) => !existsSync(`${l}:\\`));
      if (!letter) throw new Error("no free drive letter for the test");
      const target = joinPath(ROOT, "driveroot");
      await fsp.mkdir(target, { recursive: true });
      execFileSync("subst", [`${letter}:`, target.replace(/\//g, "\\")]);
      try {
        const ctx = await project("proj-root");
        await learnSize(ctx);
        unmountHost = mountQuestionHost();
        const request = exportTool({ name: "reel", output_path: joinPath(FIRST, "reel.mp4") }, ctx);
        await vi.waitFor(() => expect(asked()).not.toBeNull(), { timeout: 60_000 });
        const res = await chooseAndFinish(request, `${letter}:\\`);
        expect(res.ok, JSON.stringify(res)).toBe(true);
        const ended = await whenExportEnds(String(res.job_id));
        expect(ended?.state, JSON.stringify(ended)).toBe("done");
        expect(ended?.destPath).toBe(`${letter}:/reel.mp4`);
        // The file is at the root of that drive, which is where the real folder is.
        expect(await names(target)).toEqual(["reel.mp4"]);
        expect((await probe(joinPath(target, "reel.mp4"))).width).toBe(640);
      } finally {
        execFileSync("subst", [`${letter}:`, "/d"]);
      }
    },
    300_000,
  );

  it("refuses cleanly, and leaves nothing behind anywhere, when the folder they chose cannot be made", async () => {
    const ctx = await project("proj-bad");
    await learnSize(ctx);
    unmountHost = mountQuestionHost();
    const blocker = joinPath(ROOT, "blocker.txt");
    await fsp.writeFile(blocker, "a file where a folder was wanted");
    const before = { first: await names(FIRST), second: await names(SECOND) };

    const request = exportTool({ name: "bad", output_path: joinPath(FIRST, "bad.mp4") }, ctx);
    await vi.waitFor(() => expect(asked()).not.toBeNull(), { timeout: 60_000 });
    const res = await chooseAndFinish(request, joinPath(blocker, "sub"));

    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/folder/i);
    expect(await names(FIRST)).toEqual(before.first);
    expect(await names(SECOND)).toEqual(before.second);
    expect(listExportRecords()).toHaveLength(0);
    expect(isDestinationReserved(joinPath(FIRST, "bad.mp4"))).toBe(false);
    expect(asked()).toBeNull();
  }, 300_000);
});
