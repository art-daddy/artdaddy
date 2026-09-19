// The queue's job is to protect the DESTINATION FILE. Every test here is about what is sitting
// on disk at the path the user chose, not about what the tool returned.
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetExportQueue,
  cancelExport,
  isDestinationReserved,
  listExportRecords,
  listExports,
  manageExportsTool,
  submitExport,
  whenExportEnds,
  whenExportsSettle,
  ExportRunError,
} from "./exportQueue";
import { __resetJobNotes, pendingJobNotes } from "../store/jobNotes";
import { __resetProjectJobs } from "../tools/genJobs";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "../tools/store";
import { resetTestDocuments } from "../test/timelineKit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/proj";
const DEST = "C:/out/final.mp4";

/** A chat execution identity, i.e. THIS CHAT asked for the export. Its absence is what the queue
 *  reads as "the Export menu or an external MCP agent asked", and only the former may resume the
 *  conversation. */
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };

class Fs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  renames: [string, string][] = [];
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
    // Text too: the ledger commits jobs.json with an atomic write, which is a text rename.
    if (this.bytes.has(f)) {
      this.bytes.set(t, this.bytes.get(f)!);
      this.bytes.delete(f);
    } else if (this.files.has(f)) {
      this.files.set(t, this.files.get(f)!);
      this.files.delete(f);
    } else {
      throw new Error("ENOENT");
    }
    this.renames.push([f, t]);
  }
}

function make(): { fs: Fs; store: ProjectStoreAccess } {
  const fs = new Fs();
  return { fs, store: new ProjectStoreAccess(DIR, fs) };
}

/** Renames of the deliverable only ΓÇö the ledger commits jobs.json by rename as well. */
const commits = (fs: Fs): [string, string][] =>
  fs.renames.filter(([, to]) => !to.includes("internals/"));

const STAGE = `${DEST}.part-x`;

afterEach(async () => {
  // Reset BEFORE draining: a test that leaves an encode gated would otherwise hang cleanup and
  // poison every test after it.
  __resetExportQueue();
  __resetJobNotes();
  __resetProjectJobs();
  await resetTestDocuments();
});

