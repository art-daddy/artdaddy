// 3h part 7: in the app an export's ffmpeg runs as a job of the app process, so it outlives a crash
// of the page, and the next page commits it exactly as the first would have. These drive the real
// export tool and the real queue against FakeJobs, which keeps the supervisor's rules (its Rust
// twin is tested in src-tauri/src/jobs.rs) and lets a test play the ffmpeg process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { useExportJob } from "../store/exportJob";
import { useAuth } from "../store/auth";

import { JobLedger } from "../project/jobLedger";
import { FakeJobs } from "../test/fakeJobs";
import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { agentToolContext } from "../tools/agentStore";
import type { CommandResult, CommandRunner } from "../tools/command";
import type { ClientToolContext } from "../tools/context";
import { __resetProjectJobs, openProjectJobs } from "../tools/genJobs";
import { registerLibraryClip } from "../tools/import";
import { __resetJobSupervisor, __setJobSupervisor, supervisedRunner } from "../tools/jobSupervisor";
import { joinPath, ProjectStoreAccess } from "../tools/store";
import { ensureTimeline } from "./engine";
import {
  __resetExportQueue,
  adoptExports,
  cancelExport,
  isDestinationReserved,
  listExportRecords,
  localDeliveryPort,
  manageExportsTool,
  submitExport,
  whenExportEnds,
  whenExportTelemetrySettles,
  whenExportsSettle,
} from "./exportQueue";
import { addClipsTool } from "./placement";
import { exportTimelineTool, RENDER_CONTRACT_VERSION } from "./render";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// Recorded rather than discarded: what the export reports about HOW it ended is the point of the
// tests on a recovered export below.
const reported = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../api/exportEvents", () => ({
  reportExport: async (event: Record<string, unknown>) => {
    reported.push(event);
  },
}));
beforeEach(() => {
  reported.length = 0;
  useAuth.setState({ profile: null });
});

class Fs extends MemFs {
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(joinPath(from));
    if (v === undefined) throw new Error(`ENOENT ${from}`);
    this.files.delete(joinPath(from));
    this.files.set(joinPath(to), v);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(joinPath(p));
  }
  async copyFile(from: string, to: string): Promise<void> {
    const value = this.files.get(joinPath(from));
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.set(joinPath(to), value);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.files.get(joinPath(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return new TextEncoder().encode(String(v));
  }
  async probeMedia(p: string, headBytes: number) {
    const bytes = await this.readBytes(p);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      id12: sha256.slice(0, 12),
      sha256,
      size: bytes.length,
      head: bytes.slice(0, headBytes),
    };
  }
}

const DIR = "C:/proj";
const DEST = "C:/Users/test/Downloads/proj.mp4";
const DEST_B = "C:/Users/test/Downloads/b.mp4";
const settle = () => new Promise((r) => setTimeout(r, 0));
async function flush(n = 20) {
  for (let i = 0; i < n; i++) await settle();
}

class StreamingFs extends Fs {
  async appendBytes(file: string, bytes: Uint8Array): Promise<void> {
    const key = joinPath(file);
    this.files.set(key, String(this.files.get(key) ?? "") + new TextDecoder().decode(bytes));
  }
}

async function setup(streaming = false) {
  const fs = streaming ? new StreamingFs() : new Fs();
  const store = new ProjectStoreAccess(DIR, fs);
  registerTestDocument(DIR);
  await ensureTimeline(store);
  // Everything but ffmpeg runs under the page as before (the probes, the checks); an ffmpeg that
  // lands here ran under the page, which is what these tests forbid.
  const ran: string[] = [];
  let jobs: FakeJobs | undefined;
  const runner: CommandRunner = {
    run: async (program, args): Promise<CommandResult> => {
      ran.push(program);
      if (program === "ffprobe") {
        const spec = jobs?.submitted.find((submitted) => submitted.meta.stagePath === args.at(-1));
        const plan = spec?.meta.plan as
          | {
              duration: number;
              audioExpected: boolean;
              output: { width: number; height: number; fps: number };
            }
          | undefined;
        const output = plan?.output ?? { width: 1920, height: 1080, fps: 30 };
        const duration = plan?.duration ?? 2;
        return {
          code: 0,
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                width: output.width,
                height: output.height,
                avg_frame_rate: `${output.fps}/1`,
                nb_read_frames: String(Math.ceil(duration * output.fps)),
                duration: String(duration),
              },
              ...(plan?.audioExpected ? [{ codec_type: "audio", duration: String(duration) }] : []),
            ],
            format: { duration: String(duration) },
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await addClipsTool(
    { entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }] },
    { store, runner },
  );
  jobs = new FakeJobs();
  jobs.delivery = localDeliveryPort(store);
  const prepare = jobs.delivery.prepare.bind(jobs.delivery);
  jobs.delivery.prepare = async (...args) => {
    const delivery = await prepare(...args);
    if (delivery.source?.kind === "copy") jobs!.queueCopy(delivery);
    return delivery;
  };
  const copy = jobs.delivery.copy.bind(jobs.delivery);
  jobs.delivery.copy = (id) => jobs!.runCopy(id, () => copy(id));
  // The process writes its output where it was told: the last argument.
  jobs.onStart = (spec) => fs.writeTextFile(spec.args[spec.args.length - 1], "a whole video");
  __setJobSupervisor(jobs);
  const base: ClientToolContext = { store, runner };
  const exportNow = async (name?: string) =>
    (await exportTimelineTool(
      name ? { name } : {},
      agentToolContext(base, new AbortController().signal),
    )) as Any;
  // A new page: its own store over the same disk, and no memory of the last page.
  const nextPage = () => ({ store: new ProjectStoreAccess(DIR, fs), runner });
  return { fs, store, ran, jobs, exportNow, nextPage };
}

/** What a crash of the page does: its queue, its caches and its event listeners are gone; the app
 *  process, its jobs and the disk are not. */
function pageCrashes(jobs: FakeJobs) {
  jobs.pageDied();
  __resetExportQueue();
  __resetProjectJobs();
}

afterEach(async () => {
  await resetTestDocuments();
  await whenExportsSettle();
  __resetExportQueue();
  __resetProjectJobs();
  __resetJobSupervisor();
  useExportJob.getState().setEngine("file-sequence-v1");
});

async function ledgerStatus(fs: Fs, id: string): Promise<string | undefined> {
  const file = JSON.parse(await fs.readTextFile(`${DIR}/internals/jobs.json`)) as {
    jobs: { id: string; status: string }[];
  };
  return file.jobs.find((j) => j.id === id)?.status;
}

