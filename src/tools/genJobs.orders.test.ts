import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../observability/sentry", () => ({
  correlationBody: () => ({ project_id: "p1", transcript_id: "t1" }),
  identifyUser: async () => undefined,
}));

import { setClerkTokenProvider } from "../api/auth";
import { callAiProxy, toB64 } from "../api/ai";
import { rateLimitConfig } from "../api/http";
import { __resetOrderPolling, orderPolling } from "../api/orders";
import { clearUsage } from "../api/usage";
import { setPreviewAudioRunner } from "../preview/conformAudio";
import { APP_SESSION } from "../project/jobLedger";
import { __resetJobNotes, pendingJobNotes } from "../store/jobNotes";
import { FakeOrderServer } from "../test/orderServer";
import { resetTestDocuments } from "../test/timelineKit";
import {
  __resetProjectJobs,
  openProjectJobs,
  submitGeneration,
  whenGenerationsSettle,
  type GenerationRunContext,
} from "./genJobs";
import { decodeImages } from "./generationResults";
import { pendingMediaState, registerPendingClip } from "./import";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/proj";
const ID = "0123456789abcdef0123456789abcdef";
const PREVIOUS = "a-previous-launch";

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
    this.files.delete(joinPath(p));
    this.bytes.delete(joinPath(p));
  }
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
]);
const VIDEO = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]);
const PCM = new Uint8Array(48_000); // one second of 24 kHz mono 16-bit silence
const MUSIC = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6]);

const ANSWERS: Record<string, unknown> = {
  generate_image: { result: { ok: true, count: 1 }, media: [{ b64: toB64(PNG), ext: ".png", kind: "image" }] },
  generate_video: { result: { ok: true, count: 1 }, media: [{ b64: toB64(VIDEO), ext: ".mp4", kind: "video" }] },
  voiceover: { result: { ok: true, pcm_b64: toB64(PCM), mime: "audio/l16; rate=24000" } },
  music: { result: { ok: true, audio_b64: toB64(MUSIC), format: "wav", lyrics: "la la" } },
};

let fs: Fs;
let store: ProjectStoreAccess;
let server: FakeOrderServer;
let sleeps: number[];
const realTransientBackoff = rateLimitConfig.transientBackoffS;

const clips = async (): Promise<Any[]> => JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json"))).clips;
const jobs = async (): Promise<Any[]> => JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/jobs.json"))).jobs;

