import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IDENTITY } from "../brand";

// The UI-side id -> directory resolver reads the recents file through Tauri's fs, so the
// plugin is the only thing faked. Everything else is the real module: the point is to prove
// the RULE (a recorded path wins, the id is still validated first), not that a mock was called.
const readTextFile = vi.fn<(p: string) => Promise<string>>();
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: (p: string) => readTextFile(p) }));
vi.mock("@tauri-apps/api/path", () => ({ dataDir: async () => "C:/Users/me/AppData/Roaming" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));

const { boundProjectId, isSafeProjectId, projectDirFor, projectIdOfDir } =
  await import("./dataRoot");

// Derived from the brand, not spelled out: a hardcoded folder name here survived the rename
// and asserted the OLD data root against the new resolver.
const DEFAULT = `C:/Users/me/AppData/Roaming/${IDENTITY.dataFolder}/projects/hero_a1b2c3`;

function registry(entries: unknown[]): void {
  readTextFile.mockResolvedValue(JSON.stringify({ version: 1, projects: entries }));
}

describe("projectDirFor", () => {
  beforeEach(() => {
    readTextFile.mockReset();
  });

  it("returns the default location for a project that never moved", async () => {
    registry([{ id: "hero_a1b2c3", path: DEFAULT }]);
    expect(await projectDirFor("hero_a1b2c3")).toBe(DEFAULT);
    // Nothing to bind: the folder name already IS the id, so openDocumentByDir's basename
    // derivation is exact and must not be shadowed by a stale entry.
    expect(boundProjectId(DEFAULT)).toBe("");
  });

  it("follows a project that was saved somewhere else, and binds dir -> id", async () => {
    registry([{ id: "hero_a1b2c3", path: "D:/Client Work/Hero Cut" }]);
    expect(await projectDirFor("hero_a1b2c3")).toBe("D:/Client Work/Hero Cut");
    // Without this binding openDocumentByDir would read the basename ("Hero Cut"), find no
    // document, and the mutation executor would fall back to a bare lock — every commit
    // slipping past the admission gate.
    expect(boundProjectId("D:/Client Work/Hero Cut")).toBe("hero_a1b2c3");
    expect(boundProjectId("D:\\Client Work\\Hero Cut\\")).toBe("hero_a1b2c3");
  });

  it("validates the id BEFORE consulting the registry", async () => {
    // A crafted route param must never reach the lookup, whatever the file claims.
    registry([{ id: "../../../evil", path: "C:/Windows/System32" }]);
    await expect(projectDirFor("../../../evil")).rejects.toThrow(/unsafe project id/);
    await expect(projectDirFor("UPPER")).rejects.toThrow(/unsafe project id/);
  });

  it("ignores a recorded path that is not absolute, and an unreadable registry", async () => {
    // A relative path would resolve against the process's working directory.
    registry([{ id: "hero_a1b2c3", path: "Client Work/Hero" }]);
    expect(await projectDirFor("hero_a1b2c3")).toBe(DEFAULT);
    registry([{ id: "hero_a1b2c3", path: 42 }]);
    expect(await projectDirFor("hero_a1b2c3")).toBe(DEFAULT);
    readTextFile.mockRejectedValue(new Error("no such file"));
    expect(await projectDirFor("hero_a1b2c3")).toBe(DEFAULT);
    readTextFile.mockResolvedValue("{not json");
    expect(await projectDirFor("hero_a1b2c3")).toBe(DEFAULT);
  });

  it("drops a stale binding when a project moves BACK to the default folder", async () => {
    // The failure direction: a binding that outlives the move would keep resolving the old
    // folder to this id long after another project could legitimately occupy that name.
    registry([{ id: "hero_a1b2c3", path: "D:/Client Work/Hero Cut" }]);
    await projectDirFor("hero_a1b2c3");
    expect(boundProjectId("D:/Client Work/Hero Cut")).toBe("hero_a1b2c3");
    registry([{ id: "hero_a1b2c3", path: DEFAULT }]);
    expect(await projectDirFor("hero_a1b2c3")).toBe(DEFAULT);
    expect(boundProjectId(DEFAULT)).toBe("");
  });
});

// What the app reports as `project_id`, and what finds a folder's open document. Seen live: an
// import reported the whole folder path, the user's name inside it.
describe("projectIdOfDir", () => {
  beforeEach(() => {
    readTextFile.mockReset();
  });

  it("is the folder's name in the default layout, where a project sits under its id", () => {
    expect(projectIdOfDir(DEFAULT)).toBe("hero_a1b2c3");
    expect(projectIdOfDir(`${DEFAULT}//`)).toBe("hero_a1b2c3");
    expect(projectIdOfDir(`${DEFAULT.replace(/\//g, "\\")}\\`)).toBe("hero_a1b2c3");
  });

  it("is the id a project moved with Save As is bound to, not its folder's name", async () => {
    registry([{ id: "hero_a1b2c3", path: "D:/Client Work/hero_cut" }]);
    await projectDirFor("hero_a1b2c3");
    // The folder's name can be an id and still not be this project's: the binding wins.
    expect(projectIdOfDir("D:/Client Work/hero_cut")).toBe("hero_a1b2c3");
    expect(projectIdOfDir("D:\\Client Work\\hero_cut\\")).toBe("hero_a1b2c3");
  });

  it("is nothing for a folder that cannot be an id and that nobody bound", () => {
    for (const dir of ["E:/Edits/Wedding Final", "C:/Users/someone/Videos/MyCut", "D:/a/b-c"])
      expect(projectIdOfDir(dir)).toBe("");
    for (const dir of ["", "///", "C:/", "C:\\"]) expect(projectIdOfDir(dir)).toBe("");
  });

  it("property: whatever the folder, the answer is an id or nothing, never a path", () => {
    fc.assert(
      fc.property(fc.string(), (dir) => {
        const id = projectIdOfDir(dir);
        expect(id === "" || isSafeProjectId(id)).toBe(true);
      }),
    );
  });

  it("property: a project's id is kept whole under any folder, by either separator", () => {
    const ids = fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_"), {
        minLength: 1,
        maxLength: 64,
      })
      .map((cs) => cs.join(""))
      .filter((id) => isSafeProjectId(id));
    const folder = fc.string({ minLength: 1 }).filter((s) => !/[\\/]/.test(s));
    fc.assert(
      fc.property(
        fc.array(folder, { maxLength: 4 }),
        ids,
        fc.constantFrom("/", "\\"),
        (parents, id, sep) => {
          expect(projectIdOfDir([...parents, id].join(sep))).toBe(id);
        },
      ),
    );
  });
});