describe("local delivery state after asynchronous identity checks", () => {
  it.each([
    { operation: "verify", action: "cancel", terminal: "cancelled" },
    { operation: "verify", action: "fail", terminal: "failed" },
    { operation: "publish", action: "cancel", terminal: "cancelled" },
    { operation: "publish", action: "fail", terminal: "failed" },
  ] as const)(
    "$action during $operation preserves the destination and terminal state",
    async ({ operation, action, terminal }) => {
      const fs = new Fs();
      const store = new ProjectStoreAccess(DIR, fs);
      const port = localDeliveryPort(store);
      const stage = `${DEST}.partial`;
      const intent = `identity-race-${operation}-${action}`;
      await fs.writeTextFile(stage, "complete staged bytes");
      await fs.writeTextFile(DEST, "previous destination bytes");
      await port.prepare(intent, DIR, stage, DEST, { kind: "render", paths: [] });
      if (operation === "publish") await port.verify(intent);

      let entered!: () => void;
      let release!: () => void;
      const checking = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const probe = store.probeMedia.bind(store);
      vi.spyOn(store, "probeMedia").mockImplementationOnce(async (...args) => {
        const result = await probe(...args);
        entered();
        await gate;
        return result;
      });
      const pending = port[operation](intent);
      try {
        await checking;
        expect(await port[action](intent)).toBe(true);
      } finally {
        release();
      }
      await expect(pending).rejects.toThrow("export intent was cancelled or failed");
      expect((await port.list())[0].state).toBe(terminal);
      expect(await fs.readTextFile(DEST)).toBe("previous destination bytes");
      expect(await fs.readTextFile(stage)).toBe("complete staged bytes");
    },
  );
});

describe("in the app, an export runs as a job of the app process", () => {
  it("retains an opted-in engine across page loss and delivers through the existing owner", async () => {
    const t = await setup();
    useExportJob.getState().setEngine("partition-pipes-v1");
    t.jobs.onStart = (spec) =>
      t.fs.writeTextFile(String(spec.meta.stagePath), "complete streamed video");
    const submitted = await t.exportNow();
    expect(submitted.ok).toBe(true);
    await flush();
    expect(t.jobs.submitted[0].meta).toMatchObject({
      renderTransport: "partition-pipes-v1",
      plan: { transport: "partition-pipes-v1" },
    });
    useExportJob.getState().setEngine("file-sequence-v1");
    pageCrashes(t.jobs);
    t.jobs.exit(submitted.job_id, 0);
    await adoptExports({ contextFor: t.nextPage });
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("complete streamed video");
    expect(await ledgerStatus(t.fs, submitted.job_id)).toBe("done");
    expect(t.jobs.submitted).toHaveLength(1);
    expect(t.ran).not.toContain("ffmpeg");
  });

  it("switches later exports back without changing an already admitted engine", async () => {
    const t = await setup();
    t.jobs.onStart = (spec) =>
      t.fs.writeTextFile(String(spec.meta.stagePath), `complete ${spec.id}`);
    useExportJob.getState().setEngine("partition-pipes-v1");
    const first = await t.exportNow();
    await flush();
    useExportJob.getState().setEngine("file-sequence-v1");
    const second = await t.exportNow("b");
    await flush();
    expect(t.jobs.submitted[0].meta.renderTransport).toBe("partition-pipes-v1");
    expect(t.jobs.submitted[1].meta.renderTransport).toBeUndefined();
    t.jobs.exit(first.job_id, 0);
    await flush();
    t.jobs.exit(second.job_id, 0);
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe(`complete ${first.job_id}`);
    expect(await t.fs.readTextFile(DEST_B)).toBe(`complete ${second.job_id}`);
    expect(await ledgerStatus(t.fs, first.job_id)).toBe("done");
    expect(await ledgerStatus(t.fs, second.job_id)).toBe("done");
  });

  it("refuses streaming without the native owner before replacing any destination", async () => {
    const t = await setup();
    await t.fs.writeTextFile(DEST, "existing destination");
    __setJobSupervisor(null);
    useExportJob.getState().setEngine("partition-pipes-v1");
    const result = await t.exportNow();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("matching native job supervisor");
    expect(await t.fs.readTextFile(DEST)).toBe("existing destination");
    expect(t.jobs.submitted).toEqual([]);
    expect(t.ran).not.toContain("ffmpeg");
  });

  it("runs ffmpeg there, one export at a time, and delivers each in turn", async () => {
    const t = await setup();
    const a = await t.exportNow();
    const b = await t.exportNow("b");
    await flush();
    expect(t.jobs.submitted.map((s) => s.id)).toEqual([a.job_id, b.job_id]);
    expect(t.ran).not.toContain("ffmpeg");
    expect(t.jobs.view(a.job_id)?.state).toBe("running");
    expect(t.jobs.view(b.job_id)?.state).toBe("queued");
    expect(listExportRecords().map((r) => r.state)).toEqual(["running", "queued"]);
    expect(t.jobs.submitted[0].meta).toMatchObject({
      kind: "export",
      projectDir: DIR,
      destPath: DEST,
      filename: "proj.mp4",
    });

    t.jobs.exit(a.job_id, 0);
    const completed = await whenExportEnds(a.job_id);
    expect(completed?.state, completed?.error).toBe("done");
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    await flush();
    expect(t.jobs.view(b.job_id)?.state).toBe("running");
    t.jobs.exit(b.job_id, 0);
    expect((await whenExportEnds(b.job_id))?.state).toBe("done");
    expect(await t.fs.exists(DEST_B)).toBe(true);
    await whenExportsSettle();
    expect(t.jobs.forgotten).toEqual([a.job_id, b.job_id]);
  });

  it("is stopped by Cancel through the app process, leaving nothing behind", async () => {
    const t = await setup();
    const a = await t.exportNow();
    const b = await t.exportNow("b");
    await flush();
    expect(cancelExport(b.job_id)).toBe(true); // queued: it must never start
    expect(cancelExport(a.job_id)).toBe(true); // running: its process is killed
    expect((await whenExportEnds(a.job_id))?.state).toBe("cancelled");
    expect((await whenExportEnds(b.job_id))?.state).toBe("cancelled");
    expect(t.jobs.killed.sort()).toEqual([a.job_id, b.job_id].sort());
    expect(t.jobs.started).toEqual([a.job_id]); // the queued one never started
    expect([...t.fs.files.keys()].some((k) => k.endsWith(".partial"))).toBe(false);
    expect(await t.fs.exists(DEST)).toBe(false);
  });
});