beforeEach(() => {
  clearUsage();
  fs = new Fs();
  store = new ProjectStoreAccess(DIR, fs);
  server = new FakeOrderServer();
  server.behaviour.response = (proxy) => ANSWERS[proxy] ?? ANSWERS.generate_image;
  sleeps = [];
  orderPolling.sleep = async (ms: number) => {
    sleeps.push(ms);
    if (sleeps.length > 300) throw new Error("the test ran out of patience: the code kept asking");
  };
  rateLimitConfig.transientBackoffS = 0.001;
  setClerkTokenProvider(async () => "tok");
  setPreviewAudioRunner(async () => null);
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(async () => {
  __resetProjectJobs();
  __resetJobNotes();
  __resetOrderPolling();
  rateLimitConfig.transientBackoffS = realTransientBackoff;
  setClerkTokenProvider(null);
  clearUsage();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await resetTestDocuments();
});

/** What a generation tool does with the context it is given. */
const imageRun = (ctx: GenerationRunContext) =>
  callAiProxy("generate_image", { args: { prompt: "a van" }, media: {}, order_id: ctx.orderId }, undefined, { onOrder: ctx.orderAccepted }).then(
    (dto) => decodeImages(dto),
  );

const submitImage = (extra: Partial<Parameters<typeof submitGeneration>[0]> = {}) =>
  submitGeneration({
    store,
    tool: "generate_image",
    label: "an image",
    mediaKind: "image",
    count: 1,
    filename: () => "van.png",
    origin: { chatSessionId: "t1", branchId: 0, executionId: 1 } as Any,
    run: imageRun,
    ...extra,
  });

describe("a generation sent as an order", () => {
  it("lands the file, settles the job and confirms receipt, in that order", async () => {
    const seenAtConfirm: { status?: string; size?: number }[] = [];
    server.onAck = () => {
      const [row] = JSON.parse(fs.files.get(joinPath(DIR, "internals/library.json"))!).clips;
      seenAtConfirm.push({ status: row.status, size: row.size_bytes });
    };
    const { media_refs } = await submitImage();
    await whenGenerationsSettle();

    const [row] = await clips();
    expect(row).toMatchObject({ id: media_refs[0] });
    expect(row.status).toBeUndefined();
    expect(await fs.readBytes(joinPath(DIR, `library/${media_refs[0]}.png`))).toEqual(PNG);
    const [job] = await jobs();
    expect(job).toMatchObject({ status: "done", tool: "generate_image", started_by: "chat" });
    expect(job.order_id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect([...server.orders.keys()]).toEqual([job.order_id]);
    expect(server.orders.get(job.order_id)?.state).toBe("collected");
    expect(seenAtConfirm).toEqual([{ status: undefined, size: PNG.length }]);
    expect(pendingJobNotes(DIR).map((n) => [n.status, n.startedBy])).toEqual([["done", "chat"]]);
  });

  it("writes the order number into the ledger BEFORE the paid call goes out", async () => {
    let atCall: Any;
    await submitImage({
      run: async (ctx) => {
        atCall = (await jobs()).find((j) => j.order_id === ctx.orderId);
        return imageRun(ctx);
      },
    });
    await whenGenerationsSettle();
    expect(atCall).toMatchObject({ status: "running", tool: "generate_image", started_by: "chat" });
  });

  it("gives every generation its own order number", async () => {
    await submitImage();
    await submitImage({ filename: () => "van2.png" });
    await whenGenerationsSettle();
    expect(new Set((await jobs()).map((j) => j.order_id)).size).toBe(2);
  });

  it("fails the job with the server's own words when the order failed, and confirms nothing", async () => {
    server.behaviour.outcome = "failed";
    server.behaviour.failure = { code: "provider_refused", message: "Azure refused it.", retryable: false };
    const { media_refs } = await submitImage();
    await whenGenerationsSettle();
    expect((await clips())[0]).toMatchObject({ id: media_refs[0], status: "failed", error: "Azure refused it." });
    expect((await jobs())[0]).toMatchObject({ status: "failed", error: "Azure refused it." });
    expect(server.calls.some((c) => c.includes("/ack"))).toBe(false);
    expect(pendingJobNotes(DIR).map((n) => n.status)).toEqual(["failed"]);
  });

  it("is served as before by a server that answers inline, and confirms nothing", async () => {
    server.behaviour.orders = false;
    await submitImage();
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "done" });
    expect(server.calls.some((c) => c.includes("/orders"))).toBe(false);
  });

  it("does not confirm a result it could not land", async () => {
    const huge = new Uint8Array(PNG); // a PNG header declaring 60000 x 60000: more than any decoder will take
    huge.set([0, 0, 0xea, 0x60], 16);
    huge.set([0, 0, 0xea, 0x60], 20);
    server.behaviour.response = () => ({ result: { ok: true, count: 1 }, media: [{ b64: toB64(huge), ext: ".png" }] });
    await submitImage();
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "failed" });
    expect(server.calls.some((c) => c.includes("/ack"))).toBe(false);
    expect([...server.orders.values()][0].state).toBe("ready");
  });

  it("leaves the job running, and fails nothing, when this build may no longer ask about the order", async () => {
    server.behaviour.pollsUntilDone = 99;
    server.fault(/^GET \/orders/, 1, 426);
    const { media_refs } = await submitImage();
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "running" });
    expect(await pendingMediaState(store, media_refs[0])).toBe("generating");
    expect(pendingJobNotes(DIR)).toEqual([]);
  });
});

