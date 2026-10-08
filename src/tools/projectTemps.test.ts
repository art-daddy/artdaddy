// What a writer that died leaves in a project, and the sweep that clears it (4j). Each case drives
// the real writer and stops it where a crash of the page would (a rename or an ffmpeg that never
// comes back), so the names under test are the ones the app really makes.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { transcode } from "../media/transcode";
import {
  animIndexName,
  animPackName,
  imageProxyName,
  posterName,
  proxyKey,
  proxyName,
} from "../preview/proxyPaths";
import { withAssScratch } from "./assScratch";
import type { CommandResult, CommandRunner } from "./command";
import { __resetJobSupervisor, __setJobSupervisor, type JobSupervisor } from "./jobSupervisor";
import { sampleFrames } from "./mediaFrames";
import { sweepArtifactCache, sweepOwnedMedia } from "./mediaGc";
import { sweepProjectTemps } from "./projectTemps";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "./store";
import { makeStoryboard } from "./storyboard";
import { isScratchDirName, isTempName, TEMP_STALE_MS } from "./tempNames";

const DIR = "C:/data/projects/p1";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A disk with a clock: every file and folder knows when it was last written, and a folder is
 *  written when something is added to it or taken out, as on a real filesystem. */
class Disk implements FsLike {
  files = new Map<string, Uint8Array>();
  dirs = new Map<string, number>();
  written = new Map<string, number>();
  clock = 1_700_000_000_000;
  /** Paths whose removal fails, as Windows refuses a file another process has open. */
  inUse = new Set<string>();
  /** A rename that never comes back: the page died between a temp and its rename. */
  renameHangs = false;

  later(ms: number): void {
    this.clock += ms;
  }
  private parent(n: string): string {
    return n.slice(0, n.lastIndexOf("/"));
  }
  private ensureDir(d: string): void {
    if (!d || this.dirs.has(d)) return;
    this.ensureDir(this.parent(d));
    this.dirs.set(d, this.clock);
    this.dirs.set(this.parent(d), this.clock);
  }
  private put(n: string, b: Uint8Array): void {
    this.ensureDir(this.parent(n));
    if (!this.files.has(n)) this.dirs.set(this.parent(n), this.clock);
    this.files.set(n, b);
    this.written.set(n, this.clock);
  }
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.files.has(n) || this.dirs.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const b = this.files.get(joinPath(p));
    if (!b) throw new Error(`ENOENT ${p}`);
    return new TextDecoder().decode(b);
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.put(joinPath(p), enc(c));
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const b = this.files.get(joinPath(p));
    if (!b) throw new Error(`ENOENT ${p}`);
    return b;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.put(joinPath(p), b);
  }
  async readDir(p: string): Promise<DirEntry[]> {
    const base = joinPath(p);
    if (!this.dirs.has(base)) throw new Error(`ENOENT ${p}`); // as a real disk does
    const out = new Map<string, boolean>();
    for (const d of this.dirs.keys())
      if (this.parent(d) === base) out.set(d.slice(base.length + 1), true);
    for (const f of this.files.keys())
      if (this.parent(f) === base) out.set(f.slice(base.length + 1), false);
    return [...out].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async stat(p: string): Promise<{ isDirectory: boolean; size: number; mtimeMs?: number }> {
    const n = joinPath(p);
    const f = this.files.get(n);
    if (f) return { isDirectory: false, size: f.length, mtimeMs: this.written.get(n) };
    const d = this.dirs.get(n);
    if (d !== undefined) return { isDirectory: true, size: 0, mtimeMs: d };
    throw new Error(`ENOENT ${p}`);
  }
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    if (this.inUse.has(n)) throw new Error(`EBUSY ${p}`);
    for (const k of [...this.files.keys()])
      if (k === n || k.startsWith(`${n}/`)) this.files.delete(k);
    for (const k of [...this.dirs.keys()])
      if (k === n || k.startsWith(`${n}/`)) this.dirs.delete(k);
    this.dirs.set(this.parent(n), this.clock);
  }
  async rename(from: string, to: string): Promise<void> {
    if (this.renameHangs) return new Promise(() => {});
    const b = this.files.get(joinPath(from));
    if (!b) throw new Error(`ENOENT ${from}`);
    await this.remove(from);
    this.put(joinPath(to), b);
  }
  async mkdir(p: string): Promise<void> {
    this.ensureDir(joinPath(p));
  }
}