describe("export queue", () => {
  describe("whenExportEnds", () => {
    // submitExport answers as soon as the render is QUEUED. A caller that reads that as the
    // outcome shows 100% while ffmpeg is still encoding, so this is how a caller waits for the
    // real end without polling.
    it("stays pending while the render is running, then reports how it ended", async () => {
      const { fs, store } = make();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const sub = await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        run: async () => {
          await gate;
          await fs.writeBytes(STAGE, new Uint8Array([1]));
          return {};
        },
      });

      let ended: unknown = "pending";
      void whenExportEnds(sub.job_id).then((r) => (ended = r));
      await Promise.resolve();
      expect(ended, "resolved before the encode finished").toBe("pending");

      release();
      await whenExportsSettle();
      await Promise.resolve();
      expect((ended as { state?: string })?.state).toBe("done");
    });

    it("reports a render that failed, so a caller cannot call it delivered", async () => {
      const { store } = make();
      const sub = await submitExport({
        store,
        destPath: DEST,
        stagePath: STAGE,
        filename: "final.mp4",
        run: async () => {
          throw new Error("no such encoder");
        },
      });
      await whenExportsSettle();
      const ended = await whenExportEnds(sub.job_id);
      expect(ended?.state).toBe("failed");
      expect(ended?.error).toMatch(/no such encoder/);
    });

    it("answers immediately for a job that already ended", async () => {
      const { fs, store } = make();
      const sub = await submitExport({
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
      expect((await whenExportEnds(sub.job_id))?.state).toBe("done");
    });

    it("answers null for a job it does not have, rather than hanging forever", async () => {
      expect(await whenExportEnds("no-such-job")).toBeNull();
    });
  });

  it("returns before the encode has run", async () => {
    const { fs, store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await gate;
        await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3]));
        return {};
      },
    });

    expect(sub.job_id).toBeTruthy();
    expect(await fs.exists(DEST)).toBe(false); // nothing written yet ΓÇö the turn is free
    release();
    await whenExportsSettle();
    expect(await fs.exists(DEST)).toBe(true);
  });

  // The whole reason for staging: a failed export must not replace a good file with a broken one.
  it("leaves a previous export untouched when the encode fails", async () => {
    const { fs, store } = make();
    await fs.writeBytes(DEST, new Uint8Array([9, 9, 9]));
    let ran = false;

    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        ran = true;
        await fs.writeBytes(STAGE, new Uint8Array([1])); // a partial encode
        throw new Error("ffmpeg died");
      },
    });
    await whenExportsSettle();

    expect(ran).toBe(true); // or the rest of this test proves nothing
    expect([...(await fs.readBytes(DEST))]).toEqual([9, 9, 9]); // the OLD file, intact
    expect(await fs.exists(STAGE)).toBe(false); // and no litter left behind
  });

  it("never leaves the half-written file at the destination", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        throw new Error("ffmpeg died");
      },
    });
    await whenExportsSettle();

    expect(await fs.exists(DEST)).toBe(false);
  });

  it("refuses a second export to a destination already queued", async () => {
    const { store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Awaited: the reservation is taken after the ledger write, not synchronously on call.
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await gate;
        return {};
      },
    });

    expect(isDestinationReserved(DEST)).toBe(true);
    expect(isDestinationReserved("c:\\out\\final.mp4")).toBe(true); // same file, other spelling
    expect(isDestinationReserved("C:/out/other.mp4")).toBe(false);

    release();
    await whenExportsSettle();
    expect(isDestinationReserved(DEST)).toBe(false); // and released once it settles
  });

  // The failure ordering the other tests skip: the encode SUCCEEDS and the COMMIT fails. On
  // Windows that is an ordinary Tuesday ΓÇö the user still has the previous export open in a
  // player, so the destination cannot be replaced. Failing here must not destroy the file they
  // are watching, and must not leave a .part in their Downloads folder.
  it("a destination locked by another program fails the job and leaves the old file alone", async () => {
    const { fs, store } = make();
    await fs.writeBytes(DEST, new Uint8Array([9, 9, 9])); // the export they have open
    const realRename = fs.rename.bind(fs);
    fs.rename = async (from: string, to: string) => {
      if (joinPath(to) === joinPath(DEST))
        throw new Error(
          "The process cannot access the file because it is being used by another process. (os error 32)",
        );
      return realRename(from, to);
    };
    let encoded = false;

    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      origin: AGENT,
      run: async () => {
        encoded = true;
        await fs.writeBytes(STAGE, new Uint8Array([1, 2, 3])); // a COMPLETE encode
        return {};
      },
    });
    await whenExportsSettle();

    expect(encoded).toBe(true); // the commit is what failed, not the render
    expect([...(await fs.readBytes(DEST))]).toEqual([9, 9, 9]); // still the file they are watching
    expect(await fs.exists(STAGE)).toBe(false); // no .part litter next to it
    const note = pendingJobNotes(DIR).at(-1) as Any;
    expect(note.status).toBe("failed"); // and it is not reported as a success
    expect(note.error).toContain("another process");
  });

  it("lets the user retry to the same destination after a failed commit", async () => {
    // The reservation is released in a `finally`, so a failure must not permanently burn the
    // filename. Without this the obvious fix ΓÇö close the player, export again ΓÇö would be
    // refused as "already queued" until the app restarted.
    const { fs, store } = make();
    let failNext = true;
    const realRename = fs.rename.bind(fs);
    fs.rename = async (from: string, to: string) => {
      if (failNext && joinPath(to) === joinPath(DEST)) throw new Error("os error 32");
      return realRename(from, to);
    };

    const spec = () => ({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      origin: AGENT,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([7]));
        return {};
      },
    });
    await submitExport(spec());
    await whenExportsSettle();
    expect(await fs.exists(DEST)).toBe(false);
    expect(isDestinationReserved(DEST)).toBe(false); // released, not burned

    failNext = false; // they closed the player
    await submitExport(spec());
    await whenExportsSettle();
    expect([...(await fs.readBytes(DEST))]).toEqual([7]);
    expect((pendingJobNotes(DIR).at(-1) as Any).status).toBe("done");
  });

  it("runs one encode at a time", async () => {
    const { store } = make();
    let live = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const spec = (i: number) => ({
      store,
      destPath: `C:/out/f${i}.mp4`,
      stagePath: `C:/out/f${i}.mp4.part`,
      filename: `f${i}.mp4`,
      run: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => releases.push(r));
        live -= 1;
        return {};
      },
    });
    await submitExport(spec(1));
    await submitExport(spec(2));
    await submitExport(spec(3));
    await new Promise((r) => setTimeout(r, 0));

    expect(releases).toHaveLength(1); // the other two are waiting, not encoding
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await whenExportsSettle();
    expect(peak).toBe(1);
  });

  it("tells the chat where the file went, and why it failed", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      origin: AGENT,
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return { warnings: ["a font was missing"] };
      },
    });
    await whenExportsSettle();
    const ok = pendingJobNotes(DIR).at(-1) as Any;
    expect(ok.status).toBe("done");
    expect(ok.detail).toContain("final.mp4");
    expect(ok.detail).toContain("a font was missing");

    __resetJobNotes();
    await submitExport({
      store,
      destPath: "C:/out/two.mp4",
      stagePath: "C:/out/two.mp4.part",
      filename: "two.mp4",
      origin: AGENT,
      run: async () => {
        throw new Error("ffmpeg died");
      },
    });
    await whenExportsSettle();
    const bad = pendingJobNotes(DIR).at(-1) as Any;
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("ffmpeg died");
  });

  // The Export menu and an external MCP agent run this very tool, so before the queue carried an
  // origin their exports resumed the chat with "background work YOU started ... continue what you
  // were doing" ΓÇö and the woken model then edited a timeline the other driver was editing.
  it("does not resume the chat for an export it did not start", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4", // no origin: the Export menu, or an MCP client
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });
    await whenExportsSettle();

    expect(await fs.exists(DEST)).toBe(true); // the export itself is unaffected
    expect(listExportRecords().at(-1)).toMatchObject({ state: "done" }); // and the UI still sees it
    expect(pendingJobNotes(DIR)).toHaveLength(0); // only the conversation is left alone
  });

  it("does not resume the chat when someone else's export fails either", async () => {
    const { store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        throw new Error("ffmpeg died");
      },
    });
    await whenExportsSettle();

    expect(listExportRecords().at(-1)).toMatchObject({ state: "failed" });
    expect(pendingJobNotes(DIR)).toHaveLength(0);
  });

  it("records the job before the encode, and settles it after", async () => {
    const { fs, store } = make();
    const jobs = async () =>
      JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/jobs.json"))).jobs as Any[];

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await gate;
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        return {};
      },
    });

    // On disk while it is still encoding, so a crash leaves evidence the export was attempted.
    expect((await jobs()).find((j) => j.id === sub.job_id)).toMatchObject({
      kind: "export",
      status: "running",
    });
    release();
    await whenExportsSettle();
    expect((await jobs()).find((j) => j.id === sub.job_id)?.status).toBe("done");
  });

  it("commits by rename rather than rewriting the destination", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([7]));
        return {};
      },
    });
    await whenExportsSettle();
    expect(commits(fs)).toEqual([[joinPath(STAGE), joinPath(DEST)]]);
  });

  it("skips the rename when the caller encoded straight to the destination", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: DEST, // no rename support upstream
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(DEST, new Uint8Array([7]));
        return {};
      },
    });
    await whenExportsSettle();
    expect(commits(fs)).toEqual([]);
    expect(await fs.exists(DEST)).toBe(true);
  });

  // Making the export outlive its turn removed the only way to stop one. These prove the
  // replacement actually stops it, rather than just returning a cheerful boolean.
  it("stops a running encode and leaves no file behind", async () => {
    const { fs, store } = make();
    let sawAbort = false;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));

    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      origin: AGENT,
      run: async (signal) => {
        await fs.writeBytes(STAGE, new Uint8Array([1])); // a partial encode on disk
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        sawAbort = true;
        throw new Error("ffmpeg killed");
      },
    });
    await running;

    expect(cancelExport(sub.job_id)).toBe(true);
    await whenExportsSettle();

    expect(sawAbort).toBe(true); // the signal really reached the encoder
    expect(await fs.exists(DEST)).toBe(false);
    expect(await fs.exists(STAGE)).toBe(false); // and the partial file is cleaned up
    // A cancel the user asked for is not a failure, so no "export failed" note is posted at all —
    // the ledger still records what happened, under its own state.
    expect(pendingJobNotes(DIR).at(-1)).toBeUndefined();
    const row = (((await manageExportsTool({ action: "list" })) as Any).exports as Any[]).find(
      (r) => r.job_id === sub.job_id,
    );
    expect(row?.state).toBe("cancelled");
  });

  it("never starts an encode that was cancelled while queued", async () => {
    const { store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "first.mp4",
      run: async () => {
        await gate;
        return {};
      },
    });
    let secondRan = false;
    const second = await submitExport({
      store,
      destPath: "C:/out/second.mp4",
      stagePath: "C:/out/second.mp4.part",
      filename: "second.mp4",
      run: async () => {
        secondRan = true;
        return {};
      },
    });

    expect(cancelExport(second.job_id)).toBe(true);
    release();
    await whenExportsSettle();

    expect(secondRan).toBe(false); // cancelled before its turn came up
  });

  it("reports nothing to cancel once the export has finished", async () => {
    const { store } = make();
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => ({}),
    });
    await whenExportsSettle();
    expect(cancelExport(sub.job_id)).toBe(false);
    expect(listExports()).toEqual([]);
  });

  it("keeps the queue moving after a failure", async () => {
    const { store } = make();
    let second = false;
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        throw new Error("boom");
      },
    });
    await submitExport({
      store,
      destPath: "C:/out/second.mp4",
      stagePath: "C:/out/second.mp4.part",
      filename: "second.mp4",
      run: async () => {
        second = true;
        return {};
      },
    });
    await whenExportsSettle();
    expect(second).toBe(true);
  });
});

