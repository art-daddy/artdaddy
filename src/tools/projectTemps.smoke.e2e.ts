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
import { sweepWork, workRoot } from "./workFolder";
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

  it("a caption folder left behind in the legacy project cache is judged by the folder's own time, and goes whole", async () => {
    const folder = store.artifactPath("renderer/caps-legacy-orphan");
    await fsp.mkdir(path.join(folder, "fonts"), { recursive: true });
    await fsp.writeFile(path.join(folder, "a.ass"), "[Script Info]");
    await fsp.writeFile(path.join(folder, "fonts", "legacy.ttf"), "legacy font");
    expect(existsSync(path.join(folder, "a.ass"))).toBe(true);
    expect((await sweepProjectTemps(store)).removed).toEqual([]);
    await quietFor(folder, TEMP_STALE_MS + 1000);
    expect((await sweepProjectTemps(store)).removed).toEqual([folder.slice(proj.length + 1)]);
    expect(existsSync(folder)).toBe(false);
  });

  it("app-work captions survive same-launch sweeps and a later launch removes the abandoned tree", async () => {
    const root = await workRoot(nodeFs);
    if (!root) throw new Error("the real-disk fixture requires an app work folder");
    expect(root).not.toBe(joinPath(proj));
    expect(root.startsWith(`${joinPath(proj)}/`)).toBe(false);
    const base = joinPath(path.dirname(root));
    const previousLaunch = joinPath(base, "launch-dead-beef");
    let abandoned = "";
    await withAssScratch(
      { store, runner: nodeRunner },
      [{ name: "a.ass", content: "abandoned captions" }],
      [],
      async (cwd) => {
        if (!cwd) throw new Error("caption staging did not create its work folder");
        expect(cwd.startsWith(`${root}/renderer/`)).toBe(true);
        await quietFor(cwd, TEMP_STALE_MS + 1000);
        expect((await sweepProjectTemps(store)).removed).toEqual([]);
        expect(await sweepWork(nodeFs)).toEqual([]);
        expect(await fsp.readFile(path.join(cwd, "a.ass"), "utf8")).toBe("abandoned captions");
        // Replay the real staging bytes under a previous launch's identity.
        abandoned = joinPath(previousLaunch, "renderer", path.basename(cwd));
        await fsp.mkdir(path.dirname(abandoned), { recursive: true });
        await fsp.rename(cwd, abandoned);
      },
    );
    expect(await fsp.readFile(path.join(abandoned, "a.ass"), "utf8")).toBe("abandoned captions");
    const unrelated = joinPath(base, "my-notes");
    await fsp.mkdir(unrelated, { recursive: true });
    await fsp.writeFile(path.join(unrelated, "keep.txt"), "not app scratch");
    const ordinaryFile = joinPath(base, "launch-cafe-babe");
    await fsp.writeFile(ordinaryFile, "not a launch folder");

    let active = "";
    await withAssScratch(
      { store, runner: nodeRunner },
      [{ name: "current.ass", content: "active captions" }],
      [],
      async (cwd) => {
        if (!cwd) throw new Error("caption staging did not create its work folder");
        active = cwd;
        await quietFor(cwd, TEMP_STALE_MS + 1000);
        expect((await sweepProjectTemps(store)).removed).toEqual([]);
        expect(await sweepWork(nodeFs)).toEqual([previousLaunch]);
        expect(existsSync(previousLaunch)).toBe(false);
        expect(await fsp.readFile(path.join(cwd, "current.ass"), "utf8")).toBe("active captions");
        expect(await fsp.readFile(path.join(unrelated, "keep.txt"), "utf8")).toBe(
          "not app scratch",
        );
        expect(await fsp.readFile(ordinaryFile, "utf8")).toBe("not a launch folder");
        expect(await sweepWork(nodeFs)).toEqual([]);
      },
    );
    expect(existsSync(active)).toBe(false);
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