describe("an export outlives a crash of the page", () => {
  it.each([
    { adopted: false, receiptState: "published" },
    { adopted: true, receiptState: "published" },
    { adopted: false, receiptState: "publishing" },
    { adopted: true, receiptState: "publishing" },
  ])(
    "reconciles lost publication acknowledgement during $adopted/$receiptState delivery",
    async ({ adopted, receiptState }) => {
      const t = await setup();
      const submitted = await t.exportNow();
      await flush();
      if (adopted) pageCrashes(t.jobs);
      const port = t.jobs.delivery!;
      const publish = port.publish.bind(port),
        list = port.list.bind(port);
      let acknowledgementLost = false;
      let calls = 0;
      vi.spyOn(port, "publish").mockImplementation(async (...args) => {
        const receipt = await publish(...args);
        calls++;
        if (calls === 1) {
          acknowledgementLost = true;
          throw new Error("native publication acknowledgement unavailable");
        }
        acknowledgementLost = false;
        return receipt;
      });
      vi.spyOn(port, "list").mockImplementation(async () =>
        (await list()).map((receipt) =>
          receipt.id === submitted.job_id && acknowledgementLost && receiptState === "publishing"
            ? { ...receipt, state: "publishing" as const }
            : receipt,
        ),
      );
      t.jobs.exit(submitted.job_id, 0);
      if (adopted) await adoptExports({ contextFor: t.nextPage });
      await whenExportsSettle();
      expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
      const record = listExportRecords().find((entry) => entry.job_id === submitted.job_id);
      expect(record?.state, record?.error).toBe("done");
      expect(record?.mediaRef).toMatch(/^media_/);
      expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(1);
      expect(t.jobs.submitted).toHaveLength(1);
      expect(await ledgerStatus(t.fs, submitted.job_id)).toBe("done");
      expect(
        (await port.list()).find((receipt) => receipt.id === submitted.job_id)?.followups_done,
      ).toBe(true);
    },
  );

  it.each([
    { failure: "publication-unavailable", adopted: false },
    { failure: "publication-unavailable", adopted: true },
    { failure: "destination-replaced", adopted: false },
    { failure: "destination-replaced", adopted: true },
    { failure: "receipt-unavailable", adopted: false },
    { failure: "receipt-unavailable", adopted: true },
  ])(
    "retains native recovery after $failure during $adopted reconciliation",
    async ({ failure, adopted }) => {
      const t = await setup();
      const submitted = await t.exportNow();
      await flush();
      if (adopted) pageCrashes(t.jobs);
      const port = t.jobs.delivery!;
      const publish = port.publish.bind(port);
      const list = port.list.bind(port);
      let attempts = 0;
      let replyLost = false;
      const receipts = vi.spyOn(port, "list").mockImplementation(async () => {
        if (replyLost && failure === "receipt-unavailable")
          throw new Error("delivery receipts are unavailable");
        return list();
      });
      const publication = vi.spyOn(port, "publish").mockImplementation(async (...args) => {
        await publish(...args);
        attempts++;
        replyLost = true;
        if (attempts === 1 && failure === "destination-replaced")
          await t.fs.writeTextFile(DEST, "unrelated destination bytes");
        throw new Error("publication acknowledgement remains unavailable");
      });
      t.jobs.exit(submitted.job_id, 0);
      if (adopted) await adoptExports({ contextFor: t.nextPage });
      await whenExportsSettle();
      receipts.mockRestore();
      expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.state).toBe(
        "failed",
      );
      expect(
        listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef,
      ).toBeUndefined();
      expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(0);
      expect(t.jobs.view(submitted.job_id)).toBeDefined();
      expect(t.jobs.view(submitted.job_id)?.committed).toBe(false);
      expect(
        (await port.list()).find((receipt) => receipt.id === submitted.job_id)?.followups_done,
      ).toBe(false);
      expect(isDestinationReserved(DEST)).toBe(true);
      expect(await t.fs.readTextFile(DEST)).toBe(
        failure === "destination-replaced" ? "unrelated destination bytes" : "a whole video",
      );
      publication.mockRestore();
      if (failure === "destination-replaced") await t.fs.writeTextFile(DEST, "a whole video");
      let retryEntered!: () => void, retryRelease!: () => void;
      const retrying = new Promise<void>((resolve) => {
        retryEntered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        retryRelease = resolve;
      });
      vi.spyOn(port, "publish").mockImplementationOnce(async (...args) => {
        retryEntered();
        await gate;
        return publish(...args);
      });
      await adoptExports({ contextFor: t.nextPage });
      await retrying;
      try {
        expect(
          listExportRecords().find((record) => record.job_id === submitted.job_id),
        ).toMatchObject({ state: "running", error: undefined });
      } finally {
        retryRelease();
      }
      await whenExportsSettle();
      expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.state).toBe(
        "done",
      );
      expect(
        listExportRecords().find((record) => record.job_id === submitted.job_id)?.error,
      ).toBeUndefined();
      expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(1);
      expect(t.jobs.submitted).toHaveLength(1);
      expect(isDestinationReserved(DEST)).toBe(false);
    },
  );

  it.each(["refused", "reply-lost", "persisted-reply-lost"])(
    "retains follow-up recovery when acknowledgement is %s",
    async (failure) => {
      const t = await setup();
      const submitted = await t.exportNow();
      await flush();
      const port = t.jobs.delivery!,
        complete = port.complete.bind(port);
      const acknowledgement = vi.spyOn(port, "complete").mockImplementation(async (...args) => {
        if (failure === "refused") return false;
        if (failure === "persisted-reply-lost") await complete(...args);
        throw new Error("follow-up acknowledgement unavailable");
      });
      t.jobs.exit(submitted.job_id, 0);
      await whenExportsSettle();
      const catalog = await t.fs.readTextFile(`${DIR}/internals/library.json`);
      expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.state).toBe(
        "done",
      );
      expect(t.jobs.view(submitted.job_id)).toBeDefined();
      expect(
        (await port.list()).find((receipt) => receipt.id === submitted.job_id)?.followups_done,
      ).toBe(failure === "persisted-reply-lost");
      acknowledgement.mockRestore();
      await adoptExports({ contextFor: t.nextPage });
      await whenExportsSettle();
      expect(t.jobs.view(submitted.job_id)).toBeUndefined();
      expect(await t.fs.readTextFile(`${DIR}/internals/library.json`)).toBe(catalog);
      expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
      expect(t.jobs.submitted).toHaveLength(1);
    },
  );

  it("preserves the old destination when publication fails before rename", async () => {
    const t = await setup();
    await t.fs.writeTextFile(DEST, "previous successful export");
    const submitted = await submitExport({
      store: t.store,
      supervisor: t.jobs,
      dependencies: [],
      destPath: DEST,
      stagePath: `${DEST}.partial`,
      filename: "proj.mp4",
      run: async () => {
        await t.fs.writeTextFile(`${DEST}.partial`, "new complete video");
        return {};
      },
    });
    vi.spyOn(t.fs, "rename").mockRejectedValue(new Error("destination permission refused"));
    await whenExportsSettle();
    expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.state).toBe(
      "failed",
    );
    expect(await t.fs.readTextFile(DEST)).toBe("previous successful export");
    expect(await t.fs.exists(`${DEST}.partial`)).toBe(false);
    expect(isDestinationReserved(DEST)).toBe(false);
    expect(
      (await t.jobs.delivery!.list()).find((receipt) => receipt.id === submitted.job_id),
    ).toMatchObject({ state: "failed", followups_done: true });
  });

  it("does not cancel a publication that won before its reply was lost", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    const port = t.jobs.delivery!,
      publish = port.publish.bind(port);
    let entered!: () => void, release!: () => void;
    const published = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(port, "publish").mockImplementationOnce(async (...args) => {
      await publish(...args);
      entered();
      await gate;
      throw new Error("published reply lost after cancellation attempt");
    });
    t.jobs.exit(submitted.job_id, 0);
    await published;
    try {
      expect(await manageExportsTool({ action: "cancel", job_id: submitted.job_id })).toMatchObject(
        { ok: true, cancelled: false },
      );
    } finally {
      release();
    }
    await whenExportsSettle();
    expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.state).toBe(
      "done",
    );
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect(t.jobs.killed).toHaveLength(0);
  });

  it.each([false, true])(
    "reconciles a library-copy publication without rendering or duplicating its media ref, persistent=%s",
    async (persistent) => {
      const t = await setup();
      const source = "C:/source/copied.mp4";
      await t.fs.writeTextFile(source, "complete copied video");
      const original = await registerLibraryClip(
        t.store,
        await t.store.readBytes(source),
        "copied.mp4",
        "video",
        { kind: "import" },
        source,
      );
      const port = t.jobs.delivery!,
        publish = port.publish.bind(port);
      let lost = false;
      vi.spyOn(port, "publish").mockImplementation(async (...args) => {
        const receipt = await publish(...args);
        if (!lost || persistent) {
          lost = true;
          throw new Error("copy publication reply lost");
        }
        return receipt;
      });
      const copy = await submitExport({
        store: t.store,
        dependencies: [source],
        destPath: DEST,
        stagePath: `${DEST}.copy.partial`,
        filename: "proj.mp4",
        copyOf: original.id,
        run: async () => {
          throw new Error("library copy must not invoke the renderer");
        },
      });
      await whenExportsSettle();
      if (persistent) {
        expect(t.jobs.view(copy.job_id)?.committed).toBe(false);
        vi.mocked(port.publish).mockRestore();
        await adoptExports({ contextFor: t.nextPage });
        await whenExportsSettle();
      }
      const outcome = listExportRecords().find((record) => record.job_id === copy.job_id);
      expect(outcome, outcome?.error).toMatchObject({ state: "done", mediaRef: original.id });
      expect(await t.fs.readTextFile(DEST)).toBe("complete copied video");
      expect(await t.fs.readTextFile(source)).toBe("complete copied video");
      expect((await t.store.listClips()).filter((clip) => clip.id === original.id)).toHaveLength(1);
      expect(t.jobs.view(copy.job_id)).toBeUndefined();
      expect(t.jobs.submitted).toHaveLength(0);
    },
  );

  it("adopts a running native library copy after page loss without copying it twice", async () => {
    const t = await setup();
    const source = "C:/source/running-copy.wav";
    await t.fs.writeTextFile(source, "source samples must survive");
    const original = await registerLibraryClip(
      t.store,
      await t.store.readBytes(source),
      "running-copy.wav",
      "audio",
      { kind: "import" },
      source,
    );
    const catalog = await t.fs.readTextFile(`${DIR}/internals/library.json`);
    let entered!: () => void, release!: () => void;
    const copying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = t.fs.copyFile.bind(t.fs);
    const writes = vi.spyOn(t.fs, "copyFile").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return write(...args);
    });
    const port = t.jobs.delivery!,
      copy = port.copy.bind(port);
    vi.spyOn(port, "copy").mockImplementationOnce(async (...args) => {
      await copy(...args);
      await new Promise<void>(() => undefined);
    });
    const submitted = await submitExport({
      store: t.store,
      dependencies: [source],
      destPath: DEST,
      stagePath: `${DEST}.copy.partial`,
      filename: "running-copy.wav",
      copyOf: original.id,
      run: async () => {
        throw new Error("copy must not render");
      },
    });
    await copying;
    pageCrashes(t.jobs);
    expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);
    release();
    await whenExportsSettle();
    expect(listExportRecords().find((record) => record.job_id === submitted.job_id)).toMatchObject({
      state: "done",
      mediaRef: original.id,
    });
    expect(await t.fs.readTextFile(DEST)).toBe("source samples must survive");
    expect(await t.fs.readTextFile(source)).toBe("source samples must survive");
    expect(await t.fs.readTextFile(`${DIR}/internals/library.json`)).toBe(catalog);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(t.jobs.submitted).toHaveLength(0);
  });

  it.each([false, true])(
    "starts an admitted copy whose page vanished while it was queued, writeFailure=%s",
    async (writeFailure) => {
      const t = await setup();
      const source = "C:/source/queued-copy.wav";
      await t.fs.writeTextFile(source, "queued copy samples");
      const original = await registerLibraryClip(
        t.store,
        await t.store.readBytes(source),
        "queued-copy.wav",
        "audio",
        { kind: "import" },
        source,
      );
      const catalog = await t.fs.readTextFile(`${DIR}/internals/library.json`);
      const id = await (
        await openProjectJobs(t.store)
      ).begin({ kind: "export", tool: "export", label: "queued copy", session: t.jobs.launch });
      await t.jobs.delivery!.prepare(id, DIR, `${DEST}.queued.partial`, DEST, {
        kind: "copy",
        path: source,
        media_ref: original.id,
      });
      const copy = vi.spyOn(t.jobs.delivery!, "copy");
      if (writeFailure) {
        await t.fs.writeTextFile(DEST, "previous copied output");
        vi.spyOn(t.fs, "copyFile").mockRejectedValueOnce(new Error("copy destination is full"));
      }
      pageCrashes(t.jobs);
      expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);
      try {
        await flush();
        expect(copy).toHaveBeenCalledOnce();
      } finally {
        if (t.jobs.view(id)?.state === "queued") t.jobs.exit(id, -1);
      }
      const outcome = await whenExportEnds(id);
      await whenExportsSettle();
      if (writeFailure) {
        expect(outcome).toMatchObject({ state: "failed", error: "copy destination is full" });
        expect(outcome?.mediaRef).toBeUndefined();
        expect(await t.fs.readTextFile(DEST)).toBe("previous copied output");
      } else {
        expect(outcome, outcome?.error).toMatchObject({ state: "done", mediaRef: original.id });
        expect(await t.fs.readTextFile(DEST)).toBe("queued copy samples");
      }
      expect(await t.fs.readTextFile(source)).toBe("queued copy samples");
      expect(await t.fs.readTextFile(`${DIR}/internals/library.json`)).toBe(catalog);
      expect(t.jobs.submitted).toHaveLength(0);
      expect(t.jobs.view(id)).toBeUndefined();
    },
  );

  it("reports the original native copy failure after the asking page has gone", async () => {
    const t = await setup();
    const source = "C:/source/failed-copy.wav";
    await t.fs.writeTextFile(source, "unchanged source samples");
    await t.fs.writeTextFile(DEST, "previous successful copy");
    const original = await registerLibraryClip(
      t.store,
      await t.store.readBytes(source),
      "failed-copy.wav",
      "audio",
      { kind: "import" },
      source,
    );
    const catalog = await t.fs.readTextFile(`${DIR}/internals/library.json`);
    const id = await (
      await openProjectJobs(t.store)
    ).begin({ kind: "export", tool: "export", label: "failed copy", session: t.jobs.launch });
    await t.jobs.delivery!.prepare(id, DIR, `${DEST}.failed.partial`, DEST, {
      kind: "copy",
      path: source,
      media_ref: original.id,
    });
    vi.spyOn(t.fs, "copyFile").mockRejectedValueOnce(
      new Error("destination volume is full; choose another drive"),
    );
    await expect(t.jobs.delivery!.copy(id)).rejects.toThrow("destination volume is full");
    pageCrashes(t.jobs);
    await adoptExports({ contextFor: t.nextPage });
    const outcome = await whenExportEnds(id);
    await whenExportsSettle();
    expect(outcome).toMatchObject({ state: "failed" });
    expect(outcome?.error).toContain("destination volume is full; choose another drive");
    expect(outcome?.stderrTail).toContain("destination volume is full; choose another drive");
    expect(await t.fs.readTextFile(DEST)).toBe("previous successful copy");
    expect(await t.fs.readTextFile(source)).toBe("unchanged source samples");
    expect(await t.fs.readTextFile(`${DIR}/internals/library.json`)).toBe(catalog);
    expect(await ledgerStatus(t.fs, id)).toBe("failed");
  });

  it.each([
    { code: -1, killed: false, adopted: 1 },
    { code: 0, killed: false, adopted: 0 },
    { code: null, killed: true, adopted: 1 },
  ])(
    "handles native unbound outcomes without inventing a plan, code=$code/killed=$killed",
    async ({ code, killed, adopted }) => {
      const t = await setup();
      await t.fs.writeTextFile(DEST, "previous complete output");
      const id = await (
        await openProjectJobs(t.store)
      ).begin({ kind: "export", tool: "export", label: "unbound export", session: t.jobs.launch });
      const receipt = await t.jobs.delivery!.prepare(id, DIR, `${DEST}.unbound.partial`, DEST, {
        kind: "render",
        paths: [],
      });
      if (killed) await t.jobs.delivery!.cancel(id);
      t.jobs.restoreJob({
        id,
        lane: "export",
        state: "exited",
        code,
        killed,
        committed: false,
        meta: {
          kind: "export",
          projectDir: receipt.project_dir,
          destPath: receipt.dest_path,
          stagePath: receipt.stage_path,
          filename: "proj.mp4",
          startedBy: "elsewhere",
          submittedAt: receipt.created_at,
        },
        stdout_tail: "",
        stderr_head: "export was interrupted before its render plan was retained; export again",
        stderr_elided: 0,
        stderr_tail: "",
        queued_at: receipt.created_at,
        started_at: null,
        ended_at: Date.now(),
      });
      pageCrashes(t.jobs);
      const probes = t.ran.length;
      expect(await adoptExports({ contextFor: t.nextPage })).toBe(adopted);
      await whenExportsSettle();
      if (adopted) {
        const outcome = await whenExportEnds(id);
        expect(outcome?.state).toBe(killed ? "cancelled" : "failed");
        if (!killed)
          expect(outcome?.error).toContain(
            "export was interrupted before its render plan was retained",
          );
        expect(outcome?.mediaRef).toBeUndefined();
      } else {
        expect(t.jobs.view(id)).toBeDefined();
        expect(
          (await t.jobs.delivery!.list()).find((delivery) => delivery.id === id)?.followups_done,
        ).toBe(false);
      }
      expect(await t.fs.readTextFile(DEST)).toBe("previous complete output");
      expect(t.jobs.submitted).toHaveLength(0);
      expect(t.ran.slice(probes)).toHaveLength(0);
    },
  );

  it("refuses export registration without its published receipt identity", async () => {
    const t = await setup();
    await t.fs.writeTextFile(DEST, "a whole video");
    const catalogPath = joinPath(`${DIR}/internals/library.json`);
    const before = t.fs.files.get(catalogPath);
    await expect(
      registerLibraryClip(
        t.store,
        await t.store.readBytes(DEST),
        "proj.mp4",
        "video",
        { kind: "export", job_id: "missing-receipt" },
        DEST,
      ),
    ).rejects.toThrow("published artifact identity");
    expect(t.fs.files.get(catalogPath)).toBe(before);
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
  });

  it("does not reuse an existing library identity whose linked bytes changed", async () => {
    const t = await setup();
    const older = "C:/Users/test/Downloads/older.mp4";
    await t.fs.writeTextFile(older, "a whole video");
    const existing = await registerLibraryClip(
      t.store,
      await t.store.readBytes(older),
      "older.mp4",
      "video",
      { kind: "import" },
      older,
    );
    const before = await t.fs.readTextFile(`${DIR}/internals/library.json`);
    await t.fs.writeTextFile(older, "different linked media");
    const submitted = await t.exportNow();
    await flush();
    t.jobs.exit(submitted.job_id, 0);
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect(await t.fs.readTextFile(`${DIR}/internals/library.json`)).toBe(before);
    expect(
      listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef,
    ).toBeUndefined();
    expect(
      (await t.jobs.delivery!.list()).find((intent) => intent.id === submitted.job_id)
        ?.followups_done,
    ).toBe(false);
    await t.fs.writeTextFile(older, "a whole video");
    await adoptExports({ contextFor: t.nextPage });
    await whenExportsSettle();
    expect(listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef).toBe(
      existing.id,
    );
    expect(await t.fs.readTextFile(`${DIR}/internals/library.json`)).toBe(before);
  });

  it.each([
    { adopted: false, phase: "media-read", streaming: false },
    { adopted: true, phase: "media-read", streaming: false },
    { adopted: false, phase: "catalog-read", streaming: false },
    { adopted: true, phase: "catalog-read", streaming: false },
    { adopted: false, phase: "media-read", streaming: true },
    { adopted: true, phase: "media-read", streaming: true },
    { adopted: false, phase: "catalog-read", streaming: true },
    { adopted: true, phase: "catalog-read", streaming: true },
  ])(
    "never catalogs replacement bytes during $adopted/$phase/$streaming follow-ups",
    async ({ adopted, phase, streaming }) => {
      const t = await setup(streaming);
      const submitted = await t.exportNow();
      await flush();
      if (adopted) pageCrashes(t.jobs);
      const registerStore = adopted ? t.nextPage().store : t.store;
      expect(registerStore.canStreamImport).toBe(streaming);
      const read = registerStore.readBytes.bind(registerStore);
      let replaced = false;
      let registrationRead = false;
      const mediaRead = vi.spyOn(registerStore, "readBytes").mockImplementation(async (file) => {
        if (joinPath(file) === joinPath(DEST)) registrationRead = true;
        if (phase === "media-read" && joinPath(file) === joinPath(DEST) && !replaced) {
          replaced = true;
          await t.fs.writeTextFile(DEST, "unrelated replacement bytes");
        }
        return read(file);
      });
      const probe = registerStore.probeMedia.bind(registerStore);
      let mediaProbe: { mockRestore(): void } | undefined;
      const publish = t.jobs.delivery!.publish.bind(t.jobs.delivery!);
      if (streaming)
        vi.spyOn(t.jobs.delivery!, "publish").mockImplementation(async (...args) => {
          const receipt = await publish(...args);
          mediaProbe = vi
            .spyOn(registerStore, "probeMedia")
            .mockImplementationOnce(async (...probeArgs) => {
              const result = await probe(...probeArgs);
              registrationRead = true;
              if (phase === "media-read") {
                replaced = true;
                await t.fs.writeTextFile(DEST, "unrelated replacement bytes");
              }
              return result;
            });
          return receipt;
        });
      const readJson = registerStore.readJson.bind(registerStore);
      const catalogRead = vi
        .spyOn(registerStore, "readJson")
        .mockImplementation(async <Value>(file: string, fallback: Value) => {
          const result = await readJson<Value>(file, fallback);
          if (
            phase === "catalog-read" &&
            registrationRead &&
            joinPath(file) === joinPath(`${DIR}/internals/library.json`) &&
            !replaced
          ) {
            replaced = true;
            await t.fs.writeTextFile(DEST, "unrelated replacement bytes");
          }
          return result;
        });
      t.jobs.exit(submitted.job_id, 0);
      if (adopted)
        await adoptExports({
          contextFor: () => ({ store: registerStore, runner: t.nextPage().runner }),
        });
      await whenExportsSettle();
      expect(replaced).toBe(true);
      expect(await t.fs.readTextFile(DEST)).toBe("unrelated replacement bytes");
      expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(0);
      expect(
        listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef,
      ).toBeUndefined();
      expect(
        (await t.jobs.delivery!.list()).find((intent) => intent.id === submitted.job_id)
          ?.followups_done,
      ).toBe(false);
      mediaRead.mockRestore();
      mediaProbe?.mockRestore();
      catalogRead.mockRestore();
      await t.fs.writeTextFile(DEST, "a whole video");
      await adoptExports({ contextFor: t.nextPage });
      await whenExportsSettle();
      const clips = (await t.store.listClips()).filter((clip) => clip.path === DEST);
      expect(clips).toHaveLength(1);
      const catalog = await t.store.readJson<{
        clips: Array<{ id: string; source?: { job_id?: string; identity?: unknown } }>;
      }>(`${DIR}/internals/library.json`, { clips: [] });
      const intent = (await t.jobs.delivery!.list()).find(
        (entry) => entry.id === submitted.job_id,
      )!;
      expect(catalog.clips.find((clip) => clip.id === clips[0].id)?.source).toMatchObject({
        job_id: submitted.job_id,
        identity: intent.identity,
      });
      expect(intent.followups_done).toBe(true);
      expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    },
  );

  it("retains the destination reservation until library registration settles", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = t.store.readBytes.bind(t.store);
    vi.spyOn(t.store, "readBytes").mockImplementationOnce(async (file) => {
      entered();
      await gate;
      return read(file);
    });
    t.jobs.exit(submitted.job_id, 0);
    try {
      await waiting;
      await expect(
        submitExport({
          store: t.store,
          destPath: DEST,
          stagePath: `${DEST}.replacement.partial`,
          filename: "proj.mp4",
          dependencies: [],
          run: async () => {
            throw new Error("replacement must not start");
          },
        }),
      ).rejects.toThrow(/already|reserved|exporting/);
      expect(t.jobs.submitted).toHaveLength(1);
      expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    } finally {
      release();
    }
    await whenExportsSettle();
    expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(1);
  });

  it("retains a retry requested while earlier registration is still active", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    let rejectRead!: (reason: Error) => void;
    const pendingRead = new Promise<Uint8Array>((_, reject) => {
      rejectRead = reject;
    });
    const read = vi.spyOn(t.store, "readBytes").mockReturnValue(pendingRead);
    t.jobs.exit(submitted.job_id, 0);
    try {
      await flush();
      expect(read).toHaveBeenCalled();
      expect(await adoptExports({ contextFor: t.nextPage })).toBe(0);
    } finally {
      read.mockRestore();
      rejectRead(new Error("old registration attempt failed after reopen"));
    }
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect(
      listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef,
    ).toMatch(/^media_/);
    expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(1);
  });

  it("adopts pending follow-ups once for the matching project under concurrent requests", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(submitted.job_id, 0);
    await t.jobs.delivery!.verify(submitted.job_id);
    await t.jobs.delivery!.publish(submitted.job_id);
    await t.jobs.commit(submitted.job_id);
    expect(await adoptExports({ projectId: "different-project", contextFor: t.nextPage })).toBe(0);
    const results = await Promise.all([
      adoptExports({ projectId: "proj", contextFor: t.nextPage }),
      adoptExports({ projectId: "proj", contextFor: t.nextPage }),
    ]);
    expect(results.reduce((total, count) => total + count, 0)).toBe(1);
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(1);
    expect(listExportRecords().filter((record) => record.job_id === submitted.job_id)).toHaveLength(
      1,
    );
  });

  it("retries unacknowledged registration while retaining the current page row", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    const read = vi
      .spyOn(t.store, "readBytes")
      .mockRejectedValue(new Error("registration is unavailable"));
    t.jobs.exit(submitted.job_id, 0);
    await whenExportsSettle();
    read.mockRestore();
    const delivered = await t.fs.readTextFile(DEST);
    expect(
      listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef,
    ).toBeUndefined();
    expect(t.jobs.view(submitted.job_id)?.committed).toBe(true);
    expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe(delivered);
    expect(listExportRecords().filter((record) => record.job_id === submitted.job_id)).toHaveLength(
      1,
    );
    expect(
      listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef,
    ).toMatch(/^media_/);
    expect(t.jobs.view(submitted.job_id)).toBeUndefined();
  });

  it("finishes library and ledger follow-ups after native file commit", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(submitted.job_id, 0);
    await t.jobs.delivery!.verify(submitted.job_id);
    await t.jobs.delivery!.publish(submitted.job_id);
    await t.jobs.commit(submitted.job_id);
    const delivered = await t.fs.readTextFile(DEST);
    expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe(delivered);
    expect(await ledgerStatus(t.fs, submitted.job_id)).toBe("done");
    expect(
      listExportRecords().find((record) => record.job_id === submitted.job_id)?.mediaRef,
    ).toMatch(/^media_/);
  });

  it.each([-1, RENDER_CONTRACT_VERSION - 1])(
    "refuses unsupported contract %s even when verified bytes were already moved",
    async (version) => {
      const t = await setup();
      const submitted = await t.exportNow();
      await flush();
      pageCrashes(t.jobs);
      t.jobs.exit(submitted.job_id, 0);
      await t.jobs.delivery!.verify(submitted.job_id);
      await t.fs.rename(t.jobs.submitted[0].args.at(-1)!, DEST);
      const plan = t.jobs.submitted[0].meta.plan as Record<string, unknown>;
      plan.contractVersion = version;
      await adoptExports({ contextFor: t.nextPage });
      const outcome = await whenExportEnds(submitted.job_id);
      expect(outcome?.state).toBe("failed");
      expect(outcome?.error).toContain("unsupported render contract");
      expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    },
  );
  it("refuses malformed output metadata even after native publication", async () => {
    const t = await setup();
    const submitted = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(submitted.job_id, 0);
    await t.jobs.delivery!.verify(submitted.job_id);
    await t.jobs.delivery!.publish(submitted.job_id);
    const plan = t.jobs.submitted[0].meta.plan as { output: { width: number } };
    plan.output.width = 0;
    await adoptExports({ contextFor: t.nextPage });
    await whenExportsSettle();
    const outcome = await whenExportEnds(submitted.job_id);
    expect(outcome?.state).toBe("failed");
    expect(outcome?.error).toContain("supported output contract");
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect((await t.store.listClips()).filter((clip) => clip.path === DEST)).toHaveLength(0);
  });

  it("one that finished while no page was there is committed by the next page", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(a.job_id, 0); // ffmpeg finishes with nobody watching

    expect(await adoptExports({ contextFor: t.nextPage })).toBe(1);
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect([...t.fs.files.keys()].some((k) => k.endsWith(".partial"))).toBe(false);
    expect(await ledgerStatus(t.fs, a.job_id)).toBe("done");
    expect(listExportRecords().find((r) => r.job_id === a.job_id)?.mediaRef).toMatch(/^media_/);
    expect(t.jobs.committed).toEqual([a.job_id]);
    expect(t.jobs.forgotten).toEqual([a.job_id]);
  });

  it("one still running is followed, and committed when it ends", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    await adoptExports({ contextFor: t.nextPage });
    expect(listExportRecords().map((r) => [r.job_id, r.state])).toEqual([[a.job_id, "running"]]);
    t.jobs.exit(a.job_id, 0);
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    expect(await t.fs.exists(DEST)).toBe(true);
  });

  it("one that failed while no page was there reads failed, and its partial goes", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(a.job_id, 1, "Invalid data found when processing input");
    await adoptExports({ contextFor: t.nextPage });
    const ended = await whenExportEnds(a.job_id);
    expect(ended?.state).toBe("failed");
    expect(ended?.error).toMatch(/ffmpeg render failed \(code=1\).*Invalid data/);
    await whenExportsSettle();
    expect(await t.fs.exists(DEST)).toBe(false);
    expect([...t.fs.files.keys()].some((k) => k.endsWith(".partial"))).toBe(false);
    expect(await ledgerStatus(t.fs, a.job_id)).toBe("failed");
  });

  it("one cancelled before the page died reads cancelled, not delivered", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    await t.jobs.kill(a.job_id);
    await flush();
    await adoptExports({ contextFor: t.nextPage });
    expect((await whenExportEnds(a.job_id))?.state).toBe("cancelled");
    await whenExportsSettle();
    expect(await t.fs.exists(DEST)).toBe(false);
    expect(await ledgerStatus(t.fs, a.job_id)).toBe("cancelled");
  });

  it("can be cancelled from the page that adopted it", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    await adoptExports({ contextFor: t.nextPage });
    expect(cancelExport(a.job_id)).toBe(true);
    expect((await whenExportEnds(a.job_id))?.state).toBe("cancelled");
    expect(t.jobs.killed).toEqual([a.job_id]);
  });

  it("does not repeat acknowledged follow-ups when forgetting the job was interrupted", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    vi.spyOn(t.jobs, "forget").mockResolvedValueOnce(false);
    t.jobs.exit(a.job_id, 0);
    await whenExportsSettle();
    expect(listExportRecords().find((record) => record.job_id === a.job_id)?.mediaRef).toMatch(
      /^media_/,
    );
    expect(t.jobs.view(a.job_id)?.committed).toBe(true);
    pageCrashes(t.jobs);
    expect(await adoptExports({ contextFor: t.nextPage })).toBe(0);
    expect(listExportRecords()).toEqual([]);
    expect(t.jobs.forgotten).toEqual([a.job_id]);
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
  });

  it("a verified file the dead page renamed is reconciled by its identity", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    // Renamed into place, and the page died before telling the app process.
    t.jobs.exit(a.job_id, 0);
    await t.jobs.delivery!.verify(a.job_id);
    await t.fs.rename(t.jobs.submitted[0].args.at(-1)!, DEST);
    await adoptExports({ contextFor: t.nextPage });
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    await whenExportsSettle();
    expect(await t.fs.readTextFile(DEST)).toBe("a whole video");
    expect(await ledgerStatus(t.fs, a.job_id)).toBe("done");
  });

  it("keeps its job record alive across the reload, so the ledger does not call it interrupted", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    // The next page reopens the project's ledger while the export still runs.
    const ledger = await JobLedger.open(new ProjectStoreAccess(DIR, t.fs));
    expect(ledger.list().find((r) => r.id === a.job_id)?.status).toBe("running");
    // A different run of the app (a restart) could not have kept it running.
    __setJobSupervisor(new FakeJobs("launch-after-restart"));
    const after = await JobLedger.open(new ProjectStoreAccess(DIR, t.fs));
    expect(after.list().find((r) => r.id === a.job_id)?.status).toBe("interrupted");
  });
});