describe("how long a generation may take", () => {
  const gate = () => {
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { open, release };
  };

  it("is not limited while the server holds it as an order, however long it takes", async () => {
    vi.useFakeTimers();
    const hold = gate();
    orderPolling.sleep = async () => hold.open;
    server.behaviour.pollsUntilDone = 2;
    const { media_refs } = await submitImage();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000); // three hours
    expect((await jobs())[0]).toMatchObject({ status: "running" });
    expect(await pendingMediaState(store, media_refs[0])).toBe("generating");
    hold.release();
    await vi.advanceTimersByTimeAsync(1);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "done" });
  });

  it("is still limited when the server never got the call and the answer never comes: it asks, hears the server has no such order, and gives up", async () => {
    vi.useFakeTimers();
    server.fault(/^POST \/ai/, 1, "hang");
    await submitImage();
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "failed" });
    expect((await jobs())[0].error).toMatch(/never came back/);
    expect(server.calls.filter((c) => c.startsWith("GET /orders"))).toHaveLength(1); // it asked the server once, and the server said no
    expect(server.orders.size).toBe(0);
    expect(pendingJobNotes(DIR).map((n) => n.status)).toEqual(["failed"]);
  });

  it("does not give up on a call whose answer never came when the server DID take it: it collects the result", async () => {
    vi.useFakeTimers();
    server.fault(/^POST \/ai/, 1, "hang-after");
    const { media_refs } = await submitImage();
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    await whenGenerationsSettle();
    expect(await pendingMediaState(store, media_refs[0])).toBe("ready");
    expect(await fs.readBytes(joinPath(DIR, `library/${media_refs[0]}.png`))).toEqual(PNG);
    const [job] = await jobs();
    expect(job).toMatchObject({ status: "done" });
    expect(job.error).toBeUndefined();
    expect(server.orders.get(job.order_id)?.state).toBe("collected");
    expect(pendingJobNotes(DIR).map((n) => n.status)).toEqual(["done"]);
  });

  // The laptop sleeps, or the connection is lost, right after the submit: its answer is lost, and nothing can reach the server for
  // hours. The clock that gives up on a call that never answers runs out meanwhile, but the server HAS the order, and has charged it.
  it("does not give up on an order the server took when nothing could reach the server for hours", async () => {
    vi.useFakeTimers();
    orderPolling.sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    server.fault(/^POST \/ai/, 1, "lose-answer");
    server.fault(/^GET \/orders/, 400, "drop");
    const { media_refs } = await submitImage();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    await whenGenerationsSettle();
    expect(await pendingMediaState(store, media_refs[0])).toBe("ready");
    const [job] = await jobs();
    expect(job).toMatchObject({ status: "done" });
    expect(job.error).toBeUndefined();
    expect(server.orders.get(job.order_id)?.state).toBe("collected");
    expect(server.calls.filter((c) => c.startsWith("POST /ai/"))).toHaveLength(1); // never sent again
  });

  it("keeps waiting, with the job running, when it is time to give up but the server cannot be reached to ask", async () => {
    vi.useFakeTimers();
    orderPolling.sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    server.fault(/^POST \/ai/, 1, "hang");
    server.fault(/^GET \/orders/, 1000, "drop");
    const { media_refs } = await submitImage();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect((await jobs())[0]).toMatchObject({ status: "running" });
    expect(await pendingMediaState(store, media_refs[0])).toBe("generating");
    expect(pendingJobNotes(DIR)).toEqual([]);
  });

  it("leaves the job running, and fails nothing, when it is time to give up and this build may no longer ask", async () => {
    vi.useFakeTimers();
    server.fault(/^POST \/ai/, 1, "hang");
    server.fault(/^GET \/orders/, 1, 426);
    const { media_refs } = await submitImage();
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "running" });
    expect(await pendingMediaState(store, media_refs[0])).toBe("generating");
    expect(pendingJobNotes(DIR)).toEqual([]);
  });

  it("gives up with the same words on a tool whose results the app could not bring back, without asking the server", async () => {
    vi.useFakeTimers();
    server.fault(/^POST \/ai/, 1, "hang");
    await submitImage({ tool: "some_other_tool", run: imageRun });
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "failed" });
    expect((await jobs())[0].error).toMatch(/never came back/);
    expect(server.calls.some((c) => c.startsWith("GET /orders"))).toBe(false);
  });
});

