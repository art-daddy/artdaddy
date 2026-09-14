// Referenced media lives outside the project, so it can move or vanish between import and
// export. Premiere's answer is Media Offline + one Link Media pass that relinks a whole moved
// folder; these assert the CATALOG that results, not that some helper was called.
import { describe, expect, it } from "vitest";

import { copyIntoProject, offlineClips, relinkMedia } from "./mediaLink";
import type { ProjectStoreAccess } from "../tools/store";

/** A store over an in-memory disk: `present` is the set of paths that exist. */
function fakeStore(clips: Record<string, unknown>[], present: string[]) {
  const disk = new Set(present);
  const copied: Array<[string, string]> = [];
  let catalog = JSON.stringify({ version: 1, clips });
  const store = {
    projectDir: "C:/proj",
    exists: async (p: string) => disk.has(p),
    readJson: async () => JSON.parse(catalog) as unknown,
    writeTextAtomic: async (_p: string, c: string) => {
      catalog = c;
      return true;
    },
    sessionLive: () => true,
    copyFile: async (src: string, dst: string) => {
      copied.push([src, dst]);
      disk.add(dst);
    },
  } as unknown as ProjectStoreAccess;
  return {
    store,
    copied,
    disk,
    clips: () => (JSON.parse(catalog) as { clips: Record<string, unknown>[] }).clips,
  };
}

const ext = (id: string, path: string, filename: string) => ({
  id,
  path,
  filename,
  kind: "video",
  external: true,
});

describe("offlineClips", () => {
  it("reports a referenced file the user moved, and only that one", async () => {
    const { store } = fakeStore(
      [
        ext("media_a", "D:/shoot/a.mp4", "a.mp4"),
        ext("media_b", "D:/shoot/b.mp4", "b.mp4"),
        { id: "media_c", path: "library/media_c.mp4", filename: "c.mp4", kind: "video" },
      ],
      ["D:/shoot/b.mp4", "C:/proj/library/media_c.mp4"],
    );
    expect((await offlineClips(store)).map((c) => c.id)).toEqual(["media_a"]);
  });

  it("never reports media that lives inside the project", async () => {
    // A copied clip cannot go offline; claiming otherwise would send the user
    // hunting for a file that was never theirs to move.
    const { store } = fakeStore(
      [{ id: "media_c", path: "library/media_c.mp4", filename: "c.mp4", kind: "video" }],
      [],
    );
    expect(await offlineClips(store)).toEqual([]);
  });
});

describe("relinkMedia", () => {
  it("relinks the whole moved folder from ONE located file", async () => {
    const { store, clips } = fakeStore(
      [
        ext("media_a", "D:/shoot/a.mp4", "a.mp4"),
        ext("media_b", "D:/shoot/b.mp4", "b.mp4"),
        ext("media_c", "D:/shoot/c.mp4", "c.mp4"),
      ],
      ["E:/moved/a.mp4", "E:/moved/b.mp4", "E:/moved/c.mp4"],
    );
    const res = await relinkMedia(store, "media_a", "E:/moved/a.mp4");
    expect(res.relinked.sort()).toEqual(["media_a", "media_b", "media_c"]);
    expect(res.remaining).toBe(0);
    expect(clips().map((c) => c.path)).toEqual([
      "E:/moved/a.mp4",
      "E:/moved/b.mp4",
      "E:/moved/c.mp4",
    ]);
  });

  it("leaves a clip that is still online exactly where it is", async () => {
    // The failure direction: a sweep that rewrote healthy clips would repoint media the
    // user never moved, and the next export would read the wrong file.
    const { store, clips } = fakeStore(
      [ext("media_a", "D:/shoot/a.mp4", "a.mp4"), ext("media_b", "F:/other/b.mp4", "b.mp4")],
      ["E:/moved/a.mp4", "F:/other/b.mp4", "E:/moved/b.mp4"],
    );
    await relinkMedia(store, "media_a", "E:/moved/a.mp4");
    expect(clips().find((c) => c.id === "media_b")?.path).toBe("F:/other/b.mp4");
  });

  it("reports what is still missing when the folder does not hold everything", async () => {
    const { store } = fakeStore(
      [ext("media_a", "D:/shoot/a.mp4", "a.mp4"), ext("media_b", "D:/shoot/b.mp4", "b.mp4")],
      ["E:/moved/a.mp4"],
    );
    const res = await relinkMedia(store, "media_a", "E:/moved/a.mp4");
    expect(res.relinked).toEqual(["media_a"]);
    expect(res.remaining).toBe(1);
  });
});

describe("copyIntoProject", () => {
  it("copies the file in and stops the entry depending on the original location", async () => {
    const { store, copied, clips } = fakeStore(
      [ext("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4"],
    );
    const res = await copyIntoProject(store, "media_a");
    expect(res).toEqual({ ok: true, path: "library/media_a.mp4" });
    expect(copied).toEqual([["D:/shoot/a.mp4", "C:/proj/library/media_a.mp4"]]);
    const row = clips()[0];
    expect(row.path).toBe("library/media_a.mp4");
    expect(row.external).toBeUndefined(); // no longer a reference
  });

  it("refuses when the original is offline instead of writing an empty file", async () => {
    const { store, copied } = fakeStore([ext("media_a", "D:/shoot/a.mp4", "a.mp4")], []);
    const res = await copyIntoProject(store, "media_a");
    expect(res.ok).toBe(false);
    expect(copied).toEqual([]);
  });

  it("is a no-op for media already inside the project", async () => {
    const { store, copied } = fakeStore(
      [{ id: "media_c", path: "library/media_c.mp4", filename: "c.mp4", kind: "video" }],
      ["C:/proj/library/media_c.mp4"],
    );
    expect(await copyIntoProject(store, "media_c")).toEqual({
      ok: true,
      path: "library/media_c.mp4",
    });
    expect(copied).toEqual([]);
  });
});