describe("what an export reports about how it ended when the app was not running for part of it", () => {
  /** What a restart looks like to the export queue: a NEW run of the app process whose journal still
   *  holds the job the old run was working on. The old run's file is on disk, as it was left. */
  async function appRestarts(t: Awaited<ReturnType<typeof setup>>, jobId: string, exit: number) {
    const before = t.jobs.view(jobId)!;
    pageCrashes(t.jobs);
    const restarted = new FakeJobs("launch-after-restart");
    restarted.delivery = t.jobs.delivery;
    restarted.restoreJob({
      ...before,
      state: "exited",
      code: exit,
      stderr_head: exit === 0 ? "" : "ffmpeg died",
      started_at: null,
      ended_at: Date.now(),
    });
    __setJobSupervisor(restarted);
    return restarted;
  }

  it("reports the app process's own run time, apart from the time since the export was submitted", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    t.jobs.exit(a.job_id, 0);
    t.jobs.restoreJob({ ...t.jobs.view(a.job_id)!, started_at: 10_000, ended_at: 70_000 });
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.at(-1)).toMatchObject({ status: "done", recovered: false, active_ms: 60_000 });
  });

  it("an export the app finished after only the PAGE died is not recovered, and still teaches the estimator", async () => {
    const t = await setup();
    useExportJob.setState({ calibrations: [] });
    const a = await t.exportNow();
    await flush();
    pageCrashes(t.jobs);
    t.jobs.exit(a.job_id, 0);
    await adoptExports({ contextFor: t.nextPage });
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.at(-1)).toMatchObject({ status: "done", recovered: false });
    // The control for the next test: this export DOES leave a timing sample, so a missing one
    // below means the recovery was recognised, not that exports never record one.
    expect(useExportJob.getState().calibrations).toHaveLength(1);
  });

  it("an export a LATER LAUNCH of the app finishes is reported as recovered, and its elapsed time teaches the estimator nothing", async () => {
    const t = await setup();
    useExportJob.setState({ calibrations: [] });
    const a = await t.exportNow();
    await flush();
    await appRestarts(t, a.job_id, 0);
    await adoptExports({ contextFor: t.nextPage });
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.at(-1)).toMatchObject({ status: "done", recovered: true });
    // elapsed spans the downtime, so a sample from it would make every later estimate read as days.
    expect(useExportJob.getState().calibrations).toHaveLength(0);
  });

  it("a recovered export that then FAILS is reported as failed AND recovered", async () => {
    const t = await setup();
    const a = await t.exportNow();
    await flush();
    await appRestarts(t, a.job_id, 1);
    await adoptExports({ contextFor: t.nextPage });
    expect((await whenExportEnds(a.job_id))?.state).toBe("failed");
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.at(-1)).toMatchObject({ status: "failed", recovered: true });
  });

  it("an export a later launch finishes is reported under the account that asked for it, not the one signed in then", async () => {
    const person = (id: string) => ({
      user_id: id,
      email: "",
      display_name: "",
      image_url: "",
      metered: true,
    });
    const t = await setup();
    useAuth.setState({ profile: person("user_alice") });
    const a = await t.exportNow();
    await flush();
    useAuth.setState({ profile: person("user_bob") }); // the next launch belongs to somebody else
    await appRestarts(t, a.job_id, 0);
    await adoptExports({ contextFor: t.nextPage });
    expect((await whenExportEnds(a.job_id))?.state).toBe("done");
    await whenExportsSettle();
    await whenExportTelemetrySettles();
    expect(reported.at(-1)).toMatchObject({ status: "done", recovered: true, owner: "user_alice" });
  });
});