// ── the app was closed while the server was making it ─────────────────────────────────────────────────────────────────

/** A generation the previous launch started and the app closed on: its placeholders and its ledger row. */
async function closedMidGeneration(
  tool: string,
  opts: { kind?: string; count?: number; startedBy?: "chat" | "elsewhere" | null; filename?: string } = {},
): Promise<string[]> {
  const kind = opts.kind ?? "image";
  const ids = Array.from({ length: opts.count ?? 1 }, (_, i) => `media_gen_old${i}`);
  for (const id of ids) await registerPendingClip(store, { id, filename: opts.filename ?? `old.${kind === "image" ? "png" : "mp4"}`, kind });
  await fs.writeTextFile(
    joinPath(DIR, "internals/jobs.json"),
    JSON.stringify({
      version: 1,
      jobs: [
        {
          id: "job-old",
          kind: "generation",
          tool,
          label: "something",
          status: "running",
          media_refs: ids,
          order_id: ID,
          // `null` leaves it out, as a record written before the field existed would
          ...(opts.startedBy === null ? {} : { started_by: opts.startedBy ?? "chat" }),
          started_at: 1000,
          session: PREVIOUS,
        },
      ],
    }),
  );
  return ids;
}

describe("opening a project's job state", () => {
  /** A placeholder whose file is already on disk while its row still says it is being made. */
  async function landedButNotFlipped(): Promise<void> {
    await registerPendingClip(store, { id: "media_gen_landed", filename: "a.png", kind: "image" });
    await fs.writeBytes(joinPath(DIR, "library/media_gen_landed.png"), PNG);
  }

  it("finishes placeholders whose bytes had landed", async () => {
    await landedButNotFlipped();
    await openProjectJobs(store);
    expect(await pendingMediaState(store, "media_gen_landed")).toBe("ready");
  });

  it("does not do that again when the caller has only just done exactly that", async () => {
    await landedButNotFlipped();
    await openProjectJobs(store, { reconciled: true });
    expect(await pendingMediaState(store, "media_gen_landed")).toBe("generating");
  });

  it("still takes over a generation the server holds, whichever way it is opened", async () => {
    for (const reconciled of [false, true]) {
      __resetProjectJobs();
      fs = new Fs();
      store = new ProjectStoreAccess(DIR, fs);
      server.orders.clear();
      const ids = await closedMidGeneration("generate_image");
      server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
      await openProjectJobs(store, { reconciled });
      await whenGenerationsSettle();
      expect(await pendingMediaState(store, ids[0])).toBe("ready");
    }
  });

  it("is cached for the launch: a second open is the same job state, and settled orders are not asked about again", async () => {
    await closedMidGeneration("generate_image");
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
    const first = await openProjectJobs(store);
    await whenGenerationsSettle();
    server.calls.length = 0;
    expect(await openProjectJobs(store)).toBe(first);
    await whenGenerationsSettle();
    expect(server.calls).toEqual([]);
  });
});

describe("who a generation was started by", () => {
  it("is recorded as someone else when it did not come from this chat, and the chat is not woken for it", async () => {
    await submitImage({ origin: undefined });
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "done", started_by: "elsewhere" });
    expect(pendingJobNotes(DIR)).toEqual([]);
  });
});

