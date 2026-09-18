// The export metric. Rendering never touches the server, so this beacon is the ONLY evidence
// an export happened — which means the interesting questions are whether it fires for the
// outcomes nobody wants to look at (failed, cancelled), and whether it can damage the export
// it is describing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reportExport = vi.hoisted(() => vi.fn(async (_ev: Record<string, unknown>) => undefined));
vi.mock("../api/exportEvents", () => ({ reportExport }));

import {
  __resetExportQueue,
  cancelExport,
  submitExport,
  whenExportsSettle,
  whenExportTelemetrySettles,
  ExportRunError,
} from "./exportQueue";
import { __resetJobNotes } from "../store/jobNotes";
import { __resetProjectJobs } from "../tools/genJobs";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "../tools/store";
import { resetTestDocuments } from "../test/timelineKit";

const DIR = "C:/proj";
const DEST = "C:/out/final.mp4";
const STAGE = `${DEST}.part-x`;

/** Carries `stat`, so a delivered file has a real size to report. */
class Fs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.files.has(n) || this.bytes.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.bytes.get(joinPath(p));
    if (!v) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async readDir(): Promise<DirEntry[]> {
    return [];
  }
  async mkdir(): Promise<void> {}
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.files.delete(n);
    this.bytes.delete(n);
  }
  async rename(from: string, to: string): Promise<void> {
    const f = joinPath(from);
    const t = joinPath(to);
    if (this.bytes.has(f)) {
      this.bytes.set(t, this.bytes.get(f)!);
      this.bytes.delete(f);
    } else if (this.files.has(f)) {
      this.files.set(t, this.files.get(f)!);
      this.files.delete(f);
    } else {
      throw new Error("ENOENT");
    }
  }
  async stat(p: string): Promise<{ size: number; isDirectory: boolean }> {
    const n = joinPath(p);
    const b = this.bytes.get(n);
    if (b) return { size: b.byteLength, isDirectory: false };
    const t = this.files.get(n);
    if (t !== undefined) return { size: t.length, isDirectory: false };
    throw new Error("ENOENT");
  }
}

const META = {
  duration_s: 49.5,
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "high",
  project_id: "odyssey_ii",
};

function make() {
  const fs = new Fs();
  return { fs, store: new ProjectStoreAccess(DIR, fs) };
}

/** The single argument the beacon was called with. */
const sent = () => reportExport.mock.calls[0]?.[0];

beforeEach(() => reportExport.mockClear());
afterEach(async () => {
  __resetExportQueue();
  __resetJobNotes();
  __resetProjectJobs();
  await resetTestDocuments();
});

describe("the export metric", () => {
  it("reports a delivered export with what was actually produced", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta: META,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array(1234));
        return {};
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();

    expect(reportExport).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({
      status: "done",
      duration_s: 49.5,
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "high",
      project_id: "odyssey_ii",
      warnings: 0,
      error: "",
    });
    // Measured from the DELIVERED file, not from anything the caller declared.
    expect(sent()!.size_bytes).toBe(1234);
    expect(sent()!.elapsed_ms).toEqual(expect.any(Number));
  });

  // A metric that only counted successes could not answer whether the renderer works, which
  // is the only thing anyone would build it for.
  it("reports a failed encode, with the reason", async () => {
    const { store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta: META,
      run: async () => {
        throw new ExportRunError("ffmpeg died", "stderr tail");
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();

    expect(sent()).toMatchObject({ status: "failed", error: "ffmpeg died" });
    // Nothing was delivered, so there is nothing to have a size.
    expect(sent()!.size_bytes).toBe(0);
    // The planned artifact is still described: "what were they trying to make when it broke"
    // is the whole question a failure row exists to answer.
    expect(sent()).toMatchObject({ duration_s: 49.5, width: 1920 });
  });

  it("reports an export the user cancelled, rather than dropping it", async () => {
    const { store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta: META,
      run: async (signal) => {
        await gate;
        if (signal.aborted) throw new Error("ffmpeg killed");
        return {};
      },
    });
    await cancelExport(sub.job_id);
    release();
    await whenExportsSettle();
    await whenExportTelemetrySettles();

    expect(sent()).toMatchObject({ status: "cancelled" });
    // A cancellation is not a renderer failure, so it must not arrive carrying one — a
    // success rate computed over these would otherwise blame the renderer for a click.
    expect(sent()!.error).toBe("");
  });

  // The export is finished and the file is the user's before this runs. Telemetry that could
  // undo, delay or fail it would be strictly worse than no telemetry.
  it("cannot damage the export it is describing", async () => {
    reportExport.mockRejectedValueOnce(new Error("network down"));
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta: META,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await expect(whenExportsSettle()).resolves.toBeUndefined();
    expect(await fs.exists(DEST), "the deliverable is still committed").toBe(true);
  });

  it("says nothing until the render has actually settled", async () => {
    const { fs, store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta: META,
      run: async () => {
        await gate;
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await Promise.resolve();
    // Reporting here would describe an encode that had not happened, with a size of 0 and
    // an outcome nobody knows yet.
    expect(reportExport).not.toHaveBeenCalled();
    release();
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reportExport).toHaveBeenCalledTimes(1);
  });

  it("sends one row per export, not one per state change", async () => {
    const { fs, store } = make();
    for (const n of [1, 2]) {
      await submitExport({
        store,
        destPath: `C:/out/f${n}.mp4`,
        stagePath: `C:/out/f${n}.mp4.part-x`,
        filename: `f${n}.mp4`,
        meta: META,
        run: async () => {
          await fs.writeBytes(`C:/out/f${n}.mp4.part-x`, new Uint8Array([1]));
          return {};
        },
      });
    }
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reportExport).toHaveBeenCalledTimes(2);
  });

  // The queue is the one place every door ends up — Export menu, built-in agent and an
  // external MCP client all arrive through submitExport — so an export with no chat behind
  // it must still be counted.
  it("counts an export nobody asked for in chat", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      meta: META,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(sent()).toMatchObject({ status: "done" });
  });

  it("still reports when the caller gave no metadata at all", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(sent()).toMatchObject({ status: "done", duration_s: 0, width: 0, quality: "" });
  });
});