describe("the runner that hands ffmpeg to the app process", () => {
  const base = (): CommandRunner & { ran: string[] } => {
    const ran: string[] = [];
    return {
      ran,
      run: async (program) => {
        ran.push(program);
        return { code: 0, stdout: "probe", stderr: "" };
      },
    };
  };
  let jobs: FakeJobs;
  beforeEach(() => {
    jobs = new FakeJobs();
  });

  // The app's ffmpeg rules are applied where the job is started (tauri.ts launchSpec; its test walks
  // every program a job may run), so the export hands over its command as it built it.
  it("hands its first ffmpeg to the app as a job, and runs everything else itself", async () => {
    const b = base();
    const r = supervisedRunner(b, jobs, { id: "j1", lane: "export", meta: {} });
    const args = ["-i", "a.wav", "-c:a", "aac", "-ar", "16000", "out.partial"];
    const done = r.run("ffmpeg", args);
    await flush();
    expect(jobs.submitted.map((s) => [s.program, s.args])).toEqual([["ffmpeg", args]]);
    jobs.exit("j1", 0);
    expect((await done).code).toBe(0);
    await r.run("ffprobe", []);
    await r.run("ffmpeg", []);
    expect([jobs.submitted.length, b.ran]).toEqual([1, ["ffprobe", "ffmpeg"]]);
  });

  it("hands every render step to one native job without executing intermediate ffmpegs on the page", async () => {
    const b = base();
    const r = supervisedRunner(b, jobs, { id: "j1", lane: "export", meta: { kind: "export" } });
    const done = r.runSequence!(
      [
        { args: ["first.nut"], duration: 2 },
        { args: ["second.nut"], duration: 3 },
        { args: ["final.partial"], duration: 5 },
      ],
      undefined,
      "C:/scratch/parts",
    );
    await flush();
    expect(jobs.submitted).toHaveLength(1);
    expect(jobs.submitted[0]).toMatchObject({
      id: "j1",
      args: ["first.nut"],
      steps: [["second.nut"], ["final.partial"]],
      cwd: "C:/scratch/parts",
      meta: { scratch: "C:/scratch/parts" },
    });
    expect(b.ran).toEqual([]);
    jobs.exit("j1", 0);
    expect(await done).toMatchObject({ code: 0 });
  });

  it("forwards progress, carries its scratch dir with the job, and reports how it ended", async () => {
    const r = supervisedRunner(base(), jobs, {
      id: "j1",
      lane: "export",
      meta: { kind: "export" },
    });
    const seen: string[] = [];
    const done = r.run("ffmpeg", ["-i", "x", "o"], undefined, "C:/scratch/caps-1", (c) =>
      seen.push(c),
    );
    await flush();
    expect(jobs.submitted[0].cwd).toBe("C:/scratch/caps-1");
    expect(jobs.submitted[0].meta).toEqual({ kind: "export", scratch: "C:/scratch/caps-1" });
    jobs.stdout("j1", "out_time_ms=1000\n");
    jobs.exit("j1", 3, "No such filter");
    const res = await done;
    expect(seen).toEqual(["out_time_ms=1000\n"]);
    expect(res).toEqual({ code: 3, stdout: "out_time_ms=1000\n", stderr: "No such filter" });
  });

  it("is cancelled by its signal: the job is killed and the run reads cancelled", async () => {
    const r = supervisedRunner(base(), jobs, { id: "j1", lane: "export", meta: {} });
    const stop = new AbortController();
    const done = r.run("ffmpeg", ["-i", "x", "o"], stop.signal);
    await flush();
    stop.abort();
    expect(await done).toMatchObject({ code: -1, stderr: "cancelled" });
    expect(jobs.killed).toEqual(["j1"]);
  });

  it("still kills a job cancelled while it was being handed over", async () => {
    jobs.slowSubmit = true;
    const r = supervisedRunner(base(), jobs, { id: "j1", lane: "export", meta: {} });
    const stop = new AbortController();
    const done = r.run("ffmpeg", ["-i", "x", "o"], stop.signal);
    stop.abort(); // before the supervisor has the job
    expect(await done).toMatchObject({ code: -1, stderr: "cancelled" });
    expect(jobs.killed).toEqual(["j1"]);
  });

  it("leaves everything but the encode on the page's runner", async () => {
    const b = base();
    const r = supervisedRunner(b, jobs, { id: "j1", lane: "export", meta: {} });
    expect((await r.run("ffprobe", ["-i", "o"])).stdout).toBe("probe");
    const enc = r.run("ffmpeg", ["-i", "x", "o"]);
    await flush();
    jobs.exit("j1", 0);
    await enc;
    expect((await r.run("ffmpeg", ["-i", "o", "-f", "null", "-"])).stdout).toBe("probe");
    expect(b.ran).toEqual(["ffprobe", "ffmpeg"]);
    expect(jobs.submitted).toHaveLength(1);
  });
});