// The tool is the ONLY route to cancellation ΓÇö without it an async export can be started and
// never stopped, which the synchronous version could do.
describe("manage_exports", () => {
  it("lists what is still rendering, and keeps the row once it lands", async () => {
    const { store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await gate;
        return {};
      },
    });

    const listed = (await manageExportsTool({})) as Any;
    expect(listed.ok).toBe(true);
    expect(listed.exports).toEqual([
      { job_id: sub.job_id, filename: "final.mp4", state: "running" },
    ]);

    release();
    await whenExportsSettle();
    // A settled export STAYS listed, with its outcome. This used to assert `[]` ΓÇö which pinned the
    // defect: over MCP nothing wakes a finished turn, so `list` is the only way an agent can learn
    // what happened, and an empty list is indistinguishable from success. A render that died read
    // as a clean run for the whole of one benchmark.
    const after = ((await manageExportsTool({ action: "list" })) as Any).exports as Any[];
    expect(after).toHaveLength(1);
    expect(after[0].job_id).toBe(sub.job_id);
    expect(["done", "failed"]).toContain(after[0].state);
  });

  it("reports a FAILED export's reason through the tool, not just its absence", async () => {
    const { store } = make();
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "boom.mp4",
      run: async () => {
        throw new Error("ffmpeg render failed (code=-28): No space left on device");
      },
    });
    await whenExportsSettle();
    const row = (((await manageExportsTool({ action: "list" })) as Any).exports as Any[]).find(
      (r) => r.job_id === sub.job_id,
    );
    expect(row?.state).toBe("failed");
    expect(String(row?.error)).toContain("code=-28");
  });

  it("cancels a running export through the tool", async () => {
    const { fs, store } = make();
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async (signal) => {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        throw new Error("ffmpeg killed");
      },
    });
    await running;

    const r = (await manageExportsTool({ action: "cancel", job_id: sub.job_id })) as Any;
    expect(r.ok).toBe(true);
    expect(r.cancelled).toBe(true);
    await whenExportsSettle();
    expect(await fs.exists(DEST)).toBe(false); // it really stopped, not just reported so
  });

  // A finished export is not a failure to report ΓÇö the file is on disk.
  it("says plainly that a finished export cannot be cancelled", async () => {
    const { store } = make();
    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => ({}),
    });
    await whenExportsSettle();
    const r = (await manageExportsTool({ action: "cancel", job_id: sub.job_id })) as Any;
    expect(r.ok).toBe(true);
    expect(r.cancelled).toBe(false);
    expect(String(r.note)).toContain("already finished");
  });

  it("refuses a cancel with no job_id, and an unknown action", async () => {
    expect(((await manageExportsTool({ action: "cancel" })) as Any).ok).toBe(false);
    expect(((await manageExportsTool({ action: "pause" })) as Any).ok).toBe(false);
  });

  it("cancelling an id that never existed is refused, not silently claimed", async () => {
    const r = (await manageExportsTool({ action: "cancel", job_id: "nope" })) as Any;
    expect(r.cancelled).toBe(false);
  });

  it("persists ffmpeg diagnostics when validation refuses the staged artifact", async () => {
    const { fs, store } = make();
    await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        throw new ExportRunError(
          "rendered audio failed validation",
          "Non-monotonic DTS; previous: 9223372036854775498",
        );
      },
    });
    await whenExportsSettle();

    expect(await fs.exists(DEST)).toBe(false);
    expect(await fs.exists(STAGE)).toBe(false);
    expect(listExportRecords().at(-1)).toMatchObject({
      state: "failed",
      error: "rendered audio failed validation",
      stderrTail: expect.stringContaining("Non-monotonic DTS"),
    });
    const jobs = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/jobs.json")))
      .jobs as Any[];
    expect(jobs.at(-1)).toMatchObject({
      status: "failed",
      stderr_tail: expect.stringContaining("Non-monotonic DTS"),
    });
  });

  it("does not let cancellation during cleanup hide an established render failure", async () => {
    const { fs, store } = make();
    let cleanupStarted!: () => void;
    let finishCleanup!: () => void;
    const cleaning = new Promise<void>((resolve) => (cleanupStarted = resolve));
    const cleanupGate = new Promise<void>((resolve) => (finishCleanup = resolve));
    const realRemove = fs.remove.bind(fs);
    fs.remove = async (path: string) => {
      if (joinPath(path) === joinPath(STAGE)) {
        cleanupStarted();
        await cleanupGate;
      }
      await realRemove(path);
    };

    const sub = await submitExport({
      store,
      destPath: DEST,
      stagePath: STAGE,
      filename: "final.mp4",
      run: async () => {
        await fs.writeBytes(STAGE, new Uint8Array([1]));
        throw new ExportRunError("render validation failed", "Non-monotonic DTS");
      },
    });
    await cleaning;
    expect(cancelExport(sub.job_id)).toBe(true);
    finishCleanup();
    await whenExportsSettle();

    expect(listExportRecords().at(-1)).toMatchObject({
      state: "failed",
      error: "render validation failed",
      stderrTail: "Non-monotonic DTS",
    });
    const jobs = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/jobs.json")))
      .jobs as Any[];
    expect(jobs.find((j) => j.id === sub.job_id)).toMatchObject({
      status: "failed",
      error: "render validation failed",
      stderr_tail: "Non-monotonic DTS",
    });
  });
});
