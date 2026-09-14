import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientToolContext } from "./context";
import {
  deleteProjectTool,
  duplicateProjectTool,
  getProjectStateTool,
  listProjectsTool,
  newProjectTool,
  openProjectTool,
  ProjectRegistry,
  renameProjectTool,
  setProjectSettingsTool,
} from "./project";
import {
  type DirEntry,
  type FsLike,
  isProjectDirDead,
  markProjectDirDead,
  ProjectStoreAccess,
  reviveProjectDir,
} from "./store";
import { registerTestDocument, resetTestDocuments, flushTestDocuments } from "../test/timelineKit";
import { BRAND } from "../brand";
import { ProjectClosingError } from "../project/MutationGate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}
function parent(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i > 0 ? n.slice(0, i) : n;
}
function base(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/** In-memory fs with real directory semantics (readDir/remove/copyFile). */
class MemFs implements FsLike {
  files = new Map<string, string>();
  dirs = new Set<string>();
  private regAncestors(p: string): void {
    let cur = parent(norm(p));
    while (cur && !this.dirs.has(cur)) {
      this.dirs.add(cur);
      const up = parent(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  async exists(p: string): Promise<boolean> {
    const n = norm(p);
    return this.files.has(n) || this.dirs.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(norm(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    const n = norm(p);
    this.files.set(n, c);
    this.regAncestors(n);
  }
  async mkdir(p: string): Promise<void> {
    let cur = norm(p);
    while (cur && !this.dirs.has(cur)) {
      this.dirs.add(cur);
      const up = parent(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  async readDir(p: string): Promise<DirEntry[]> {
    const b = norm(p);
    const out = new Map<string, boolean>();
    for (const f of this.files.keys()) if (parent(f) === b) out.set(base(f), false);
    for (const d of this.dirs) if (parent(d) === b) out.set(base(d), true);
    return [...out.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async remove(p: string): Promise<void> {
    const b = norm(p);
    const pre = `${b}/`;
    for (const f of [...this.files.keys()]) if (f === b || f.startsWith(pre)) this.files.delete(f);
    for (const d of [...this.dirs]) if (d === b || d.startsWith(pre)) this.dirs.delete(d);
  }
  async copyFile(src: string, dst: string): Promise<void> {
    const v = this.files.get(norm(src));
    if (v === undefined) throw new Error(`ENOENT ${src}`);
    const n = norm(dst);
    this.files.set(n, v);
    this.regAncestors(n);
  }
}

const DATA = "C:/appdata/ArtDaddy";
const PROJECTS = `${DATA}/projects`;
const ACTIVE = `${PROJECTS}/proj_active`;
const REGISTRY = `${DATA}/projects.json`;

async function mkCtx(): Promise<{ ctx: ClientToolContext; fs: MemFs }> {
  const fs = new MemFs();
  await fs.mkdir(`${ACTIVE}/history`);
  await fs.writeTextFile(
    `${ACTIVE}/internals/project.json`,
    JSON.stringify({
      id: "proj_active",
      name: "Active",
      settings: { canvas: { width: 1080, height: 1920, fps: 30 }, model_id: "gpt-x" },
    }),
  );
  await fs.writeTextFile(
    `${ACTIVE}/internals/timeline.json`,
    JSON.stringify({ units: "frames", canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [] }),
  );
  await fs.writeTextFile(
    REGISTRY,
    JSON.stringify({
      version: 1,
      activeProjectId: "proj_active",
      projects: [
        { id: "proj_active", name: "Active", path: ACTIVE, lastOpenedAt: "2026-01-01T00:00:00Z" },
      ],
    }),
  );
  const store = new ProjectStoreAccess(ACTIVE, fs);
  return { ctx: { store, runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } }, fs };
}

async function readRegistry(fs: MemFs): Promise<Any> {
  return JSON.parse(await fs.readTextFile(REGISTRY));
}

// Tombstones live in a MODULE-level set keyed by dir, and every test here shares ACTIVE — so any
// test that deletes the project leaves it dead for whatever runs next. It only looked stable
// because the deleting suites happened to run last; `--sequence.shuffle` fails it outright.
afterEach(() => reviveProjectDir(ACTIVE));

describe("ProjectRegistry.fromProjectDir", () => {
  it("derives projects_root + registry path from an active project dir", () => {
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, new MemFs());
    expect(reg.projectsDir).toBe(PROJECTS);
    expect(reg.registryPath).toBe(REGISTRY);
    expect(reg.projectDir("x")).toBe(`${PROJECTS}/x`);
  });
});

describe("ProjectRegistry.projectDir containment (F4)", () => {
  it("rejects an unsafe id instead of building a traversing path", () => {
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, new MemFs());
    expect(reg.projectDir("good_ab12cd")).toBe(`${PROJECTS}/good_ab12cd`); // safe passes through
    for (const bad of ["..", "../evil", "../../etc/passwd", "a/b", "a\\b", ""]) {
      expect(() => reg.projectDir(bad)).toThrow(/unsafe project id/);
    }
  });
});

describe("ProjectRegistry.repairLegacyRootPaths", () => {
  // The rename moved <appData>/Akaru to <appData>/ArtDaddy but left absolute paths in
  // projects.json pointing at the old root. entryDir prefers a recorded path and listLive
  // hides an entry whose directory is missing, so projects vanished from the picker while
  // their files sat safely under the new root. 206 of 210 entries on the dev machine.
  const NEW_ROOT = "C:/appdata/ArtDaddy/projects";
  // Deliberately the OLD name: this test exists to remember it. A blanket rename that
  // "fixes" this constant makes both roots identical and the test stops asserting anything.
  const OLD = "C:/appdata/Akaru/projects";

  async function withEntries(entries: Any[], existing: string[]): Promise<{ reg: Any; fs: MemFs }> {
    const fs = new MemFs();
    for (const dir of existing) await fs.mkdir(dir);
    await fs.writeTextFile(
      "C:/appdata/ArtDaddy/projects.json",
      JSON.stringify({ version: 1, activeProjectId: null, projects: entries }),
    );
    return { reg: ProjectRegistry.fromProjectDir(`${NEW_ROOT}/anything`, fs), fs };
  }

  it("brings back a project whose recorded path still names the old root", async () => {
    const { reg } = await withEntries(
      [{ id: "p1", name: "P1", path: `${OLD}/p1`, lastOpenedAt: "2026-01-01T00:00:00Z" }],
      [`${NEW_ROOT}/p1`],
    );
    expect(await reg.listLive()).toHaveLength(0); // the symptom, before the repair
    const res = await reg.repairLegacyRootPaths();
    expect(res.repaired).toEqual([{ id: "p1", to: `${NEW_ROOT}/p1` }]);
    // The outcome that matters — it is back in the picker, not merely rewritten on disk.
    expect((await reg.listLive()).map((e: Any) => e.id)).toEqual(["p1"]);
  });

  it("leaves an entry alone when its old folder is genuinely still there", async () => {
    // Both roots existed on the dev machine. Repointing a project whose real files are still
    // under the old root would lose them.
    const { reg } = await withEntries(
      [{ id: "p1", name: "P1", path: `${OLD}/p1` }],
      [`${OLD}/p1`, `${NEW_ROOT}/p1`],
    );
    await reg.repairLegacyRootPaths();
    const reg2 = await reg.read();
    expect(reg2.projects[0].path).toBe(`${OLD}/p1`);
  });

  it("never touches a project the user put somewhere else with Save As", async () => {
    const { reg } = await withEntries(
      [{ id: "p1", name: "P1", path: "D:/Work/p1" }],
      [`${NEW_ROOT}/p1`],
    );
    await reg.repairLegacyRootPaths();
    expect((await reg.read()).projects[0].path).toBe("D:/Work/p1");
  });

  it("does nothing on a second run", async () => {
    const { reg } = await withEntries(
      [{ id: "p1", name: "P1", path: `${OLD}/p1` }],
      [`${NEW_ROOT}/p1`],
    );
    await reg.repairLegacyRootPaths();
    expect((await reg.repairLegacyRootPaths()).repaired).toEqual([]);
  });

  it("does not repair a nested path that is not a direct child of the old projects dir", async () => {
    // `<legacy>/projects/a/b` would re-home to `<new>/projects/b`, which is a different place.
    const { reg } = await withEntries(
      [{ id: "p1", name: "P1", path: `${OLD}/a/b` }],
      [`${NEW_ROOT}/b`],
    );
    await reg.repairLegacyRootPaths();
    expect((await reg.read()).projects[0].path).toBe(`${OLD}/a/b`);
  });
});

describe("ProjectRegistry.migrateUnsafeIds (F4)", () => {
  it("re-keys a corrupt id backed by a contained folder, drops a poisoned entry, keeps safe ones", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    // Real, contained folders for the safe entry and the corrupt-key entry.
    await fs.writeTextFile(
      `${PROJECTS}/safe_x/internals/project.json`,
      JSON.stringify({ id: "safe_x", name: "Safe" }),
    );
    await fs.writeTextFile(
      `${PROJECTS}/good2/internals/project.json`,
      JSON.stringify({ id: "good2", name: "Good2" }),
    );
    await reg.write({
      version: 1,
      activeProjectId: "../good2", // active points at the corrupt key
      projects: [
        { id: "safe_x", name: "Safe", path: `${PROJECTS}/safe_x` },
        { id: "../good2", name: "Good2", path: `${PROJECTS}/good2` }, // corrupt key, real contained folder
        { id: "../../evil", name: "Evil", path: "C:/appdata/evil" }, // poisoned: escapes the projects root
      ],
    });

    const res = await reg.migrateUnsafeIds();
    expect(res.migrated).toEqual([{ from: "../good2", to: "good2" }]);
    expect(res.dropped).toEqual(["../../evil"]);
    expect(res.failed).toEqual([]);

    const out = await readRegistry(fs);
    expect(out.projects.map((e: Any) => e.id).sort()).toEqual(["good2", "safe_x"]);
    expect(out.activeProjectId).toBe("good2"); // active followed the repair
    // Every surviving id now resolves to a contained path (no throw).
    for (const e of out.projects) expect(reg.projectDir(e.id)).toBe(`${PROJECTS}/${e.id}`);
  });

  it("is a no-op when every id is already safe", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await fs.writeTextFile(`${PROJECTS}/p/internals/project.json`, JSON.stringify({ id: "p" })); // live dir -> true no-op
    await reg.write({
      version: 1,
      activeProjectId: "p",
      projects: [{ id: "p", name: "P", path: `${PROJECTS}/p` }],
    });
    const res = await reg.migrateUnsafeIds();
    expect(res).toEqual({ migrated: [], dropped: [], failed: [] });
    expect((await readRegistry(fs)).projects.map((e: Any) => e.id)).toEqual(["p"]);
  });

  it("DROPS a corrupt entry whose folder is NESTED, not a direct child (RF10)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await fs.writeTextFile(
      `${PROJECTS}/nested/b/internals/project.json`,
      JSON.stringify({ id: "b" }),
    );
    await reg.write({
      version: 1,
      activeProjectId: null,
      projects: [{ id: "../nested/b", name: "Nested", path: `${PROJECTS}/nested/b` }],
    });
    const res = await reg.migrateUnsafeIds();
    // re-keying to basename "b" would leave projectDir("b")=root/b != root/nested/b,
    // so the entry is DROPPED rather than re-keyed to an inconsistent path.
    expect(res.migrated).toEqual([]);
    expect(res.dropped).toEqual(["../nested/b"]);
    expect((await readRegistry(fs)).projects).toEqual([]);
  });

  it("DROPS a re-key that would collide with an existing safe id (RF10)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await fs.writeTextFile(`${PROJECTS}/dup/internals/project.json`, JSON.stringify({ id: "dup" }));
    await reg.write({
      version: 1,
      activeProjectId: null,
      projects: [
        { id: "dup", name: "Safe Dup", path: `${PROJECTS}/dup` }, // safe, owns id "dup"
        { id: "../dup", name: "Corrupt Dup", path: `${PROJECTS}/dup` }, // basename "dup" collides
      ],
    });
    const res = await reg.migrateUnsafeIds();
    expect(res.migrated).toEqual([]); // can't re-key onto the already-taken "dup"
    expect(res.dropped).toEqual(["../dup"]);
    expect((await readRegistry(fs)).projects.map((e: Any) => e.id)).toEqual(["dup"]);
  });

  it("reassigns an UNSAFE activeProjectId even when every entry id is safe (RF10)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await fs.writeTextFile(`${PROJECTS}/a/internals/project.json`, JSON.stringify({ id: "a" }));
    await fs.writeTextFile(`${PROJECTS}/b/internals/project.json`, JSON.stringify({ id: "b" }));
    await reg.write({
      version: 1,
      activeProjectId: "../evil", // unsafe pointer that matches no entry -> the fast path must NOT skip it
      projects: [
        { id: "a", name: "A", path: `${PROJECTS}/a`, lastOpenedAt: "2026-01-02T00:00:00Z" },
        { id: "b", name: "B", path: `${PROJECTS}/b`, lastOpenedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await reg.migrateUnsafeIds();
    expect(res).toEqual({ migrated: [], dropped: [], failed: [] }); // entries untouched
    const out = await readRegistry(fs);
    expect(out.projects.map((e: Any) => e.id).sort()).toEqual(["a", "b"]);
    expect(out.activeProjectId).toBe("a"); // reassigned to the newest live one, not left "../evil"
  });

  it("reassigns a safe-but-ORPHAN activeProjectId that names no entry (Q8)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await fs.writeTextFile(`${PROJECTS}/a/internals/project.json`, JSON.stringify({ id: "a" }));
    await fs.writeTextFile(`${PROJECTS}/b/internals/project.json`, JSON.stringify({ id: "b" }));
    await reg.write({
      version: 1,
      activeProjectId: "ghost", // syntactically safe, but matches NO retained entry
      projects: [
        { id: "a", name: "A", path: `${PROJECTS}/a`, lastOpenedAt: "2026-01-02T00:00:00Z" },
        { id: "b", name: "B", path: `${PROJECTS}/b`, lastOpenedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await reg.migrateUnsafeIds();
    expect(res).toEqual({ migrated: [], dropped: [], failed: [] }); // entries untouched
    const out = await readRegistry(fs);
    expect(out.projects.map((e: Any) => e.id).sort()).toEqual(["a", "b"]);
    expect(out.activeProjectId).toBe("a"); // orphan "ghost" -> newest live, not left as-is
  });

  it("reassigns the orphan active pointer to the newest LIVE project, skipping a missing dir (R6-7)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    // "a" is newer but its folder is MISSING; "b" is older but present on disk.
    await fs.writeTextFile(`${PROJECTS}/b/internals/project.json`, JSON.stringify({ id: "b" }));
    await reg.write({
      version: 1,
      activeProjectId: "ghost", // orphan -> must be reassigned
      projects: [
        { id: "a", name: "A", path: `${PROJECTS}/a`, lastOpenedAt: "2026-01-02T00:00:00Z" }, // newer, dir MISSING
        { id: "b", name: "B", path: `${PROJECTS}/b`, lastOpenedAt: "2026-01-01T00:00:00Z" }, // older, dir present
      ],
    });
    const res = await reg.migrateUnsafeIds();
    expect(res).toEqual({ migrated: [], dropped: [], failed: [] });
    const out = await readRegistry(fs);
    // "a" is newest but its dir is gone (listLive would hide it) -> pick live "b".
    expect(out.activeProjectId).toBe("b");
  });

  it("reassigns active when it names a safe entry whose DIRECTORY is missing (R7-6)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    // active="a" IS a safe registered entry, but a's folder is gone; b is live. The
    // old fast path returned early (a matched a safe entry) leaving active dangling.
    await fs.writeTextFile(`${PROJECTS}/b/internals/project.json`, JSON.stringify({ id: "b" }));
    await reg.write({
      version: 1,
      activeProjectId: "a",
      projects: [
        { id: "a", name: "A", path: `${PROJECTS}/a`, lastOpenedAt: "2026-01-02T00:00:00Z" }, // dir MISSING
        { id: "b", name: "B", path: `${PROJECTS}/b`, lastOpenedAt: "2026-01-01T00:00:00Z" }, // dir present
      ],
    });
    const res = await reg.migrateUnsafeIds();
    expect(res).toEqual({ migrated: [], dropped: [], failed: [] }); // entries untouched
    const out = await readRegistry(fs);
    expect(out.projects.map((e: Any) => e.id).sort()).toEqual(["a", "b"]); // both kept
    expect(out.activeProjectId).toBe("b"); // active moved off the missing-dir "a"
  });

  it("keeps an active pointer at a project that lives OUTSIDE the projects root (Save As)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    // "a" was moved by Save As: nothing at the canonical PROJECTS/a, everything at the
    // recorded path. Before the registry became authoritative this probed the canonical
    // dir, so every moved project read as dead and the active pointer walked off it.
    await fs.writeTextFile(
      "D:/Client Work/Hero/internals/project.json",
      JSON.stringify({ id: "a" }),
    );
    await fs.writeTextFile(`${PROJECTS}/b/internals/project.json`, JSON.stringify({ id: "b" }));
    await reg.write({
      version: 1,
      activeProjectId: "a",
      projects: [
        { id: "a", name: "A", path: "D:/Client Work/Hero", lastOpenedAt: "2026-01-02T00:00:00Z" },
        { id: "b", name: "B", path: `${PROJECTS}/b`, lastOpenedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    await reg.migrateUnsafeIds();
    expect((await readRegistry(fs)).activeProjectId).toBe("a");
    expect(await reg.dirFor("a")).toBe("D:/Client Work/Hero");
    // The id still governs containment: it is validated before the registry is consulted.
    await expect(reg.dirFor("../../evil")).rejects.toThrow(/unsafe project id/);
  });

  it("hides a moved project whose real folder is gone, even with a stale default folder left behind", async () => {
    // The failure direction, and the exact leftover Save As creates: the ORIGINAL folder
    // still sits at PROJECTS/a after the project moved away. If the moved copy is deleted,
    // that leftover must not resurrect it — the recorded path is the only thing that counts.
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await fs.writeTextFile(`${PROJECTS}/a/internals/project.json`, JSON.stringify({ id: "a" }));
    await reg.write({
      version: 1,
      activeProjectId: null,
      projects: [{ id: "a", name: "A", path: "D:/Client Work/Hero" }],
    });
    expect(await reg.listLive()).toEqual([]);
    // And a project that never moved still resolves to the default folder.
    await reg.write({
      version: 1,
      activeProjectId: null,
      projects: [{ id: "a", name: "A", path: `${PROJECTS}/a` }],
    });
    expect((await reg.listLive()).map((e) => e.id)).toEqual(["a"]);
    expect(await reg.dirFor("a")).toBe(`${PROJECTS}/a`);
  });
});

describe("ProjectRegistry.saveProjectAs", () => {
  const SRC = `${PROJECTS}/hero_a1b2c3`;
  const DEST = "D:/Client Work/Hero Cut";

  async function seeded(): Promise<MemFs> {
    const fs = new MemFs();
    await fs.writeTextFile(
      `${SRC}/internals/project.json`,
      JSON.stringify({ id: "hero_a1b2c3", name: "Hero" }),
    );
    await fs.writeTextFile(`${SRC}/internals/timeline.json`, JSON.stringify({ tracks: [] }));
    await fs.writeTextFile(`${SRC}/library/media_abc.mp4`, "OWNED-BYTES");
    await fs.writeTextFile(`${SRC}/internals/cache/proxy.mp4`, "DERIVED");
    await fs.writeTextFile(
      REGISTRY,
      JSON.stringify({
        version: 1,
        activeProjectId: "hero_a1b2c3",
        projects: [{ id: "hero_a1b2c3", name: "Hero", path: SRC }],
      }),
    );
    return fs;
  }

  it("copies the project to the chosen folder and edits CONTINUE there", async () => {
    const fs = await seeded();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await reg.saveProjectAs("hero_a1b2c3", DEST);

    // The OUTCOME: the project is at the chosen folder, owned media and all.
    expect(await fs.readTextFile(`${DEST}/internals/timeline.json`)).toBe(
      JSON.stringify({ tracks: [] }),
    );
    expect(await fs.readTextFile(`${DEST}/library/media_abc.mp4`)).toBe("OWNED-BYTES");
    // The id is unchanged, so the route, the open document and undo all still resolve —
    // and every later id->directory hop now lands on the new folder.
    expect(await reg.dirFor("hero_a1b2c3")).toBe(DEST);
    expect((await readRegistry(fs)).activeProjectId).toBe("hero_a1b2c3");
    // Premiere leaves the original file on disk; so do we.
    expect(await fs.exists(`${SRC}/internals/project.json`)).toBe(true);
    // The derived cache is regeneratable and is never copied.
    expect(await fs.exists(`${DEST}/internals/cache/proxy.mp4`)).toBe(false);
  });

  it("refuses a destination that already holds a project instead of merging into it", async () => {
    const fs = await seeded();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await fs.writeTextFile(`${DEST}/internals/project.json`, JSON.stringify({ id: "other" }));
    await fs.writeTextFile(`${DEST}/internals/timeline.json`, "SOMEONE-ELSES-WORK");
    await expect(reg.saveProjectAs("hero_a1b2c3", DEST)).rejects.toThrow(/already a project/);
    // The failure direction that matters: nothing of theirs was overwritten, and we are
    // still pointed at the original — a half-merge of two projects is unrecoverable by hand.
    expect(await fs.readTextFile(`${DEST}/internals/timeline.json`)).toBe("SOMEONE-ELSES-WORK");
    expect(await reg.dirFor("hero_a1b2c3")).toBe(SRC);
  });

  it("leaves the project where it was when the copy fails part-way", async () => {
    const fs = await seeded();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const realCopy = fs.copyFile.bind(fs);
    fs.copyFile = async (s: string, d: string) => {
      if (s.endsWith("media_abc.mp4")) throw new Error("disk full");
      return realCopy(s, d);
    };
    await expect(reg.saveProjectAs("hero_a1b2c3", DEST)).rejects.toThrow(/disk full/);
    // The registry is repointed only AFTER the copy lands, so the user is still editing
    // the original rather than a folder that is missing half its media.
    expect(await reg.dirFor("hero_a1b2c3")).toBe(SRC);
    expect(await fs.readTextFile(`${SRC}/library/media_abc.mp4`)).toBe("OWNED-BYTES");
  });

  it("refuses a relative destination and is a no-op onto its own folder", async () => {
    const fs = await seeded();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await expect(reg.saveProjectAs("hero_a1b2c3", "Client Work/Hero")).rejects.toThrow(/folder/);
    // Saving onto itself must not try to copy a directory into itself.
    expect(await reg.saveProjectAs("hero_a1b2c3", `${SRC}/`)).toEqual({
      id: "hero_a1b2c3",
      path: SRC,
    });
    expect(await fs.readTextFile(`${SRC}/library/media_abc.mp4`)).toBe("OWNED-BYTES");
  });
});

describe("ProjectRegistry.writeProject tombstone (Q7)", () => {
  afterEach(() => reviveProjectDir(`${PROJECTS}/gone`));

  it("no-ops writeProject on a tombstoned (deleted) dir; resumes after revive", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const jsonPath = `${PROJECTS}/gone/internals/project.json`;
    markProjectDirDead(`${PROJECTS}/gone`);
    // A rename/settings RMW racing a delete must NOT recreate project.json.
    await reg.writeProject("gone", { id: "gone", name: "X" });
    expect(await fs.exists(jsonPath)).toBe(false);
    reviveProjectDir(`${PROJECTS}/gone`);
    await reg.writeProject("gone", { id: "gone", name: "X" });
    expect(await fs.exists(jsonPath)).toBe(true); // writes again once the dir is live
  });
});

describe("ProjectRegistry read/write durability", () => {
  it("write then read round-trips (atomic write)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await reg.write({
      version: 1,
      activeProjectId: "p",
      projects: [{ id: "p", name: "P", path: `${PROJECTS}/p` }],
    });
    const out = await reg.read();
    expect(out.activeProjectId).toBe("p");
    expect(out.projects[0].id).toBe("p");
  });
  it("recovers from a corrupt projects.json (preserves bytes, degrades to empty)", async () => {
    const fs = new MemFs();
    await fs.writeTextFile(REGISTRY, "{ broken json");
    const out = await ProjectRegistry.fromProjectDir(ACTIVE, fs).read();
    expect(out.projects).toEqual([]);
    expect(out.activeProjectId).toBeNull();
    const backups = [...fs.files.keys()].filter((k) => k.startsWith(`${REGISTRY}.corrupt-`));
    expect(backups).toHaveLength(1);
  });
});

describe("registry write serialization (R10)", () => {
  it("concurrent registers don't lose an update (serialized RMW)", async () => {
    const fs = new MemFs();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await reg.write({ version: 1, activeProjectId: null, projects: [] });
    // Two register RMW cycles fired concurrently: without the per-registry lock
    // both read the empty list and the second write clobbers the first. Serialized
    // through updateRegistry, both entries survive.
    await Promise.all([
      reg.register({ id: "a", name: "A", path: `${PROJECTS}/a` }, false),
      reg.register({ id: "b", name: "B", path: `${PROJECTS}/b` }, true),
    ]);
    const out = await reg.read();
    expect(out.projects.map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(out.activeProjectId).toBe("b");
  });
});

describe("deleteProject → OS Recycle Bin (fs.trash)", () => {
  it("moves the project to the OS trash when fs.trash exists — no app .trash/ fallback", async () => {
    const { fs } = await mkCtx();
    const trashed: string[] = [];
    (fs as Any).trash = async (p: string) => {
      trashed.push(norm(p));
      await fs.remove(p); // OS trash removes it from its original location
    };
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const res = await reg.deleteProject("proj_active");
    expect(res.deleted).toBe(true);
    expect(trashed).toEqual([ACTIVE]); // the OS trash got the project dir
    expect(await fs.exists(ACTIVE)).toBe(false); // gone from its place
    expect(await fs.exists(`${DATA}/.trash`)).toBe(false); // did NOT use the app .trash/ fallback
    const registry = await readRegistry(fs);
    expect(registry.projects.some((p: Any) => p.id === "proj_active")).toBe(false); // deregistered
  });

  it("does NOT permanently delete when fs.trash throws — keeps the project (R12)", async () => {
    const { fs } = await mkCtx();
    (fs as Any).trash = async () => {
      throw new Error("trash denied");
    };
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const res = await reg.deleteProject("proj_active");
    expect(res.deleted).toBe(false);
    expect(res.trashFailed).toBe(true);
    expect(await fs.exists(ACTIVE)).toBe(true); // still on disk (NOT shredded)
    const registry = await readRegistry(fs);
    expect(registry.projects.some((p: Any) => p.id === "proj_active")).toBe(true); // still registered
  });
});

describe("deleteProject trash failure (R12)", () => {
  it("does NOT permanently delete when the trash move throws — keeps the project", async () => {
    const { fs } = await mkCtx();
    // The fs CAN rename, but the move throws (cross-volume / locked / no perms).
    (fs as Any).rename = async () => {
      throw new Error("EXDEV: cross-device link");
    };
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const res = await reg.deleteProject("proj_active");
    expect(res.deleted).toBe(false);
    expect(res.trashFailed).toBe(true);
    expect(res.active_project_id).toBe("proj_active"); // active id unchanged
    expect(await fs.exists(ACTIVE)).toBe(true); // project still on disk (NOT shredded)
    const registry = await readRegistry(fs);
    expect(registry.projects.some((p: Any) => p.id === "proj_active")).toBe(true); // still registered
  });

  it("permanently deletes only when explicitly confirmed", async () => {
    const { fs } = await mkCtx();
    (fs as Any).rename = async () => {
      throw new Error("EXDEV");
    };
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    await reg.deleteProject("proj_active"); // trash fails -> kept
    expect(await fs.exists(ACTIVE)).toBe(true);
    const res = await reg.deleteProject("proj_active", { permanent: true });
    expect(res.deleted).toBe(true);
    expect(await fs.exists(ACTIVE)).toBe(false); // shredded on explicit confirm
    const registry = await readRegistry(fs);
    expect(registry.projects.some((p: Any) => p.id === "proj_active")).toBe(false);
  });
});

describe("deleteProject tombstone (RF4)", () => {
  afterEach(() => reviveProjectDir(ACTIVE));

  it("marks the deleted dir dead so a late background write can't recreate it", async () => {
    const { fs } = await mkCtx();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const res = await reg.deleteProject("proj_active");
    expect(res.deleted).toBe(true);
    expect(await fs.exists(ACTIVE)).toBe(false); // MemFs has no rename -> hard removed
    expect(isProjectDirDead(ACTIVE)).toBe(true);

    // A writer still bound to the old dir fires AFTER the delete: it must no-op,
    // never resurrect the folder as orphan litter.
    const store = new ProjectStoreAccess(ACTIVE, fs);
    await store.writeProjectText(`${ACTIVE}/internals/transcript.json`, "{}");
    expect(await fs.exists(ACTIVE)).toBe(false); // still gone -- no ghost folder
    expect(await fs.exists(`${ACTIVE}/internals/transcript.json`)).toBe(false);
  });

  it("serializes a concurrent settings write against delete so the dir isn't resurrected (R6-6)", async () => {
    const { fs } = await mkCtx();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const jsonPath = `${ACTIVE}/internals/project.json`;
    // A settings RMW (updateProject -> writeProject) racing delete: the per-project
    // lock now serializes them, so whichever runs first the end state is the project
    // GONE + tombstoned, never a resurrected internals/project.json.
    await Promise.all([
      reg.updateProject("proj_active", (pj) => ({ ...pj, name: "Renamed" })),
      reg.deleteProject("proj_active"),
    ]);
    expect(isProjectDirDead(ACTIVE)).toBe(true);
    expect(await fs.exists(jsonPath)).toBe(false); // NOT recreated after the trash
  });

  it("does NOT tombstone when the trash move fails (project stays live)", async () => {
    const { fs } = await mkCtx();
    (fs as Any).rename = async () => {
      throw new Error("EXDEV");
    };
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const res = await reg.deleteProject("proj_active");
    expect(res.trashFailed).toBe(true);
    expect(isProjectDirDead(ACTIVE)).toBe(false); // still live -- writes must keep working
    const store = new ProjectStoreAccess(ACTIVE, fs);
    await store.writeProjectText(`${ACTIVE}/internals/note.txt`, "hi");
    expect(await fs.exists(`${ACTIVE}/internals/note.txt`)).toBe(true);
  });
});

describe("list_projects", () => {
  it("returns the active id + live projects", async () => {
    const { ctx } = await mkCtx();
    const r = (await listProjectsTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.active_project_id).toBe("proj_active");
    expect(r.projects).toHaveLength(1);
  });

  it("drops registry entries whose directory is gone", async () => {
    const { ctx, fs } = await mkCtx();
    const reg = await readRegistry(fs);
    reg.projects.push({
      id: "ghost",
      name: "Ghost",
      path: `${PROJECTS}/ghost`,
      lastOpenedAt: "2026-02-01T00:00:00Z",
    });
    await fs.writeTextFile(REGISTRY, JSON.stringify(reg));
    const r = (await listProjectsTool({}, ctx)) as Any;
    expect(r.projects.map((p: Any) => p.id)).toEqual(["proj_active"]); // ghost dropped
  });

  it("errors without a context", async () => {
    expect(((await listProjectsTool({}, null)) as Any).ok).toBe(false);
  });
});

describe("new_project", () => {
  it("scaffolds a project, seeds files, and sets it active", async () => {
    const { ctx, fs } = await mkCtx();
    const r = (await newProjectTool({ name: "My Reel", aspect_ratio: "16:9" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.canvas).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(await fs.exists(`${PROJECTS}/${r.id}`)).toBe(true);
    expect(await fs.exists(`${PROJECTS}/${r.id}/internals/timeline.json`)).toBe(true);
    const pj = JSON.parse(await fs.readTextFile(`${PROJECTS}/${r.id}/internals/project.json`));
    expect(pj.name).toBe("My Reel");
    expect(pj.settings.canvas.width).toBe(1920);
    // carries the current project's model forward (in project.json)
    expect(pj.settings.model_id).toBe("gpt-x");
    const reg = await readRegistry(fs);
    expect(reg.activeProjectId).toBe(r.id);
    expect(reg.projects.map((p: Any) => p.id)).toContain(r.id);
  });

  it("requires a name", async () => {
    const { ctx } = await mkCtx();
    const r = (await newProjectTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("name is required");
  });

  it("tells the caller it did NOT switch them, and how to switch", async () => {
    // It sets the APP's active project but leaves the caller's session where it was. The note
    // used to open "Created and set active", and an MCP agent read that as "I am on it now" —
    // then edited and exported the previous project while reporting the new one.
    const { ctx } = await mkCtx();
    const r = (await newProjectTool({ name: "Side Idea" }, ctx)) as Any;
    const note = String(r.note);
    expect(note).toMatch(/does NOT switch/i);
    expect(note).toContain("manage_project");
    expect(note).not.toMatch(/^Created and set active/);
  });
});

describe("project refs survive a scope-enforcing filesystem (desktop parity)", () => {
  // The desktop fs plugin does not answer `exists` for a path outside its allowed
  // scope - it THROWS. A bare project id (what list_projects hands the model) is not
  // an absolute path at all, so probing one raised "forbidden path: <id>" and took
  // down the whole call. MemFs answers false there, which is why every id-based test
  // above passed while open_project was broken for real users. This models the real
  // rule, and covers EVERY tool that resolves a ref - not just the one that was seen
  // failing: rename/duplicate were only ever exercised in their defaulting form.
  class ScopedFs extends MemFs {
    override async exists(p: string): Promise<boolean> {
      if (!norm(p).startsWith(DATA)) throw new Error(`forbidden path: ${p}`);
      return super.exists(p);
    }
  }

  async function scopedCtx(): Promise<{ ctx: ClientToolContext; fs: MemFs }> {
    const { ctx, fs } = await mkCtx();
    const scoped = new ScopedFs();
    (scoped as Any).files = (fs as Any).files;
    (scoped as Any).dirs = (fs as Any).dirs;
    return { ctx: { ...ctx, store: new ProjectStoreAccess(ACTIVE, scoped) }, fs: scoped };
  }

  it("open_project accepts a bare id", async () => {
    const { ctx } = await scopedCtx();
    await newProjectTool({ name: "Second" }, ctx); // moves active away
    const r = (await openProjectTool({ project: "proj_active" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.id).toBe("proj_active");
  });

  it("rename_project accepts a bare id", async () => {
    const { ctx } = await scopedCtx();
    const b = (await newProjectTool({ name: "Second" }, ctx)) as Any;
    const r = (await renameProjectTool({ project: b.id, name: "Renamed" }, ctx)) as Any;
    expect(r.ok).toBe(true);
  });

  it("duplicate_project accepts a bare id", async () => {
    const { ctx } = await scopedCtx();
    const b = (await newProjectTool({ name: "Second" }, ctx)) as Any;
    const r = (await duplicateProjectTool({ project: b.id }, ctx)) as Any;
    expect(r.ok).toBe(true);
  });

  it("delete_project accepts a bare id", async () => {
    const { ctx } = await scopedCtx();
    const b = (await newProjectTool({ name: "Second" }, ctx)) as Any;
    await openProjectTool({ project: "proj_active" }, ctx); // b must not be the open one
    const r = (await deleteProjectTool({ project: b.id }, ctx)) as Any;
    expect(r.ok).toBe(true);
  });

  it("still resolves a real directory path to its id, and still refuses one outside the root", async () => {
    const { ctx } = await scopedCtx();
    const b = (await newProjectTool({ name: "Second" }, ctx)) as Any;
    await openProjectTool({ project: "proj_active" }, ctx);
    const byPath = (await openProjectTool({ project: `${PROJECTS}/${b.id}` }, ctx)) as Any;
    expect(byPath.ok).toBe(true);
    expect(byPath.id).toBe(b.id);
    // A forbidden absolute path must degrade to "unknown project", never surface the
    // scope error and never resolve to a basename outside the projects root.
    const outside = (await openProjectTool({ project: "D:/elsewhere/proj_active" }, ctx)) as Any;
    expect(outside.ok).toBe(false);
    expect(String(outside.error)).not.toContain("forbidden");
  });
});

describe("open_project", () => {
  it("switches the active project by id", async () => {
    const { ctx, fs } = await mkCtx();
    const b = (await newProjectTool({ name: "Second" }, ctx)) as Any; // active = b
    const r = (await openProjectTool({ project: "proj_active" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.id).toBe("proj_active");
    expect((await readRegistry(fs)).activeProjectId).toBe("proj_active");
    expect(b.id).not.toBe("proj_active");
  });

  it("errors when the project is missing", async () => {
    const { ctx } = await mkCtx();
    const r = (await openProjectTool({ project: "nope" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("project not found");
  });

  it("requires a project ref", async () => {
    const { ctx } = await mkCtx();
    expect(((await openProjectTool({}, ctx)) as Any).ok).toBe(false);
  });

  it("refuses a project written by a NEWER schema (and does not switch to it)", async () => {
    const { ctx, fs } = await mkCtx();
    const b = (await newProjectTool({ name: "Second" }, ctx)) as Any; // active = b
    await fs.writeTextFile(
      `${ACTIVE}/internals/project.json`,
      JSON.stringify({ id: "proj_active", name: "Active", schemaVersion: 999 }),
    );
    const r = (await openProjectTool({ project: "proj_active" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain(`newer version of ${BRAND.displayName}`);
    expect((await readRegistry(fs)).activeProjectId).toBe(b.id); // stayed on b
  });

  it("opens a legacy project.json that has no schemaVersion stamp", async () => {
    const { ctx } = await mkCtx();
    const r = (await openProjectTool({ project: "proj_active" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.id).toBe("proj_active");
  });

  it("openProjectData opens the current schema as-is and refuses a newer one", async () => {
    const { fs } = await mkCtx();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const ok = await reg.openProjectData("proj_active");
    expect(ok.ok).toBe(true);
    await fs.writeTextFile(
      `${ACTIVE}/internals/project.json`,
      JSON.stringify({ schemaVersion: 5 }),
    );
    const refused = await reg.openProjectData("proj_active");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.tooNew).toBe(5);
      expect(refused.current).toBe(1);
    }
  });
});

describe("settings / rename close-gate fence (reviewer blocker 1)", () => {
  afterEach(async () => resetTestDocuments());

  it("REFUSES set_project_settings once the document's gate is CLOSING (settings vs closed gate)", async () => {
    const { ctx, fs } = await mkCtx();
    const doc = registerTestDocument(ACTIVE); // proj_active is OPEN as a document -> settings commits through its gate
    await doc.gate.beginClose(); // the project began closing -> admission closed
    // Now that the canvas change goes through the TIMELINE, the fence is the timeline
    // commit guard: it refuses instead of throwing, but the write still must not land.
    const r = (await setProjectSettingsTool({ width: 720, height: 1280 }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("closed");
    const tl = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/timeline.json`));
    expect(tl.canvas.width).toBe(1080); // the timeline never moved
    const pj = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`));
    expect(pj.settings.canvas.width).toBe(1080); // and the mirror was never reached
  });

  it("REJECTS rename_project once the document's gate is CLOSING", async () => {
    const { ctx, fs } = await mkCtx();
    const doc = registerTestDocument(ACTIVE);
    await doc.gate.beginClose();
    await expect(renameProjectTool({ name: "Nope" }, ctx)).rejects.toBeInstanceOf(
      ProjectClosingError,
    );
    expect(JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`)).name).toBe(
      "Active",
    ); // name unchanged
  });
});

describe("set_project_settings", () => {
  // The tool edits the ACTIVE timeline, so it commits through the open document's
  // gate — these tests need one registered.
  beforeEach(() => {
    registerTestDocument(ACTIVE);
  });
  afterEach(async () => resetTestDocuments());

  // The merge this guards: set_project_settings used to write ONLY project.json's
  // "default canvas for new timelines". There is no create_timeline tool, so nothing
  // ever read it — the model got "ok" while the video was untouched. It is now the ONE
  // canvas tool and must change the ACTIVE timeline; project.json only mirrors it.
  it("resizes the ACTIVE TIMELINE, and mirrors it into project.json", async () => {
    const { ctx, fs } = await mkCtx();
    const r = (await setProjectSettingsTool({ width: 720, height: 1280 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.resolution).toBe("720x1280");
    expect(r.fps).toBe(30); // fps kept from current
    await flushTestDocuments(); // the commit reaches disk on the document's autosave
    const tl = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/timeline.json`));
    expect(tl.canvas.width).toBe(720); // the thing that renders/exports
    expect(tl.canvas.height).toBe(1280);
    const pj = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`));
    expect(pj.settings.canvas).toEqual({ width: 720, height: 1280, fps: 30 }); // mirror, not a separate truth
  });

  it("changes fps on the TIMELINE and rescales clip frames (the work the old tool never did)", async () => {
    const { ctx, fs } = await mkCtx();
    await fs.writeTextFile(
      `${ACTIVE}/internals/timeline.json`,
      JSON.stringify({
        units: "frames",
        canvas: { width: 1080, height: 1920, fps: 30 },
        tracks: [
          {
            id: "v1",
            kind: "video",
            z: 1,
            clips: [{ id: "a", media_ref: "a.mp4", timeline_in: 0, timeline_out: 60 }],
          },
        ],
      }),
    );
    const r = (await setProjectSettingsTool({ fps: 60 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.changed).toContain("fps");
    await flushTestDocuments();
    const tl = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/timeline.json`));
    expect(tl.canvas.fps).toBe(60);
    // 2s at 30fps must still be 2s at 60fps — the clip doubles in frames.
    expect(tl.tracks[0].clips[0].timeline_out).toBe(120);
    const pj = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`));
    expect(pj.settings.canvas.fps).toBe(60);
  });

  it("leaves project.json untouched when the canvas change itself is refused", async () => {
    const { ctx, fs } = await mkCtx();
    const tiny = (await setProjectSettingsTool({ width: 1, height: 1 }, ctx)) as Any;
    expect(tiny.ok).toBe(false);
    const pj = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`));
    expect(pj.settings.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
  });

  it("rejects a lone dimension, and refuses a below-minimum canvas", async () => {
    const { ctx } = await mkCtx();
    const lone = (await setProjectSettingsTool({ width: 0 }, ctx)) as Any;
    expect(lone.ok).toBe(false);
    expect(String(lone.error)).toContain("together");
    // The 1x1 hole: a positive-but-absurd size used to be accepted here too.
    const tiny = (await setProjectSettingsTool({ width: 1, height: 1 }, ctx)) as Any;
    expect(tiny.ok).toBe(false);
    expect(String(tiny.error)).toContain("64");
  });

  it("coerces AGREEING aspect_ratio + quality + explicit width/height to the exact dims, silently", async () => {
    const { ctx } = await mkCtx();
    // 1:1 + 1080p + 1080x1080 all describe the same square -> use the exact dims, no complaint.
    const r = (await setProjectSettingsTool(
      { aspect_ratio: "1:1", quality: "1080p", width: 1080, height: 1080 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.resolution).toBe("1080x1080");
    expect(r.note).toBeUndefined();
  });

  it("coerces to width/height when the aspect_ratio disagrees, with a note", async () => {
    const { ctx } = await mkCtx();
    // 16:9 (1.78) vs a 1:1 frame -> explicit dims win; the ignored aspect is noted (no reject).
    const r = (await setProjectSettingsTool(
      { aspect_ratio: "16:9", width: 1080, height: 1080 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.resolution).toBe("1080x1080");
    expect(String(r.note)).toContain("aspect_ratio");
    expect(String(r.note)).toContain("ignored");
  });

  it("keeps the TIMELINE change when mirroring it into project.json fails", async () => {
    // The two writes are not one transaction. The timeline edit is the one the user
    // asked for and is already committed + undoable, so a failed mirror must NOT be
    // reported as a failed resize — it must say so and leave the video correct.
    const { ctx, fs } = await mkCtx();
    const spy = vi
      .spyOn(ProjectRegistry.prototype, "updateProject")
      .mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

    const r = (await setProjectSettingsTool({ width: 1280, height: 720 }, ctx)) as Any;
    expect(r.ok).toBe(true); // the resize DID happen
    expect(r.resolution).toBe("1280x720");
    expect(String(r.note)).toContain("ENOSPC"); // and the failure is named, not swallowed
    expect(String(r.note)).toContain("timeline is correct");

    await flushTestDocuments();
    const tl = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/timeline.json`));
    expect(tl.canvas.width).toBe(1280); // the video really is 1280x720
    const pj = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`));
    expect(pj.settings.canvas.width).toBe(1080); // the mirror is stale, as reported
    spy.mockRestore();
  });

  it("re-syncs the stale mirror on the next successful call", async () => {
    // The mirror is derived, so a transient failure must not need manual repair.
    const { ctx, fs } = await mkCtx();
    const spy = vi
      .spyOn(ProjectRegistry.prototype, "updateProject")
      .mockRejectedValueOnce(new Error("transient"));
    await setProjectSettingsTool({ width: 1280, height: 720 }, ctx);
    spy.mockRestore();

    const r = (await setProjectSettingsTool({ fps: 24 }, ctx)) as Any;
    expect(r.ok).toBe(true);
    await flushTestDocuments();
    const pj = JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`));
    expect(pj.settings.canvas).toEqual({ width: 1280, height: 720, fps: 24 }); // caught up
  });

  it("coerces to width/height when the quality preset disagrees, with a note", async () => {
    const { ctx } = await mkCtx();
    // 1920x1080 has a 1080px short edge, but quality says 720p -> dims win; quality noted.
    const r = (await setProjectSettingsTool(
      { quality: "720p", width: 1920, height: 1080 },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.resolution).toBe("1920x1080");
    expect(String(r.note)).toContain("quality");
    expect(String(r.note)).toContain("ignored");
  });
});

describe("rename_project", () => {
  it("renames the current project in project.json + registry", async () => {
    const { ctx, fs } = await mkCtx();
    const r = (await renameProjectTool({ name: "Renamed" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.id).toBe("proj_active");
    expect(JSON.parse(await fs.readTextFile(`${ACTIVE}/internals/project.json`)).name).toBe(
      "Renamed",
    );
    expect((await readRegistry(fs)).projects.find((p: Any) => p.id === "proj_active").name).toBe(
      "Renamed",
    );
  });

  it("writes the registry rename through the locked updateRegistry, not a raw write (F9)", async () => {
    const { ctx, fs } = await mkCtx();
    // The registry half of the rename must go through the per-registry lock so a
    // concurrent register/setActive/delete can't lose it (R10 class).
    const spy = vi.spyOn(ProjectRegistry.prototype, "updateRegistry");
    const r = (await renameProjectTool({ name: "Locked" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // exactly the registry rename (updateProject uses its own lock)
    expect((await readRegistry(fs)).projects.find((p: Any) => p.id === "proj_active").name).toBe(
      "Locked",
    );
    spy.mockRestore();
  });

  it("requires a name", async () => {
    const { ctx } = await mkCtx();
    expect(((await renameProjectTool({}, ctx)) as Any).ok).toBe(false);
  });

  it("errors on a missing explicit project", async () => {
    const { ctx } = await mkCtx();
    const r = (await renameProjectTool({ name: "x", project: "ghost" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("project not found");
  });
});

describe("duplicate_project", () => {
  it("copies the current project into a fresh active one", async () => {
    const { ctx, fs } = await mkCtx();
    const r = (await duplicateProjectTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.name).toBe("Active copy");
    expect(await fs.exists(`${PROJECTS}/${r.id}/internals/timeline.json`)).toBe(true); // media copied
    const pj = JSON.parse(await fs.readTextFile(`${PROJECTS}/${r.id}/internals/project.json`));
    expect(pj.id).toBe(r.id);
    expect(pj.name).toBe("Active copy");
    expect((await readRegistry(fs)).activeProjectId).toBe(r.id);
  });

  it("errors on a missing explicit project", async () => {
    const { ctx } = await mkCtx();
    const r = (await duplicateProjectTool({ project: "ghost" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("project not found");
  });

  it("does NOT copy the regeneratable derived cache (internals/cache) — authoritative only (invariant 29)", async () => {
    const { ctx, fs } = await mkCtx();
    await fs.writeTextFile(`${ACTIVE}/library/media_a.mp4`, "authoritative-bytes"); // owned media
    await fs.writeTextFile(`${ACTIVE}/internals/cache/gemini/enc.mp4`, "regeneratable"); // derived cache
    await fs.writeTextFile(`${ACTIVE}/internals/cache/downloads/dl.mp4`, "regeneratable");
    const r = (await duplicateProjectTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    const dup = `${PROJECTS}/${r.id}`;
    // Authoritative state IS copied...
    expect(await fs.exists(`${dup}/internals/timeline.json`)).toBe(true);
    expect(await fs.exists(`${dup}/library/media_a.mp4`)).toBe(true);
    // ...but the derived cache is NOT (it rebuilds on demand).
    expect(await fs.exists(`${dup}/internals/cache`)).toBe(false);
    expect(await fs.exists(`${dup}/internals/cache/gemini/enc.mp4`)).toBe(false);
    expect(await fs.exists(`${dup}/internals/cache/downloads/dl.mp4`)).toBe(false);
  });
});

describe("delete_project", () => {
  it("refuses to delete the currently-open project", async () => {
    const { ctx } = await mkCtx();
    const r = (await deleteProjectTool({ project: "proj_active" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("currently open");
  });

  it("deletes another project and reassigns active", async () => {
    const { ctx, fs } = await mkCtx();
    const b = (await newProjectTool({ name: "Doomed" }, ctx)) as Any; // active = b
    const r = (await deleteProjectTool({ project: b.id }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(true);
    expect(await fs.exists(`${PROJECTS}/${b.id}`)).toBe(false);
    expect(r.active_project_id).not.toBe(b.id); // reassigned away from the deleted active
  });

  it("requires a project id", async () => {
    const { ctx } = await mkCtx();
    const r = (await deleteProjectTool({}, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("never defaults");
  });

  it("errors when the project does not exist", async () => {
    const { ctx } = await mkCtx();
    const r = (await deleteProjectTool({ project: "ghost" }, ctx)) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("project not found");
  });
});

describe("project-id containment (R1)", () => {
  const TRAVERSAL = ["../../evil", "..", "../secret", "..\\..\\evil", "a/b"];

  it("open_project rejects every traversal-shaped ref and never leaves the projects root", async () => {
    const { ctx, fs } = await mkCtx();
    for (const ref of TRAVERSAL) {
      const r = (await openProjectTool({ project: ref }, ctx)) as Any;
      expect(r.ok).toBe(false);
    }
    // the active project is untouched by the refused opens (no escape / no switch)
    expect((await readRegistry(fs)).activeProjectId).toBe("proj_active");
  });

  it("rename_project + duplicate_project reject a traversal-shaped ref", async () => {
    const { ctx } = await mkCtx();
    expect(((await renameProjectTool({ name: "x", project: "../../evil" }, ctx)) as Any).ok).toBe(
      false,
    );
    expect(((await duplicateProjectTool({ project: "../../evil" }, ctx)) as Any).ok).toBe(false);
  });

  it("ProjectRegistry.deleteProject refuses an unsafe id without touching the filesystem", async () => {
    const { fs } = await mkCtx();
    const reg = ProjectRegistry.fromProjectDir(ACTIVE, fs);
    const before = await readRegistry(fs);
    const r = await reg.deleteProject("../../proj_active");
    expect(r.deleted).toBe(false);
    expect((await readRegistry(fs)).projects).toEqual(before.projects); // registry unchanged
    expect(await fs.exists(ACTIVE)).toBe(true); // the real dir was never removed
  });
});

describe("get_project_state", () => {
  it("surfaces project.json config", async () => {
    const { ctx } = await mkCtx();
    const r = (await getProjectStateTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.project_id).toBe("proj_active");
    expect(r.model_id).toBe("gpt-x");
    expect(r.name).toBe("Active");
    expect(r.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
  });

  it("hands the model no path into the project, only media_refs", async () => {
    // The model addresses project media by media_ref; an absolute path is only ever for
    // media that lives OUTSIDE the project. This used to list internals/cache/{downloads,audio}
    // — a directory duplicate_project deliberately does not copy — as if it were the inventory.
    const { ctx, fs } = await mkCtx();
    await fs.writeTextFile(`${ACTIVE}/internals/cache/downloads/a.mp4`, "x");
    await fs.writeTextFile(`${ACTIVE}/internals/cache/audio/vo.wav`, "x");
    await fs.writeTextFile(
      `${ACTIVE}/internals/library.json`,
      JSON.stringify({
        version: 1,
        clips: [{ id: "media_dl", path: "library/media_dl.mp4", filename: "a.mp4", kind: "video" }],
      }),
    );
    const r = (await getProjectStateTool({}, ctx)) as Any;
    expect(r.downloads).toBeUndefined();
    expect(r.audio).toBeUndefined();
    // Assert on the whole payload, not the two fields I happen to remember: any future field
    // carrying an internals path fails here too.
    expect(JSON.stringify(r)).not.toContain("internals");
    // The download is still reachable — as the ref every other tool takes.
    expect(r.library).toEqual([
      { media_ref: "media_dl", filename: "a.mp4", kind: "video", folder: null },
    ]);
  });

  it("reports the library, so an imported asset is not invisible to the model", async () => {
    // The reported failure: a user attached a reference video, the tool answered with two
    // empty CACHE folders, and the model told them "there's nothing to append from the
    // project library yet" and asked them to re-send their own assets.
    const { ctx, fs } = await mkCtx();
    await fs.writeTextFile(
      `${ACTIVE}/internals/library.json`,
      JSON.stringify({
        version: 1,
        clips: [
          {
            id: "media_abc123",
            path: "library/media_abc123.mp4",
            filename: "ref.mp4",
            kind: "video",
            folder: "B-roll",
          },
        ],
      }),
    );
    const r = (await getProjectStateTool({}, ctx)) as Any;
    expect(r.library_count).toBe(1);
    expect(r.library[0]).toMatchObject({
      media_ref: "media_abc123",
      filename: "ref.mp4",
      kind: "video",
      folder: "B-roll",
    });
  });

  it("says when the library list is capped instead of letting it read as complete", async () => {
    const { ctx, fs } = await mkCtx();
    const clips = Array.from({ length: 75 }, (_, i) => ({
      id: `media_${i}`,
      path: `library/media_${i}.mp4`,
      filename: `${i}.mp4`,
      kind: "video",
    }));
    await fs.writeTextFile(
      `${ACTIVE}/internals/library.json`,
      JSON.stringify({ version: 1, clips }),
    );
    const r = (await getProjectStateTool({}, ctx)) as Any;
    expect(r.library_count).toBe(75);
    expect(r.library.length).toBeLessThan(75);
    expect(r.library_truncated).toMatch(/library_op/);
  });

  it("reports an empty library as empty, not as absent", async () => {
    const { ctx } = await mkCtx();
    const r = (await getProjectStateTool({}, ctx)) as Any;
    expect(r.library).toEqual([]);
    expect(r.library_count).toBe(0);
    expect(r.library_truncated).toBeUndefined();
  });

  it("errors without a context", async () => {
    expect(((await getProjectStateTool({}, null)) as Any).ok).toBe(false);
  });
});

describe("project tools — edge cases", () => {
  it("get_project_state falls back to defaults with no project.json", async () => {
    const { ctx, fs } = await mkCtx();
    fs.files.delete(`${ACTIVE}/internals/project.json`);
    const r = (await getProjectStateTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.project_id).toBe("proj_active");
    expect(r.model_id).toBe("");
    expect(r.name).toBeNull();
    expect(r.canvas).toBeNull();
  });

  it("open_project resolves a project given its directory path", async () => {
    const { ctx } = await mkCtx();
    const b = (await newProjectTool({ name: "PathOpen" }, ctx)) as Any;
    const r = (await openProjectTool({ project: `${PROJECTS}/${b.id}` }, ctx)) as Any; // full dir path, not id
    expect(r.ok).toBe(true);
    expect(r.id).toBe(b.id);
  });

  it("duplicate_project honours an explicit name", async () => {
    const { ctx } = await mkCtx();
    const r = (await duplicateProjectTool({ name: "Clone X" }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.name).toBe("Clone X");
  });

  it("treats a corrupt registry as empty", async () => {
    const { ctx, fs } = await mkCtx();
    await fs.writeTextFile(REGISTRY, "{ not json");
    const r = (await listProjectsTool({}, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.active_project_id).toBeNull();
    expect(r.projects).toEqual([]);
  });
});
