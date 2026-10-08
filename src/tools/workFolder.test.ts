import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetJobSupervisor, __setJobSupervisor, type JobSupervisor } from "./jobSupervisor";
import { ProjectStoreAccess, type DirEntry, type FsLike } from "./store";
import { sweepWork, workRoot } from "./workFolder";

const WORK = "C:/Users/u/AppData/Local/com.artdaddy.app/work";
const PROJECT = "C:/Users/u/AppData/Roaming/ArtDaddy/projects/p1";
const LAUNCH = "launch-18f2a3b4c5d6e7f8-1a2b";

// The desktop app's filesystem, as the launch sweep builds it for itself.
const desktop = vi.hoisted(() => ({ fs: null as unknown }));
vi.mock("./tauri", () => ({
  TauriFs: class {
    constructor() {
      return desktop.fs as object;
    }
  },
}));

/** This run of the app, as the app process names it. */
function inLaunch(id: string): void {
  __setJobSupervisor({ launchId: async () => id } as unknown as JobSupervisor);
}

/** A disk of folders, each listed by name; `stuck` cannot be removed (a file in it is open). */
function disk(folders: string[], opts: { workDir?: boolean; stuck?: string[] } = {}) {
  const present = new Set(folders.map((f) => `${WORK}/${f}`));
  const made: string[] = [];
  const fs: FsLike = {
    exists: async (p) => present.has(p),
    readTextFile: async () => "",
    writeTextFile: async () => undefined,
    mkdir: async (p) => void made.push(p),
    readDir: async (p): Promise<DirEntry[]> =>
      p === WORK
        ? [...present].map((f) => ({ name: f.slice(WORK.length + 1), isDirectory: true }))
        : [],
    remove: vi.fn(async (p: string) => {
      if (opts.stuck?.some((s) => p === `${WORK}/${s}`)) throw new Error("EBUSY");
      present.delete(p);
    }),
    ...(opts.workDir === false ? {} : { workDir: async () => WORK }),
  };
  return { fs, present, made };
}

afterEach(() => __resetJobSupervisor());

describe("the app's work folder (4i)", () => {
  it("puts a job's scratch in this launch's folder, outside the project, with its folder made", async () => {
    inLaunch(LAUNCH);
    const { fs, made } = disk([]);
    const store = new ProjectStoreAccess(PROJECT, fs);
    const wav = await store.prepareWork("transcribe/abc.wav");
    expect(wav).toBe(`${WORK}/${LAUNCH}/transcribe/abc.wav`);
    expect(wav.startsWith(PROJECT)).toBe(false);
    expect(made).toEqual([`${WORK}/${LAUNCH}/transcribe`]);
  });

  it("keeps scratch in the project where the filesystem has no work folder", async () => {
    inLaunch(LAUNCH);
    const { fs } = disk([], { workDir: false });
    const store = new ProjectStoreAccess(PROJECT, fs);
    expect(await store.prepareWork("transcribe/abc.wav")).toBe(
      `${PROJECT}/internals/cache/transcribe/abc.wav`,
    );
    expect(await workRoot(fs)).toBeNull();
  });

  it("names a page's own run where there is no app process to ask", async () => {
    __setJobSupervisor(null);
    const { fs } = disk([]);
    const root = (await workRoot(fs))!;
    expect(root.startsWith(`${WORK}/`)).toBe(true);
    expect(root.slice(WORK.length + 1)).not.toBe(LAUNCH);
    expect(root.slice(WORK.length + 1)).not.toContain("/");
  });

  it("removes what earlier launches left and keeps this launch's", async () => {
    inLaunch(LAUNCH);
    const earlier = [
      "launch-18f2a3b4c5d6e000-9f9f",
      "6f9619ff-8b86-d011-b42d-00c04fc964ff", // a page's own run, in an older shell
    ];
    const { fs, present } = disk([LAUNCH, ...earlier]);
    expect((await sweepWork(fs)).sort()).toEqual(earlier.map((f) => `${WORK}/${f}`).sort());
    expect([...present]).toEqual([`${WORK}/${LAUNCH}`]);
  });

  it("deletes nothing it did not name: a folder of another shape stays", async () => {
    inLaunch(LAUNCH);
    const { fs, present } = disk(["My Videos", "launch-zz", ".."]);
    expect(await sweepWork(fs)).toEqual([]);
    expect(present.size).toBe(3);
  });

  it("leaves a folder still in use for the next launch, and removes the rest", async () => {
    inLaunch(LAUNCH);
    const { fs, present } = disk(["launch-1-1", "launch-2-2"], { stuck: ["launch-1-1"] });
    expect(await sweepWork(fs)).toEqual([`${WORK}/launch-2-2`]);
    expect([...present]).toEqual([`${WORK}/launch-1-1`]);
  });

  it("does nothing, and never throws, without a work folder or when it cannot be listed", async () => {
    inLaunch(LAUNCH);
    expect(await sweepWork(disk(["launch-1-1"], { workDir: false }).fs)).toEqual([]);
    const { fs } = disk(["launch-1-1"]);
    fs.readDir = async () => {
      throw new Error("ENOENT");
    };
    expect(await sweepWork(fs)).toEqual([]);
    expect(await sweepWork(null)).toEqual([]);
  });

  // The app calls it with nothing (main.tsx): it must find the desktop's folder itself.
  it("finds the desktop app's work folder by itself, and does nothing outside the desktop app", async () => {
    inLaunch(LAUNCH);
    const { fs, present } = disk([LAUNCH, "launch-1-1"]);
    desktop.fs = fs;
    const w = window as unknown as { __TAURI_INTERNALS__?: object };
    expect(await sweepWork()).toEqual([]);
    expect(present.size).toBe(2);
    w.__TAURI_INTERNALS__ = {};
    try {
      expect(await sweepWork()).toEqual([`${WORK}/launch-1-1`]);
      expect([...present]).toEqual([`${WORK}/${LAUNCH}`]);
    } finally {
      delete w.__TAURI_INTERNALS__;
    }
  });
});
