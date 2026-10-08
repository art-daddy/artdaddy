// The temp sweep on a real disk with a real ffmpeg (4j). A file's and a folder's own time is what
// says nothing is writing it any more, so this checks the times a real filesystem keeps, and what
// a real removal does, rather than a fake's.
// Run: npx vitest run --config vitest.smoke.config.ts src/tools/projectTemps.smoke.e2e.ts
import { existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { transcode } from "../media/transcode";
import { proxyName } from "../preview/proxyPaths";
import { withAssScratch } from "./assScratch";
import type { CommandResult, CommandRunner } from "./command";
import { sweepProjectTemps } from "./projectTemps";
import { joinPath, ProjectStoreAccess } from "./store";
import { TEMP_STALE_MS } from "./tempNames";
import { have, nodeFs, nodeRunner, srcSolid } from "./__e2e";

const proj = joinPath(os.tmpdir(), `artdaddy-temps-${Date.now()}`);
const store = new ProjectStoreAccess(proj, nodeFs);
const FFMPEG = await have("ffmpeg");

beforeAll(async () => {
  await fsp.mkdir(path.join(proj, "src"), { recursive: true });
});
afterAll(async () => {
  await fsp.rm(proj, { recursive: true, force: true }).catch(() => undefined);
});

/** Date a file or folder back, as if nothing had written it for `ms`. */
const quietFor = (p: string, ms: number): Promise<void> => {
  const t = new Date(Date.now() - ms);
  return fsp.utimes(p, t, t);
};

describe("the temp sweep on a real disk", () => {
  it.skipIf(!FFMPEG)(
    "a proxy whose page was lost goes once quiet; the finished proxy beside it stays",
    async () => {
      const src = await srcSolid(path.join(proj, "src", "a.mp4"), { color: "red", dur: 2 });
      // The page dies while ffmpeg runs: ffmpeg finishes its file, and nothing comes back to rename it.
      let ran: Promise<CommandResult> | null = null;
      const lost: CommandRunner = {
        run(program, args, signal, cwd) {
          ran = nodeRunner.run(program, args, signal, cwd);
          return new Promise(() => {});
        },
      };
      const dest = store.artifactPath(`proxies/${proxyName("library/media_0123456789ab.mov")}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      void transcode(store, lost, dest, ["-i", src, "-c:v", "libx264", "-preset", "ultrafast"]);
      await vi.waitFor(() => expect(ran).not.toBeNull());
      expect((await ran!).code).toBe(0);
      const half = (await fsp.readdir(path.dirname(dest))).find((n) => n.includes(".tmp-"))!;
      expect((await fsp.stat(path.join(path.dirname(dest), half))).size).toBeGreaterThan(0);
      await fsp.writeFile(dest, "a whole proxy");

      expect((await sweepProjectTemps(store)).removed).toEqual([]); // just written: maybe still running
      await quietFor(path.join(path.dirname(dest), half), TEMP_STALE_MS + 1000);
      expect((await sweepProjectTemps(store)).removed).toEqual([`internals/cache/proxies/${half}`]);
      expect(await fsp.readdir(path.dirname(dest))).toEqual([path.basename(dest)]);
    },
    60_000,
  );

  it("a caption folder left behind is judged by the folder's own time, and goes whole", async () => {
    let folder = "";
    void withAssScratch(
      { store, runner: nodeRunner },
      [{ name: "a.ass", content: "[Script Info]" }],
      [],
      (cwd) => {
        folder = cwd!;
        return new Promise(() => {});
      },
    );
    await vi.waitFor(() => expect(folder).not.toBe(""));
    expect(existsSync(path.join(folder, "a.ass"))).toBe(true);
    expect((await sweepProjectTemps(store)).removed).toEqual([]);
    await quietFor(folder, TEMP_STALE_MS + 1000);
    expect((await sweepProjectTemps(store)).removed).toEqual([folder.slice(proj.length + 1)]);
    expect(existsSync(folder)).toBe(false);
  });

  it("a project file's temp goes, and the file it was replacing stays", async () => {
    const internals = path.join(proj, "internals");
    await fsp.mkdir(internals, { recursive: true });
    await fsp.writeFile(path.join(internals, "timeline.json"), '{"tracks":[]}');
    await fsp.writeFile(path.join(internals, "timeline.tmp-abc123.json"), '{"tracks":[1]}');
    await quietFor(path.join(internals, "timeline.json"), TEMP_STALE_MS * 10);
    await quietFor(path.join(internals, "timeline.tmp-abc123.json"), TEMP_STALE_MS + 1000);
    expect((await sweepProjectTemps(store)).removed).toEqual([
      "internals/timeline.tmp-abc123.json",
    ]);
    expect(await fsp.readFile(path.join(internals, "timeline.json"), "utf8")).toBe('{"tracks":[]}');
  });
});