describe("coming back after the app was closed", () => {
  it("collects a result the server finished while the app was away, and puts it where the placeholder was", async () => {
    const ids = await closedMidGeneration("generate_image");
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
    await openProjectJobs(store);
    await whenGenerationsSettle();

    expect(await pendingMediaState(store, ids[0])).toBe("ready");
    expect(await fs.readBytes(joinPath(DIR, `library/${ids[0]}.png`))).toEqual(PNG);
    expect((await jobs())[0]).toMatchObject({ id: "job-old", status: "done", media_refs: ids, order_id: ID });
    expect(server.orders.get(ID)?.state).toBe("collected");
    expect(pendingJobNotes(DIR).map((n) => [n.id, n.status, n.startedBy])).toEqual([["job-old", "done", "chat"]]);
  });

  it("goes on waiting for one the server is still making, and collects it when it lands", async () => {
    const ids = await closedMidGeneration("generate_image");
    server.behaviour.pollsUntilDone = 4;
    server.seed(ID, "generate_image", "running", ANSWERS.generate_image);
    await openProjectJobs(store);
    expect((await jobs())[0]).toMatchObject({ status: "running", session: APP_SESSION });
    await whenGenerationsSettle();
    expect(await pendingMediaState(store, ids[0])).toBe("ready");
    expect((await jobs())[0]).toMatchObject({ status: "done" });
  });

  it("waits out a server that is out of reach when the app comes back, and then collects", async () => {
    const ids = await closedMidGeneration("generate_image");
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
    server.fault(/^GET \/orders/, 3, "drop");
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect(await pendingMediaState(store, ids[0])).toBe("ready");
    expect(sleeps.slice(0, 3)).toEqual([2000, 4000, 8000]);
  });

  it("tells the person, and fails the placeholders, when the server failed it", async () => {
    const ids = await closedMidGeneration("generate_image");
    server.behaviour.failure = { code: "provider_refused", message: "Azure refused it.", retryable: false };
    server.seed(ID, "generate_image", "failed");
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect((await clips())[0]).toMatchObject({ id: ids[0], status: "failed", error: "Azure refused it." });
    expect((await jobs())[0]).toMatchObject({ status: "failed", error: "Azure refused it." });
    expect(pendingJobNotes(DIR).map((n) => n.status)).toEqual(["failed"]);
  });

  it("says so, and that it was charged, when the result waited longer than the server keeps it", async () => {
    const ids = await closedMidGeneration("generate_image");
    server.seed(ID, "generate_image", "expired");
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect(await pendingMediaState(store, ids[0])).toBe("failed");
    const [job] = await jobs();
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/seven days/);
    expect(job.error).toMatch(/charged/);
  });

  it("closes the job out the way it always was, with the placeholders failed, when the server has never heard of it", async () => {
    const ids = await closedMidGeneration("generate_image");
    await openProjectJobs(store);
    await whenGenerationsSettle();
    const [job] = await jobs();
    expect(job.status).toBe("interrupted");
    expect(job.error).toMatch(/closed before this finished; it may still have been charged/);
    expect(await pendingMediaState(store, ids[0])).toBe("failed");
    expect(pendingJobNotes(DIR).map((n) => n.status)).toEqual(["failed"]);
  });

  it("finishes the bookkeeping, and only that, when the app stopped after the file landed and before it said so", async () => {
    const ids = await closedMidGeneration("generate_image");
    // the file had landed: the placeholder is already final, and the server still waits to hear
    await fs.writeBytes(joinPath(DIR, `library/${ids[0]}.png`), PNG);
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    delete cat.clips[0].status;
    await fs.writeTextFile(joinPath(DIR, "internals/library.json"), JSON.stringify(cat));
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
    const before = await fs.readBytes(joinPath(DIR, `library/${ids[0]}.png`));
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "done" });
    expect(server.orders.get(ID)?.state).toBe("collected");
    expect(server.calls.some((c) => c.startsWith("GET https://storage.test"))).toBe(false); // nothing was downloaded again
    expect(await fs.readBytes(joinPath(DIR, `library/${ids[0]}.png`))).toBe(before);
  });

  it("does not undo a placeholder that already landed when another one of the same job did not", async () => {
    const ids = await closedMidGeneration("generate_image", { count: 2 });
    await fs.writeBytes(joinPath(DIR, `library/${ids[0]}.png`), PNG);
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    delete cat.clips[0].status;
    await fs.writeTextFile(joinPath(DIR, "internals/library.json"), JSON.stringify(cat));
    server.behaviour.failure = { code: "provider_refused", message: "Refused.", retryable: false };
    server.seed(ID, "generate_image", "failed");
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect(await pendingMediaState(store, ids[0])).toBe("ready");
    expect(await pendingMediaState(store, ids[1])).toBe("failed");
  });

  it("only fills the placeholders that are still empty, and leaves one that already landed exactly as it is", async () => {
    const ids = await closedMidGeneration("generate_image", { count: 2 });
    const earlier = new Uint8Array([...PNG.slice(0, 20), 0, 0, 0, 3, ...PNG.slice(24)]); // what landed before the app closed
    const second = new Uint8Array([...PNG.slice(0, 20), 0, 0, 0, 2, ...PNG.slice(24)]);
    await fs.writeBytes(joinPath(DIR, `library/${ids[0]}.png`), earlier);
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    delete cat.clips[0].status;
    await fs.writeTextFile(joinPath(DIR, "internals/library.json"), JSON.stringify(cat));
    server.seed(ID, "generate_image", "ready", {
      result: { ok: true, count: 2 },
      media: [
        { b64: toB64(PNG), ext: ".png", kind: "image" },
        { b64: toB64(second), ext: ".png", kind: "image" },
      ],
    });
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect(await fs.readBytes(joinPath(DIR, `library/${ids[0]}.png`))).toBe(earlier);
    expect(await fs.readBytes(joinPath(DIR, `library/${ids[1]}.png`))).toEqual(second);
    expect((await jobs())[0]).toMatchObject({ status: "done", media_refs: ids });
    expect(server.orders.get(ID)?.state).toBe("collected");
  });

  it("does not wake the conversation for a failure of something it did not start either", async () => {
    await closedMidGeneration("generate_image", { startedBy: "elsewhere" });
    server.behaviour.failure = { code: "provider_refused", message: "Azure refused it.", retryable: false };
    server.seed(ID, "generate_image", "failed");
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "failed", error: "Azure refused it." });
    expect(pendingJobNotes(DIR)).toEqual([]);
  });

  it("re-muxes a music bed it brings back with the same ffmpeg step the tool uses, when there is an ffmpeg", async () => {
    const REMUXED = new Uint8Array([9, 9, 9, 9]);
    const ran: string[] = [];
    setPreviewAudioRunner(
      async () =>
        ({
          run: async (program: string, args: string[]) => {
            ran.push(program);
            if (program === "ffmpeg") await fs.writeBytes(args[args.length - 1], REMUXED);
            return { code: 0, stdout: "{}", stderr: "" };
          },
        }) as Any,
    );
    await closedMidGeneration("generate_music", { kind: "audio", filename: "x.wav" });
    server.seed(ID, "music", "ready", ANSWERS.music);
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect(ran).toContain("ffmpeg");
    expect(await fs.readBytes(joinPath(DIR, String((await clips())[0].path)))).toEqual(REMUXED);
    expect((await jobs())[0]).toMatchObject({ status: "done" });
  });

  it("does not wake the conversation for something it did not start", async () => {
    await closedMidGeneration("generate_image", { startedBy: "elsewhere" });
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "done" });
    expect(pendingJobNotes(DIR)).toEqual([]);
  });

  it("does not wake the conversation when the record does not say who asked: not knowing is the safe side", async () => {
    await closedMidGeneration("generate_image", { startedBy: null });
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "done" });
    expect(pendingJobNotes(DIR)).toEqual([]);
  });

  it("puts every image of a batch where its own placeholder is", async () => {
    const ids = await closedMidGeneration("generate_image", { count: 2 });
    const second = new Uint8Array([...PNG.slice(0, 20), 0, 0, 0, 2, ...PNG.slice(24)]); // a different image: 1 x 2
    server.seed(ID, "generate_image", "ready", {
      result: { ok: true, count: 2 },
      media: [
        { b64: toB64(PNG), ext: ".png", kind: "image" },
        { b64: toB64(second), ext: ".png", kind: "image" },
      ],
    });
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect(await fs.readBytes(joinPath(DIR, `library/${ids[0]}.png`))).toEqual(PNG);
    expect(await fs.readBytes(joinPath(DIR, `library/${ids[1]}.png`))).toEqual(second);
    expect((await jobs())[0]).toMatchObject({ status: "done", media_refs: ids });
  });

  it("is told which placeholders the provider returned nothing for, as a live generation is", async () => {
    const ids = await closedMidGeneration("generate_image", { count: 2 });
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image); // one image for two placeholders
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect(await pendingMediaState(store, ids[0])).toBe("ready");
    expect(await pendingMediaState(store, ids[1])).toBe("failed");
    const [job] = await jobs();
    expect(job.status).toBe("done");
    expect(job.error).toMatch(/content filter/);
    expect(server.orders.get(ID)?.state).toBe("collected");
  });

  it("leaves a generation that could never have been an order exactly as it was", async () => {
    await registerPendingClip(store, { id: "media_gen_old0", filename: "old.png", kind: "image" });
    await fs.writeTextFile(
      joinPath(DIR, "internals/jobs.json"),
      JSON.stringify({ version: 1, jobs: [{ id: "plain", kind: "generation", tool: "generate_image", label: "x", status: "running", media_refs: ["media_gen_old0"], started_at: 1, session: PREVIOUS }] }),
    );
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "interrupted" });
    expect(server.calls).toEqual([]);
  });

  it("asks about each order once, however often the project is opened", async () => {
    await closedMidGeneration("generate_image");
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
    await Promise.all([openProjectJobs(store), openProjectJobs(store)]);
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect(server.calls.filter((c) => c.startsWith("POST /orders") && c.endsWith("/ack"))).toHaveLength(1);
  });

  it("brings back every kind of generation the same way the tool would have made it", async () => {
    const cases: [string, string, string, (bytes: Uint8Array) => void][] = [
      ["generate_video", "video", "generate_video", (b) => expect(b).toEqual(VIDEO)],
      ["generate_voiceover", "audio", "voiceover", (b) => expect(String.fromCharCode(...b.slice(0, 4))).toBe("RIFF")],
      ["generate_music", "audio", "music", (b) => expect(b).toEqual(MUSIC)],
    ];
    for (const [tool, kind, proxy, check] of cases) {
      __resetProjectJobs();
      fs = new Fs();
      store = new ProjectStoreAccess(DIR, fs);
      const ids = await closedMidGeneration(tool, { kind, filename: kind === "audio" ? "x.wav" : "x.mp4" });
      server.orders.clear();
      server.seed(ID, proxy, "ready", ANSWERS[proxy]);
      await openProjectJobs(store);
      await whenGenerationsSettle();
      expect(await pendingMediaState(store, ids[0])).toBe("ready");
      const row = (await clips())[0];
      check(await fs.readBytes(joinPath(DIR, String(row.path))));
      if (tool === "generate_voiceover") expect(row.source).toMatchObject({ sample_rate: 24000, channels: 1, duration_s: 1 });
      if (tool === "generate_music") expect(row.source).toMatchObject({ lyrics: "la la", sample_rate: 48000 });
      expect((await jobs())[0]).toMatchObject({ status: "done" });
    }
  });

  it("gives up on a result it cannot read, says why, and keeps the order for the support to find", async () => {
    const ids = await closedMidGeneration("generate_image");
    server.seed(ID, "generate_image", "ready", ["not", "a", "result"]);
    await openProjectJobs(store);
    await whenGenerationsSettle();
    expect((await jobs())[0]).toMatchObject({ status: "failed" });
    expect((await jobs())[0].error).toMatch(/could not be (read|brought back)/);
    expect(await pendingMediaState(store, ids[0])).toBe("failed");
    expect(server.orders.get(ID)?.state).toBe("ready");
  });

  it("does nothing about a tool it does not know how to collect for: it says so and never asks the server", async () => {
    await closedMidGeneration("export");
    server.seed(ID, "generate_image", "ready", ANSWERS.generate_image);
    await openProjectJobs(store);
    await whenGenerationsSettle();
    const [job] = await jobs();
    expect(job).toMatchObject({ status: "failed" });
    expect(job.error).toMatch(/cannot be brought back by this version of the app/);
    expect(server.calls).toEqual([]);
    expect(server.orders.get(ID)?.state).toBe("ready");
  });
});
