import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetProjectJobs,
  openProjectJobs,
  submitGeneration,
  whenGenerationsSettle,
} from "./genJobs";
import { clearUsage, markOverLimit } from "../api/usage";
import { reconcilePendingMedia } from "./import";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "./store";
import { resetTestDocuments } from "../test/timelineKit";
import { APP_SESSION } from "../project/jobLedger";
import { __resetJobNotes, pendingJobNotes, type SettledJob } from "../store/jobNotes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/proj";

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
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0,
]);

const clips = async (fs: Fs): Promise<Any[]> =>
  JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json"))).clips;
const jobs = async (fs: Fs): Promise<Any[]> =>
  JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/jobs.json"))).jobs;

function make(): { fs: Fs; store: ProjectStoreAccess } {
  const fs = new Fs();
  return { fs, store: new ProjectStoreAccess(DIR, fs) };
}

/** A chat execution identity: THIS CHAT asked for the generation. Only that resumes the chat. */
const AGENT = { chatSessionId: "t1", branchId: 0, executionId: 1 };

afterEach(async () => {
  __resetProjectJobs();
  __resetJobNotes();
  await resetTestDocuments();
});

describe("async generation", () => {
  it("returns a placeholder BEFORE the paid call resolves", async () => {
    const { fs, store } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const out = await submitGeneration({
      store,
      tool: "generate_image",
      label: "an image",
      mediaKind: "image",
      count: 1,
      filename: () => "a.png",
      run: async () => {
        await gate;
        return [{ bytes: PNG }];
      },
    });

    // The call has NOT finished, yet the agent already has a usable id.
    expect(out.media_refs).toHaveLength(1);
    expect((await clips(fs))[0]).toMatchObject({ id: out.media_refs[0], status: "generating" });
    expect((await jobs(fs))[0]).toMatchObject({ status: "running", tool: "generate_image" });

    release();
    await whenGenerationsSettle();
    expect((await clips(fs))[0].status).toBeUndefined();
    expect((await jobs(fs))[0].status).toBe("done");
  });

  it("never runs more than the cap of paid calls at once, and still runs them all", async () => {
    const { store } = make();
    const releases: (() => void)[] = [];
    let started = 0;
    let peak = 0;
    let live = 0;

    const submits = Array.from({ length: 5 }, (_, i) =>
      submitGeneration({
        store,
        tool: "generate_image",
        label: "an image",
        mediaKind: "image",
        count: 1,
        filename: () => `a${i}.png`,
        run: async () => {
          started += 1;
          live += 1;
          peak = Math.max(peak, live);
          await new Promise<void>((r) => releases.push(r));
          live -= 1;
          return [{ bytes: PNG }];
        },
      }),
    );
    await Promise.all(submits);
    await new Promise((r) => setTimeout(r, 0));

    // The 4th and 5th must be QUEUED, not merely slower: nothing has finished yet.
    expect(started).toBe(3);

    releases.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(4); // a freed slot admits exactly one more

    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await whenGenerationsSettle();

    expect(started).toBe(5); // queued work is delayed, never dropped
    expect(peak).toBeLessThanOrEqual(3);
  });

  // The quota that actually bites is PER MODEL: six calls at one model earned 429s on twelve of
  // sixteen, while the same six spread over four models all succeeded. A global cap of 3 cannot
  // express that, so a batch aimed at one model still overran it.
  it("caps concurrency per MODEL, not just overall", async () => {
    const { store } = make();
    const live = new Map<string, number>();
    const peak = new Map<string, number>();
    const releases: Array<() => void> = [];
    const fire = (model: string) =>
      submitGeneration({
        store,
        tool: "generate_image",
        label: "an image",
        mediaKind: "image",
        count: 1,
        filename: () => "a.png",
        model,
        run: async () => {
          const n = (live.get(model) ?? 0) + 1;
          live.set(model, n);
          peak.set(model, Math.max(peak.get(model) ?? 0, n));
          await new Promise<void>((r) => releases.push(r));
          live.set(model, (live.get(model) ?? 1) - 1);
          return [{ bytes: PNG }];
        },
      });

    // Three at ONE model: the third must wait even though the global cap would admit it.
    await Promise.all([fire("nano"), fire("nano"), fire("nano")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(peak.get("nano")).toBeLessThanOrEqual(2);

    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await whenGenerationsSettle();
    expect(peak.get("nano")).toBeLessThanOrEqual(2);

    // Spreading across models is the documented workaround and must stay unthrottled per model.
    live.clear();
    peak.clear();
    await Promise.all([fire("alpha"), fire("beta")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(peak.get("alpha")).toBe(1);
    expect(peak.get("beta")).toBe(1);
    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await whenGenerationsSettle();
  });

  it("frees a slot when the paid call fails, so a queued job is not stranded", async () => {
    const { store } = make();
    let second = false;
    const blocked = Array.from({ length: 3 }, () =>
      submitGeneration({
        store,
        tool: "generate_image",
        label: "an image",
        mediaKind: "image",
        count: 1,
        filename: () => "a.png",
        run: async () => {
          throw new Error("provider down");
        },
      }),
    );
    await Promise.all(blocked);
    await submitGeneration({
      store,
      tool: "generate_image",
      label: "an image",
      mediaKind: "image",
      count: 1,
      filename: () => "b.png",
      run: async () => {
        second = true;
        return [{ bytes: PNG }];
      },
    });
    await whenGenerationsSettle();

    expect(second).toBe(true);
  });

  it("lands the bytes under the id it already handed out", async () => {
    const { fs, store } = make();
    const out = await submitGeneration({
      store,
      tool: "generate_image",
      label: "an image",
      mediaKind: "image",
      count: 1,
      filename: () => "a.png",
      run: async () => [{ bytes: PNG }],
    });
    await whenGenerationsSettle();

    const id = out.media_refs[0];
    expect(await store.resolveRef(id)).toBe(joinPath(DIR, `library/${id}.png`));
    expect(await fs.exists(joinPath(DIR, `library/${id}.png`))).toBe(true);
  });

  it("marks the placeholder failed when the paid call throws, and keeps the row", async () => {
    const { fs, store } = make();
    const out = await submitGeneration({
      store,
      tool: "generate_video",
      label: "a clip",
      mediaKind: "video",
      count: 1,
      filename: () => "a.mp4",
      run: async () => {
        throw new Error("content filter");
      },
    });
    await whenGenerationsSettle();

    const rows = await clips(fs);
    expect(rows).toHaveLength(1); // NOT deleted — a placed clip must not vanish
    expect(rows[0]).toMatchObject({
      id: out.media_refs[0],
      status: "failed",
      error: "content filter",
    });
    expect((await jobs(fs))[0]).toMatchObject({ status: "failed", error: "content filter" });
  });

  it("fails only the outputs the model did not return", async () => {
    const { fs, store } = make();
    await submitGeneration({
      store,
      tool: "generate_image",
      label: "two images",
      mediaKind: "image",
      count: 2,
      filename: (i) => `a${i}.png`,
      run: async () => [{ bytes: PNG }],
    });
    await whenGenerationsSettle();

    const rows = await clips(fs);
    expect(rows.filter((r) => r.status === undefined)).toHaveLength(1);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(1);
    // One landed, so the job is not a total loss.
    expect((await jobs(fs))[0].status).toBe("done");
  });

  it("records the job before the paid call, so a crash mid-call leaves a trace", async () => {
    const { fs, store } = make();
    let seen: Any[] = [];
    await submitGeneration({
      store,
      tool: "generate_music",
      label: "a bed",
      mediaKind: "audio",
      count: 1,
      filename: () => "a.mp3",
      run: async () => {
        seen = await jobs(fs); // what a crash at this instant would have left behind
        return [{ bytes: PNG }];
      },
    });
    await whenGenerationsSettle();

    expect(seen[0]).toMatchObject({ status: "running", tool: "generate_music" });
  });

  it("finishes a placeholder whose bytes landed while the project was closed", async () => {
    const { fs, store } = make();
    const out = await submitGeneration({
      store,
      tool: "generate_image",
      label: "an image",
      mediaKind: "image",
      count: 1,
      filename: () => "a.png",
      run: async () => [{ bytes: PNG }],
    });
    await whenGenerationsSettle();
    const id = out.media_refs[0];
    // Reproduce the close-rejected flip: bytes on disk, row still generating.
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    cat.clips[0].status = "generating";
    await fs.writeTextFile(joinPath(DIR, "internals/library.json"), JSON.stringify(cat));

    const done = await reconcilePendingMedia(store);

    expect(done).toEqual([id]);
    expect((await clips(fs))[0].status).toBeUndefined();
  });

  it("leaves a placeholder alone when its bytes never arrived", async () => {
    const { fs, store } = make();
    await submitGeneration({
      store,
      tool: "generate_image",
      label: "an image",
      mediaKind: "image",
      count: 1,
      filename: () => "a.png",
      run: async () => {
        throw new Error("nope");
      },
    });
    await whenGenerationsSettle();
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    cat.clips[0].status = "generating";
    await fs.writeTextFile(joinPath(DIR, "internals/library.json"), JSON.stringify(cat));

    expect(await reconcilePendingMedia(store)).toEqual([]);
    expect((await clips(fs))[0].status).toBe("generating");
  });

  it("reuses one ledger per project so two opens cannot race on writes", async () => {
    const { store } = make();
    const a = openProjectJobs(store);
    const b = openProjectJobs(store);
    expect(await a).toBe(await b);
  });

  it("stamps jobs with this launch, so reopening does not settle live work", async () => {
    const { fs, store } = make();
    await submitGeneration({
      store,
      tool: "generate_image",
      label: "an image",
      mediaKind: "image",
      count: 1,
      filename: () => "a.png",
      run: async () => [{ bytes: PNG }],
    });
    expect((await jobs(fs))[0].session).toBe(APP_SESSION);
    await whenGenerationsSettle();
  });

  it("announces a finished job so the chat can wake the agent", async () => {
    const { store } = make();
    await submitGeneration({
      store,
      tool: "generate_image",
      label: "a hero still",
      mediaKind: "image",
      count: 1,
      filename: () => "a.png",
      origin: AGENT,
      run: async () => [{ bytes: PNG }],
    });
    await whenGenerationsSettle();

    const notes = pendingJobNotes(DIR) as SettledJob[];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      status: "done",
      label: "a hero still",
      tool: "generate_image",
    });
    expect(notes[0].media_refs).toHaveLength(1);
  });

  it("announces a FAILED job too, so the agent can correct itself", async () => {
    const { store } = make();
    await submitGeneration({
      store,
      tool: "generate_video",
      label: "a clip",
      mediaKind: "video",
      count: 1,
      filename: () => "a.mp4",
      origin: AGENT,
      run: async () => {
        throw new Error("content filter");
      },
    });
    await whenGenerationsSettle();

    expect(pendingJobNotes(DIR)[0]).toMatchObject({ status: "failed", error: "content filter" });
  });

  // A generation nobody in the conversation asked for (an external MCP agent, say) must not start a
  // billed round in it. The media still lands; only the wake is withheld.
  it("does not wake the chat for a generation it did not start", async () => {
    const { fs, store } = make();
    const out = await submitGeneration({
      store,
      tool: "generate_image",
      label: "a hero still",
      mediaKind: "image",
      count: 1,
      filename: () => "a.png", // no origin
      run: async () => [{ bytes: PNG }],
    });
    await whenGenerationsSettle();

    expect((await clips(fs)).find((c) => c.id === out.media_refs[0])?.status).toBeUndefined();
    expect((await jobs(fs))[0].status).toBe("done");
    expect(pendingJobNotes(DIR)).toHaveLength(0);
  });
});

// The credit limit used to appear only as a mid-run JOB failure, one per submission, AFTER a
// placeholder and a ledger row had been written: a shot list produced a run of identical 402s
// (`2175.46 / 2000` — already over) with nothing to show for any of them.
describe("a generation is not submitted with no credit left", () => {
  afterEach(() => {
    clearUsage();
    vi.unstubAllGlobals();
  });

  const gen = (store: ProjectStoreAccess) =>
    submitGeneration({
      store,
      tool: "generate_image",
      label: "an image",
      mediaKind: "image",
      count: 1,
      filename: () => "a.png",
      run: async () => [{ bytes: PNG }],
    });

  it("refuses before writing a placeholder or a ledger row, and says nothing was charged", async () => {
    const { fs, store } = make();
    markOverLimit({ used: 2175, limit: 2000 });
    // The re-check confirms it: the balance really is gone.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ metered: true, used: 2175, limit: 2000, remaining: 0 })),
      ),
    );

    await expect(gen(store)).rejects.toThrow(/no credit left/i);
    // The evidence the refusal is a REFUSAL and not a failure: nothing was written.
    await expect(fs.readTextFile(joinPath(DIR, "internals/jobs.json"))).rejects.toThrow();
    await expect(fs.readTextFile(joinPath(DIR, "internals/library.json"))).rejects.toThrow();
  });

  // The direction that matters more: a top-up this client has not seen yet must NOT lock it out.
  it("lets the call through when a re-check says the balance is back", async () => {
    const { store } = make();
    markOverLimit({ used: 2175, limit: 2000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ metered: true, used: 10, limit: 5000, remaining: 4990 })),
      ),
    );

    const out = await gen(store);
    expect(out.media_refs).toHaveLength(1);
    await whenGenerationsSettle();
  });

  it("does not even ask when the balance was never known to be over", async () => {
    const { store } = make();
    const f = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", f);
    const out = await gen(store);
    expect(out.media_refs).toHaveLength(1);
    expect(f).not.toHaveBeenCalled(); // no /usage round-trip on the happy path
    await whenGenerationsSettle();
  });
});