/** A filesystem that cannot say when anything was written. */
class UndatedDisk extends Disk {
  override async stat(p: string): Promise<{ isDirectory: boolean; size: number }> {
    const { isDirectory, size } = await super.stat(p);
    return { isDirectory, size };
  }
}

/** An ffmpeg that writes its outputs and never comes back to the page that started it. */
const hangingRunner = (disk: Disk, outputs: (args: string[]) => string[]): CommandRunner => ({
  run: (_program: string, args: string[]): Promise<CommandResult> => {
    for (const out of outputs(args)) void disk.writeBytes(out, new Uint8Array([1, 2, 3]));
    return new Promise(() => {});
  },
});

const files = (disk: Disk, under = ""): string[] =>
  [...disk.files.keys()]
    .filter((k) => k.startsWith(joinPath(DIR, under)))
    .map((k) => k.slice(DIR.length + 1))
    .sort();
const sweep = (disk: Disk) =>
  sweepProjectTemps(new ProjectStoreAccess(DIR, disk), () => disk.clock);

afterEach(() => __resetJobSupervisor());

describe("what a writer that died leaves in a project", () => {
  it("a project file's write that died before its rename: kept while it could finish, gone after ten quiet minutes", async () => {
    const disk = new Disk();
    const store = new ProjectStoreAccess(DIR, disk);
    await store.writeTextAtomic(joinPath(DIR, "internals/timeline.json"), '{"tracks":[]}');
    disk.renameHangs = true;
    void store.writeTextAtomic(joinPath(DIR, "internals/timeline.json"), '{"tracks":[1]}');
    await vi.waitFor(() => expect(files(disk, "internals")).toHaveLength(2));
    const [temp] = files(disk, "internals").filter((f) => f !== "internals/timeline.json");
    expect(temp).toMatch(/^internals\/timeline\.tmp-[a-z0-9]+\.json$/);

    disk.later(TEMP_STALE_MS - 1);
    expect((await sweep(disk)).removed).toEqual([]);
    disk.later(1);
    expect((await sweep(disk)).removed).toEqual([temp]);
    expect(files(disk)).toEqual(["internals/timeline.json"]);
    expect(await disk.readTextFile(joinPath(DIR, "internals/timeline.json"))).toBe('{"tracks":[]}');
  });

  it("a library copy that died before its rename, but never a file the user put in the library", async () => {
    const disk = new Disk();
    const store = new ProjectStoreAccess(DIR, disk);
    await disk.writeBytes(joinPath(DIR, "library/notes.tmp"), enc("mine"));
    await disk.writeBytes(joinPath(DIR, "library/clip.tmp-abc.mp4"), enc("mine too"));
    disk.renameHangs = true;
    void store.writeBytesAtomic(joinPath(DIR, "library/media_0123456789ab.mp4"), enc("v"));
    await vi.waitFor(() => expect(files(disk, "library")).toHaveLength(3));
    disk.later(TEMP_STALE_MS);
    const { removed } = await sweep(disk);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^library\/media_0123456789ab\.mp4\.tmp-[a-z0-9]+$/);
    expect(files(disk)).toEqual(["library/clip.tmp-abc.mp4", "library/notes.tmp"]);
  });

  it("a preview proxy whose ffmpeg outlived its page goes, and the close-time GC no longer keeps it for its asset", async () => {
    const disk = new Disk();
    const store = new ProjectStoreAccess(DIR, disk);
    const source = "library/media_live00000001.mov";
    await disk.writeTextFile(
      joinPath(DIR, "internals/library.json"),
      JSON.stringify({ clips: [{ id: "media_live00000001", path: source }] }),
    );
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.json"), '{"tracks":[]}');
    const finished = store.artifactPath(`proxies/${proxyName(source)}`);
    await disk.writeBytes(finished, enc("a whole proxy"));
    const runner = hangingRunner(disk, (args) => [args[args.length - 1]]);
    void transcode(store, runner, store.artifactPath(`proxies/${proxyName(source)}`), ["-i", "x"]);
    await vi.waitFor(() => expect(files(disk, "internals/cache/proxies")).toHaveLength(2));
    const half = files(disk, "internals/cache/proxies").find((f) => f.includes(".tmp-"))!;
    expect(half).toContain(proxyKey(source)); // why the GC used to read it as live

    disk.later(TEMP_STALE_MS);
    // The close-time GC, as the project's close runs it.
    await sweepOwnedMedia(store);
    await sweepArtifactCache(store);
    await sweepProjectTemps(store, () => disk.clock);
    expect(files(disk, "internals/cache")).toEqual([
      `internals/cache/proxies/${proxyName(source)}`,
    ]);
  });

  it("a look's frames and its caption folder", async () => {
    const disk = new Disk();
    const store = new ProjectStoreAccess(DIR, disk);
    const runner = hangingRunner(disk, (args) => args.filter((a) => /\.tmp(\.jpg)?$/.test(a)));
    void sampleFrames({ store, runner }, "D:/clips/a.mp4", [1], { w: 64, h: 36 }, "k");
    await vi.waitFor(() =>
      expect(files(disk, "internals/cache").filter((f) => f.includes("/inspect/"))).toHaveLength(2),
    );
    const left = files(disk, "internals/cache");
    expect(left.filter((f) => f.includes("/inspect/"))).toHaveLength(2); // the JPEG and its grey copy
    expect(left.filter((f) => f.includes("/renderer/caps-"))).toHaveLength(1);

    expect((await sweep(disk)).removed).toEqual([]); // the look may still be running
    disk.later(TEMP_STALE_MS);
    const { removed } = await sweep(disk);
    expect(removed).toHaveLength(3);
    expect(files(disk, "internals/cache")).toEqual([]);
    expect(await disk.readDir(joinPath(DIR, "internals/cache/renderer"))).toEqual([]);
  });

  it("an overview's work folder", async () => {
    const disk = new Disk();
    const store = new ProjectStoreAccess(DIR, disk);
    const runner = hangingRunner(disk, (args) =>
      args.filter((a) => a.includes("_work/")).map((a) => a.replace("%03d", "000")),
    );
    void makeStoryboard({ store, runner }, "D:/clips/a.mp4", 0, 60, { w: 1920, h: 1080 });
    await vi.waitFor(() =>
      expect(files(disk, "internals/cache/inspect").length).toBeGreaterThan(0),
    );
    const work = (await disk.readDir(joinPath(DIR, "internals/cache/inspect"))).filter(
      (e) => e.isDirectory,
    );
    expect(work).toHaveLength(1);
    expect(isScratchDirName(work[0].name)).toBe(true);
    disk.later(TEMP_STALE_MS);
    expect((await sweep(disk)).removed).toEqual([`internals/cache/inspect/${work[0].name}`]);
    expect(files(disk)).toEqual([]);
  });
});

