// UJ-022: a partial export left by a crash, a kill or a quit is removed at the next launch. The
// queue removes its own partial when an export settles; these cover what it cannot.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemFs } from "../test/timelineKit";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { APP_SESSION } from "../project/jobLedger";
import {
  __resetExportQueue,
  cancelExport,
  submitExport,
  whenExportEnds,
  whenExportsSettle,
} from "./exportQueue";
import { __setStagingBackend, sweepStaging } from "./exportStaging";

class Fs extends MemFs {
  locked = new Set<string>();
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(joinPath(from));
    if (v === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(joinPath(from));
    this.files.set(joinPath(to), v);
  }
  async remove(p: string): Promise<void> {
    if (this.locked.has(joinPath(p))) throw new Error("EBUSY: in use by another process");
    this.files.delete(joinPath(p));
  }
}

const ROOT = "C:/appdata/ArtDaddy";
const LIST = `${ROOT}/export-staging.json`;
let fs: Fs;

const listed = async (): Promise<string[]> =>
  (await fs.exists(LIST))
    ? (JSON.parse(await fs.readTextFile(LIST)) as { staging: { path: string }[] }).staging.map(
        (e) => e.path,
      )
    : [];

beforeEach(() => {
  fs = new Fs();
  __setStagingBackend({ fs, root: ROOT });
});
afterEach(async () => {
  await whenExportsSettle();
  __resetExportQueue();
  __setStagingBackend(null);
});

describe("partial exports left behind are removed at the next launch", () => {
  it("removes a partial an earlier launch left, and forgets it", async () => {
    const partial = "D:/Videos/.cut.mp4.a1b2c3.partial";
    await fs.writeTextFile(partial, "half a video");
    await fs.writeTextFile(LIST, JSON.stringify({ staging: [{ path: partial, session: "old" }] }));
    expect(await sweepStaging()).toEqual([partial]);
    expect(await fs.exists(partial)).toBe(false);
    expect(await listed()).toEqual([]);
  });

  it("leaves a partial THIS launch is writing", async () => {
    const partial = "D:/Videos/.cut.mp4.d4e5f6.partial";
    await fs.writeTextFile(partial, "being written");
    await fs.writeTextFile(
      LIST,
      JSON.stringify({ staging: [{ path: partial, session: APP_SESSION }] }),
    );
    expect(await sweepStaging()).toEqual([]);
    expect(await fs.exists(partial)).toBe(true);
    expect(await listed()).toEqual([partial]);
  });

  it("keeps a partial it cannot remove yet (still open elsewhere) for the next launch", async () => {
    const partial = "D:/Videos/.cut.mp4.g7h8i9.partial";
    await fs.writeTextFile(partial, "an orphaned ffmpeg still has it open");
    fs.locked.add(partial);
    await fs.writeTextFile(LIST, JSON.stringify({ staging: [{ path: partial, session: "old" }] }));
    expect(await sweepStaging()).toEqual([]);
    expect(await listed()).toEqual([partial]);
  });
});

describe("the queue records each partial while it is being written", () => {
  async function run(outcome: "done" | "failed" | "cancelled") {
    const store = new ProjectStoreAccess("C:/proj", fs);
    const stage = "D:/Videos/.cut.mp4.j1k2l3.partial";
    let seenWhileRunning: string[] = [];
    let release!: () => void;
    const sub = await submitExport({
      store,
      destPath: "D:/Videos/cut.mp4",
      stagePath: stage,
      filename: "cut.mp4",
      run: async (signal) => {
        await fs.writeTextFile(stage, "partial");
        seenWhileRunning = await listed();
        await new Promise<void>((r) => {
          release = r;
          signal.addEventListener("abort", () => r());
        });
        if (outcome === "failed") throw new Error("encoder died");
        return {};
      },
    });
    for (let i = 0; i < 20 && !release; i++) await new Promise((x) => setTimeout(x, 0));
    if (outcome === "cancelled") cancelExport(sub.job_id);
    else release();
    expect((await whenExportEnds(sub.job_id))?.state).toBe(outcome);
    await whenExportsSettle();
    return { seenWhileRunning, stage };
  }

  it.each(["done", "failed", "cancelled"] as const)(
    "listed while encoding, forgotten once it %s",
    async (outcome) => {
      const { seenWhileRunning, stage } = await run(outcome);
      expect(seenWhileRunning).toEqual([stage]);
      expect(await listed()).toEqual([]);
      expect(await fs.exists(stage)).toBe(false);
    },
  );
});
