// Referenced media lives outside the project, so it can move or vanish between import and
// export. Premiere's answer is Media Offline + one Link Media pass that relinks a whole moved
// folder; these assert the CATALOG that results, not that some helper was called.
import { describe, expect, it } from "vitest";

import { copyIntoProject, offlineClips, offlineUnderPlayhead, relinkMedia } from "./mediaLink";
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

describe("offlineUnderPlayhead", () => {
  const clip = (ref: string, from: number, to: number) => ({
    media_ref: ref,
    timeline_in: from,
    timeline_out: to,
  });
  const tl = (...tracks: { clips: ReturnType<typeof clip>[] }[]) => ({ tracks });

  it("names the offline media the playhead is sitting on", () => {
    const t = tl({ clips: [clip("media_a", 0, 100)] });
    expect(offlineUnderPlayhead(t, 50, ["media_a"])).toEqual(["media_a"]);
  });

  it("says NOTHING over healthy media", () => {
    // The failure direction that matters: a banner over footage that plays fine teaches the
    // user to ignore the banner, which costs more than never showing one.
    const t = tl({ clips: [clip("media_ok", 0, 100)] });
    expect(offlineUnderPlayhead(t, 50, ["media_a"])).toEqual([]);
  });

  it("treats the span as half-open, like every other span check here", () => {
    const t = tl({ clips: [clip("media_a", 10, 20)] });
    expect(offlineUnderPlayhead(t, 9, ["media_a"]), "before the clip").toEqual([]);
    expect(offlineUnderPlayhead(t, 10, ["media_a"]), "first frame is covered").toEqual([
      "media_a",
    ]);
    expect(offlineUnderPlayhead(t, 20, ["media_a"]), "the out frame is NOT covered").toEqual([]);
  });

  it("finds it on a LOWER track, not just the first one it looks at", () => {
    // Picking the easiest member to verify is how a per-track bug ships: the offline clip is
    // as likely to be on v3 as on v1.
    const t = tl({ clips: [clip("media_ok", 0, 100)] }, { clips: [] }, {
      clips: [clip("media_a", 0, 100)],
    });
    expect(offlineUnderPlayhead(t, 50, ["media_a"])).toEqual(["media_a"]);
  });

  it("names each offline source once, however many clips use it", () => {
    const t = tl({ clips: [clip("media_a", 0, 100)] }, { clips: [clip("media_a", 0, 100)] });
    expect(offlineUnderPlayhead(t, 50, ["media_a"])).toEqual(["media_a"]);
  });

  it("is inert with nothing offline or no timeline", () => {
    expect(offlineUnderPlayhead(tl({ clips: [clip("media_a", 0, 100)] }), 50, [])).toEqual([]);
    expect(offlineUnderPlayhead(null, 50, ["media_a"])).toEqual([]);
  });
});