describe("what a temp is called", () => {
  it("exactly the two shapes the writers make, with at most one extension after", () => {
    const temps = [
      "timeline.tmp-ab12cd.json",
      "media_0123456789ab.mp4.tmp-ab12cd",
      "0123456789ab.r3.tmp-ab12cd.mp4",
      "mf_0123456789ab.k3j2a.tmp.jpg",
      "mf_0123456789ab.gray.k3j2a.tmp",
    ];
    for (const n of temps) expect(isTempName(n), n).toBe(true);
    for (const n of ["a.tmp-abc.mp4.json", "a.tmpl", "a.tmp-ab.cd.ef", "tmp", "a.tmp.jpg.bak"])
      expect(isTempName(n), n).toBe(false);
  });

  it("a scratch folder only by its whole name", () => {
    for (const n of ["caps-lk2j3-a8f9z1", "ov_0123456789ab_work"])
      expect(isScratchDirName(n), n).toBe(true);
    const others = [
      "xcaps-1-2",
      "caps-1-2-old",
      "old_ov_0123456789ab_work",
      "ov_0123456789ab_workspace",
      "caps-1",
      "ov__work",
    ];
    for (const n of others) expect(isScratchDirName(n), n).toBe(false);
  });
});

describe("what the sweep never touches", () => {
  it("a temp still being written when the project closes, by the close-time GC or the sweep", async () => {
    // Close runs its GC while the index can still be building a proxy, and a generation can land
    // in the library. The GC used to delete such a file under its writer (any unreferenced name).
    const disk = new Disk();
    const store = new ProjectStoreAccess(DIR, disk);
    await disk.writeTextFile(joinPath(DIR, "internals/library.json"), '{"clips":[]}');
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.json"), '{"tracks":[]}');
    const writing = [
      "library/media_0123456789ab.mp4.tmp-abc123",
      "internals/cache/inspect/tl_0_30_640g2.k3j2a.tmp.jpg",
      "internals/cache/proxies/0123456789ab.r3.tmp-abc123.mp4",
    ];
    for (const f of writing) await disk.writeBytes(joinPath(DIR, f), enc("x"));
    await sweepOwnedMedia(store);
    await sweepArtifactCache(store);
    await sweepProjectTemps(store, () => disk.clock);
    for (const f of writing) expect(files(disk), f).toContain(f);
    // The writer died after all: the next sweep, once it is quiet, takes them.
    disk.later(TEMP_STALE_MS);
    expect((await sweep(disk)).removed.sort()).toEqual([...writing].sort());
  });

  /** A caption folder an export's ffmpeg works in, left as a crash would leave it. */
  async function captionFolder(disk: Disk): Promise<string> {
    const store = new ProjectStoreAccess(DIR, disk);
    let folder = "";
    void withAssScratch(
      { store, runner: hangingRunner(disk, () => []) },
      [{ name: "a.ass", content: "x" }],
      [],
      (cwd) => {
        folder = cwd!;
        return new Promise(() => {});
      },
    );
    await vi.waitFor(() => expect(folder).not.toBe(""));
    return folder;
  }
  const jobsNaming = (paths: string[]): JobSupervisor =>
    ({
      list: async () =>
        paths.map((p, i) => ({ id: `j${i}`, meta: { kind: "export", scratch: p } })),
    }) as unknown as JobSupervisor;

  it("a folder a job names, among the numbers, plans and nulls an export's record holds", async () => {
    // The record as exportQueue writes it: only some of it is a path, and one export has none.
    const disk = new Disk();
    const folder = await captionFolder(disk);
    await disk.writeTextFile(joinPath(DIR, "internals/jobs.tmp-abc123.json"), "{}");
    const record = (scratch: string | null) => ({
      kind: "export",
      projectDir: DIR,
      destPath: "C:/Users/someone/Downloads/cut.mp4",
      stagePath: "C:/Users/someone/Downloads/.cut.mp4.ab12.partial",
      filename: "cut.mp4",
      startedBy: "chat",
      submittedAt: 1_712_345_678_901,
      plan: { duration: 12.5, audioMustSpanVideo: false, warnings: [], sources: [] },
      telemetry: { duration_s: 12.5, width: 1920, project_id: "p1" },
      scratch,
    });
    __setJobSupervisor({
      list: async () => [
        { id: "j1", meta: record(folder) },
        { id: "j2", meta: record(null) },
        { id: "j3", meta: { kind: "export", scratch: "", count: 0 } },
      ],
    } as unknown as JobSupervisor);
    disk.later(TEMP_STALE_MS);
    expect((await sweep(disk)).removed).toEqual(["internals/jobs.tmp-abc123.json"]);
    expect(await disk.exists(folder)).toBe(true);
  });

  it("a folder an export still running names, however long it has been quiet", async () => {
    const disk = new Disk();
    const folder = await captionFolder(disk);
    disk.later(TEMP_STALE_MS * 6);
    __setJobSupervisor(jobsNaming([folder]));
    expect((await sweep(disk)).removed).toEqual([]);
    __setJobSupervisor(jobsNaming([])); // the export ended and was let go
    expect((await sweep(disk)).removed).toEqual([folder.slice(DIR.length + 1)]);
  });

  it("anything, when the app's jobs cannot be listed", async () => {
    const disk = new Disk();
    await captionFolder(disk);
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.tmp-abc123.json"), "{}");
    disk.later(TEMP_STALE_MS);
    __setJobSupervisor({
      list: async () => {
        throw new Error("the app process did not answer");
      },
    } as unknown as JobSupervisor);
    expect((await sweep(disk)).removed).toEqual([]);
    expect(files(disk, "internals").length).toBeGreaterThan(1);
  });

  it("anything, while another machine has the project open", async () => {
    const disk = new Disk();
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.tmp-abc123.json"), "{}");
    await disk.writeTextFile(
      joinPath(DIR, "internals/.lock"),
      JSON.stringify({ instance: "another-machine", at: Date.now() }),
    );
    disk.later(TEMP_STALE_MS);
    expect((await sweep(disk)).removed).toEqual([]);
    // Its claim lapses (no heartbeat for minutes): nobody there is writing.
    await disk.writeTextFile(
      joinPath(DIR, "internals/.lock"),
      JSON.stringify({ instance: "another-machine", at: Date.now() - 60 * 60 * 1000 }),
    );
    expect((await sweep(disk)).removed).toEqual(["internals/timeline.tmp-abc123.json"]);
  });

  it("anything it cannot date", async () => {
    const disk = new UndatedDisk();
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.tmp-abc123.json"), "{}");
    disk.later(TEMP_STALE_MS * 100);
    expect((await sweep(disk)).removed).toEqual([]);
  });

  it("anything on a filesystem with no times at all, or whose time is no number", async () => {
    const disk = new Disk();
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.tmp-abc123.json"), "{}");
    disk.later(TEMP_STALE_MS * 100);
    const noStat = Object.assign(Object.create(disk) as Disk, { stat: undefined });
    expect((await sweep(noStat)).removed).toEqual([]);
    const nanTime = Object.assign(Object.create(disk) as Disk, {
      stat: async () => ({ isDirectory: false, size: 2, mtimeMs: Number.NaN }),
    });
    expect(await new ProjectStoreAccess(DIR, nanTime).writtenAt(joinPath(DIR, "x"))).toBeNull();
    expect((await sweep(nanTime)).removed).toEqual([]);
  });

  it("goes on past a temp that vanished between the listing and its date", async () => {
    const disk = new Disk();
    const gone = joinPath(DIR, "internals/library.tmp-gone00.json");
    await disk.writeTextFile(gone, "{}");
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.tmp-abc123.json"), "{}");
    disk.later(TEMP_STALE_MS);
    const racing = Object.assign(Object.create(disk) as Disk, {
      stat: (p: string) =>
        joinPath(p) === gone ? Promise.reject(new Error("ENOENT")) : disk.stat(p),
    });
    expect((await sweep(racing)).removed).toEqual(["internals/timeline.tmp-abc123.json"]);
  });

  it("a temp quiet for nine minutes; one quiet for ten goes", async () => {
    const disk = new Disk();
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.tmp-abc123.json"), "{}");
    disk.later(9 * 60_000);
    expect((await sweep(disk)).removed).toEqual([]);
    disk.later(60_000);
    expect((await sweep(disk)).removed).toEqual(["internals/timeline.tmp-abc123.json"]);
  });

  it("anything when the filesystem cannot remove, and says so by reporting nothing", async () => {
    const disk = new Disk();
    await disk.writeTextFile(joinPath(DIR, "internals/timeline.tmp-abc123.json"), "{}");
    disk.later(TEMP_STALE_MS);
    const noRemove = Object.assign(Object.create(disk) as Disk, { remove: undefined });
    expect((await sweep(noRemove)).removed).toEqual([]);
    expect(files(disk)).toEqual(["internals/timeline.tmp-abc123.json"]);
  });

  it("the user's deliverables, even a temp among them", async () => {
    const disk = new Disk();
    await disk.writeBytes(joinPath(DIR, "internals/cache/exports/final.tmp-abc123.mp4"), enc("v"));
    await disk.writeBytes(
      joinPath(DIR, "internals/cache/exports/.final.mp4.ab12.partial"),
      enc("v"),
    );
    disk.later(TEMP_STALE_MS);
    expect((await sweep(disk)).removed).toEqual([]);
  });

  it("does not report what it could not remove, and still removes the rest", async () => {
    const disk = new Disk();
    const a = joinPath(DIR, "internals/timeline.tmp-aaaaaa.json");
    const b = joinPath(DIR, "internals/library.tmp-bbbbbb.json");
    await disk.writeTextFile(a, "{}");
    await disk.writeTextFile(b, "{}");
    disk.inUse.add(a);
    disk.later(TEMP_STALE_MS);
    expect((await sweep(disk)).removed).toEqual(["internals/library.tmp-bbbbbb.json"]);
    disk.inUse.clear();
    expect((await sweep(disk)).removed).toEqual(["internals/timeline.tmp-aaaaaa.json"]);
  });

  it("property: no finished file the app writes is ever a temp", () => {
    const source = fc
      .tuple(
        fc.stringMatching(/^[A-Za-z0-9 _-]{1,20}$/),
        fc.constantFrom("mp4", "mov", "png", "gif", "jpg", "webp"),
      )
      .map(([n, ext]) => `library/${n}.${ext}`);
    fc.assert(
      fc.property(
        source,
        fc.stringMatching(/^[0-9a-f]{12}$/),
        fc.integer({ min: 0, max: 2 ** 40 }),
        (src, hash, ts) => {
          const finished = [
            proxyName(src),
            posterName(src),
            imageProxyName(src),
            animPackName(src),
            animIndexName(src),
            `${proxyKey(src)}.webok`,
            `media_${hash}.mp4`,
            `mf_${hash}.jpg`,
            `mf_${hash}.gray`,
            `ov_${hash}.jpg`,
            `ov_${hash}.json`,
            `timeline.json.corrupt-${ts}`,
            "timeline.json",
            "library.json",
            "project.json",
            "jobs.json",
            "transcript.json",
            ".lock",
            "thumbnail.jpg",
          ];
          for (const name of finished) expect(isTempName(name), name).toBe(false);
          expect(isScratchDirName(`ov_${hash}`)).toBe(false);
        },
      ),
    );
  });

  it("finished files around stale temps all survive a sweep", async () => {
    const disk = new Disk();
    const keep = [
      "internals/timeline.json",
      "internals/timeline.json.corrupt-1712345678901",
      "internals/.lock-not-ours",
      "library/media_0123456789ab.mp4",
      "internals/cache/proxies/abc.r3.mp4",
      "internals/cache/proxies/abc.webok",
      "internals/cache/inspect/mf_0123456789ab.gray",
      "internals/cache/inspect/ov_0123456789ab.jpg",
    ];
    for (const f of keep) await disk.writeBytes(joinPath(DIR, f), enc("x"));
    await disk.writeBytes(joinPath(DIR, "internals/cache/proxies/abc.tmp-zz9.mp4"), enc("x"));
    disk.later(TEMP_STALE_MS * 10);
    expect((await sweep(disk)).removed).toEqual(["internals/cache/proxies/abc.tmp-zz9.mp4"]);
    expect(files(disk)).toEqual([...keep].sort());
  });
});
