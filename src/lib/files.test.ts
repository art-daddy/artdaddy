import { describe, expect, it, vi } from "vitest";

import { listProjectFiles, walkProjectDir } from "./files";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "../tools/store";

type Tree = Record<string, DirEntry[]>;
const d = (name: string): DirEntry => ({ name, isDirectory: true });
const f = (name: string): DirEntry => ({ name, isDirectory: false });

function fakeFs(tree: Tree, throwOn: string[] = []) {
  return {
    readDir: vi.fn(async (p: string): Promise<DirEntry[]> => {
      if (throwOn.includes(p)) throw new Error("EACCES");
      return tree[p] ?? [];
    }),
  };
}

describe("walkProjectDir", () => {
  it("shows only the library at the root; hides internal files, dotfiles + the manifest", async () => {
    const fs = fakeFs({
      "C:/proj": [d("library"), f("timeline.json"), d("internals")],
      "C:/proj/library": [f("a.mp4"), f("b.png")],
    });
    const tree = await walkProjectDir(fs, "C:/proj");
    expect(tree).toEqual([
      {
        name: "library",
        path: "library",
        type: "dir",
        children: [
          { name: "a.mp4", path: "library/a.mp4", type: "file" },
          { name: "b.png", path: "library/b.png", type: "file" },
        ],
      },
    ]);
  });

  it("returns [] for a directory whose read fails", async () => {
    const fs = fakeFs({ "C:/proj": [d("library")] }, ["C:/proj/library"]);
    const tree = await walkProjectDir(fs, "C:/proj");
    expect(tree).toEqual([{ name: "library", path: "library", type: "dir", children: [] }]);
  });

  it("returns [] when the fs cannot list directories", async () => {
    expect(await walkProjectDir({}, "C:/proj")).toEqual([]);
  });
});

describe("listProjectFiles", () => {
  /** The panel's real source is the fs walk PLUS the catalog; tests must supply both, to the REAL
   *  store, so the offline rule under test is the one the app runs. `present` is the set of
   *  absolute paths that exist, so a linked file can be missing. */
  const mkStore = (
    readDir: FsLike["readDir"],
    clips: unknown[] = [],
    present: string[] = [],
  ): ProjectStoreAccess => {
    const files = new Map([
      [joinPath("C:/proj", "internals", "library.json"), JSON.stringify({ clips })],
    ]);
    for (const p of present) files.set(joinPath(p), "");
    return new ProjectStoreAccess("C:/proj", {
      readDir,
      exists: async (p) => files.has(joinPath(p)),
      readTextFile: async (p) => {
        const v = files.get(joinPath(p));
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
      },
      writeTextFile: async () => undefined,
      mkdir: async () => undefined,
    });
  };

  it("returns the library's contents at the tree root (desktop)", async () => {
    const fs = fakeFs({
      "C:/proj": [d("library"), f("timeline.json")],
      "C:/proj/library": [d("clips"), f("library.json")],
      "C:/proj/library/clips": [f("a.mp4")],
    });
    const store = mkStore(fs.readDir);
    const tree = await listProjectFiles("proj", store);
    expect(tree).toEqual([
      {
        name: "clips",
        path: "library/clips",
        type: "dir",
        children: [{ name: "a.mp4", path: "library/clips/a.mp4", type: "file" }],
      },
    ]);
  });

  it("is empty when the project has no library yet (desktop)", async () => {
    const fs = fakeFs({ "C:/proj": [f("timeline.json")] });
    const store = mkStore(fs.readDir);
    expect(await listProjectFiles("proj", store)).toEqual([]);
  });

  it("is empty when there is no store (no desktop client)", async () => {
    expect(await listProjectFiles("proj", null)).toEqual([]);
  });

  // Referenced-in-place media has no file under library/, so the directory walk
  // alone reported "No files yet" for a project whose media was linked, not copied.
  it("lists EXTERNAL catalog media that has no file under library/", async () => {
    const fs = fakeFs({ "C:/proj": [f("timeline.json")] });
    const store = mkStore(
      fs.readDir,
      [
        {
          id: "media_abc",
          filename: "holiday.mp4",
          path: "C:/Users/me/holiday.mp4",
          external: true,
        },
      ],
      ["C:/Users/me/holiday.mp4"],
    );
    // Keyed by media id, not the absolute path: that is what resolveRef() accepts.
    expect(await listProjectFiles("proj", store)).toEqual([
      { name: "holiday.mp4", path: "media_abc", type: "file", offline: false },
    ]);
  });

  // The user can move or delete their own file at any time; the panel has to say so rather
  // than show a normal-looking tile that fails at export.
  it("marks a linked file whose source is gone as offline", async () => {
    const fs = fakeFs({ "C:/proj": [f("timeline.json")] });
    const store = mkStore(
      fs.readDir,
      [{ id: "media_abc", filename: "holiday.mp4", path: "D:/gone/holiday.mp4", external: true }],
      [], // nothing on disk
    );
    expect((await listProjectFiles("proj", store))[0]).toMatchObject({ offline: true });
  });

  // The tile carries the name the file was imported under; an older row without one is named by
  // its file, never by the folders it sat in.
  it("names a linked file as imported, else by its file", async () => {
    const fs = fakeFs({ "C:/proj": [f("timeline.json")] });
    const store = mkStore(
      fs.readDir,
      [
        {
          id: "media_a",
          filename: "Holiday.mp4",
          path: "C:/Users/me/IMG_0042.mp4",
          external: true,
        },
        { id: "media_b", path: "C:/Users/me/Trip/IMG_0043.mp4", external: true },
      ],
      ["C:/Users/me/IMG_0042.mp4", "C:/Users/me/Trip/IMG_0043.mp4"],
    );
    expect((await listProjectFiles("proj", store)).map((n) => n.name)).toEqual([
      "Holiday.mp4",
      "IMG_0043.mp4",
    ]);
  });

  it("does not duplicate COPIED media, which the walk already found", async () => {
    const fs = fakeFs({
      "C:/proj": [d("library")],
      "C:/proj/library": [f("media_xyz.mp4"), f("library.json")],
    });
    const store = mkStore(fs.readDir, [
      { id: "media_xyz", filename: "clip.mp4", path: "library/media_xyz.mp4" },
    ]);
    expect(await listProjectFiles("proj", store)).toEqual([
      { name: "media_xyz.mp4", path: "library/media_xyz.mp4", type: "file" },
    ]);
  });

  it("shows both kinds together, sorted by name", async () => {
    const fs = fakeFs({
      "C:/proj": [d("library")],
      "C:/proj/library": [f("zebra.mp4")],
    });
    const store = mkStore(
      fs.readDir,
      [{ id: "media_a", filename: "apple.mp4", path: "C:/ext/apple.mp4", external: true }],
      ["C:/ext/apple.mp4"],
    );
    expect((await listProjectFiles("proj", store)).map((n) => n.name)).toEqual([
      "apple.mp4",
      "zebra.mp4",
    ]);
  });
});
