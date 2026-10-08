// Referenced media lives outside the project, so it can move or vanish between import and
// export. Premiere's answer is Media Offline + one Link Media pass that relinks a whole moved
// folder. These run the REAL store and mutation gate over an in-memory disk, and assert the
// CATALOG that results and who hears of it: Relink and Copy into project used to write the
// catalog outside the gate and tell nobody, so the editor kept calling a relinked file offline.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyIntoProject, offlineUnderPlayhead, relinkMedia } from "./mediaLink";
import { endProjectSession } from "../tools/coordinator";
import { registerLibraryClip } from "../tools/import";
import { writeLibraryCatalog } from "../tools/libraryCatalog";
import { INTERNAL_DIR, joinPath, ProjectStoreAccess } from "../tools/store";
import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";

const DIR = "C:/proj";
const CATALOG = joinPath(DIR, INTERNAL_DIR, "library.json");

/** The in-memory disk, plus the binary writes an import makes and a log of every copy. */
class DiskFs extends MemFs {
  copied: Array<[string, string]> = [];
  /** Runs inside a copy, after the bytes landed: the moment a racing write can slip in. */
  duringCopy: (() => Promise<void>) | null = null;
  /** A disk that refuses the catalog write (permissions, a full disk). */
  failCatalogWrites = false;
  async writeTextFile(p: string, c: string): Promise<void> {
    if (this.failCatalogWrites && joinPath(p).startsWith(joinPath(DIR, INTERNAL_DIR)))
      throw new Error(`EACCES: permission denied, open '${p}'`);
    return super.writeTextFile(p, c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readTextFile(p));
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.files.set(joinPath(p), new TextDecoder().decode(b));
  }
  async copyFile(src: string, dst: string): Promise<void> {
    this.copied.push([src, dst]);
    this.files.set(joinPath(dst), await this.readTextFile(src));
    await this.duringCopy?.();
  }
}

const linked = (id: string, path: string, filename: string, kind = "video") => ({
  id,
  path,
  filename,
  kind,
  external: true,
});

/** A project whose catalog holds `clips`; `onDisk` are the absolute paths that exist. */
function project(clips: Record<string, unknown>[], onDisk: string[]) {
  const fs = new DiskFs();
  fs.files.set(CATALOG, JSON.stringify({ version: 1, clips, folders: [] }));
  for (const p of onDisk) fs.files.set(joinPath(p), "bytes");
  const doc = registerTestDocument(DIR);
  return { fs, doc, store: new ProjectStoreAccess(DIR, fs) };
}

const rows = (fs: DiskFs): Array<Record<string, unknown>> =>
  (JSON.parse(fs.files.get(CATALOG) ?? "{}") as { clips: Array<Record<string, unknown>> }).clips;
const row = (fs: DiskFs, id: string) => rows(fs).find((r) => r.id === id);

/** Counts the library-changed announcements (trailing-debounced at the source). */
function heard(): { count: () => number; stop: () => void } {
  let n = 0;
  const on = (): void => {
    n += 1;
  };
  window.addEventListener("artdaddy:files-changed", on);
  return { count: () => n, stop: () => window.removeEventListener("artdaddy:files-changed", on) };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

beforeEach(settle);
afterEach(resetTestDocuments);

// Every reader re-reads on the announcement, so it must mean "the catalog changed": a write abandoned
// for a project that was closed changed nothing.
describe("writeLibraryCatalog", () => {
  it("announces a write that landed, and not one abandoned for a closed project", async () => {
    const { fs, store } = project([], []);
    const h = heard();
    try {
      expect(
        await writeLibraryCatalog(store, { version: 1, clips: [linked("m", "D:/a.mp4", "a.mp4")] }),
      ).toBe(true);
      await settle();
      expect(h.count()).toBe(1);
      const landed = fs.files.get(CATALOG);

      endProjectSession(DIR);
      expect(await writeLibraryCatalog(store, { version: 1, clips: [] })).toBe(false);
      await settle();
      expect(h.count()).toBe(1);
      expect(fs.files.get(CATALOG)).toBe(landed);
    } finally {
      h.stop();
    }
  });
});

describe("relinkMedia", () => {
  it("relinks the whole moved folder from ONE located file", async () => {
    const { fs, store } = project(
      [
        linked("media_a", "D:/shoot/a.mp4", "a.mp4"),
        linked("media_b", "D:/shoot/b.mp4", "b.mp4"),
        linked("media_c", "D:/shoot/c.mp4", "c.mp4"),
      ],
      ["E:/moved/a.mp4", "E:/moved/b.mp4", "E:/moved/c.mp4"],
    );
    expect(await relinkMedia(store, "media_a", "E:/moved/a.mp4")).toEqual({
      ok: true,
      relinked: ["media_a", "media_b", "media_c"],
      remaining: 0,
    });
    expect(rows(fs).map((c) => c.path)).toEqual([
      "E:/moved/a.mp4",
      "E:/moved/b.mp4",
      "E:/moved/c.mp4",
    ]);
  });

  it("leaves a clip that is still online exactly where it is", async () => {
    // The failure direction: a sweep that rewrote healthy clips would repoint media the
    // user never moved, and the next export would read the wrong file.
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4"), linked("media_b", "F:/other/b.mp4", "b.mp4")],
      ["E:/moved/a.mp4", "F:/other/b.mp4", "E:/moved/b.mp4"],
    );
    await relinkMedia(store, "media_a", "E:/moved/a.mp4");
    expect(row(fs, "media_b")?.path).toBe("F:/other/b.mp4");
  });

  it("reports what is still missing when the folder does not hold everything", async () => {
    const { store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4"), linked("media_b", "D:/shoot/b.mp4", "b.mp4")],
      ["E:/moved/a.mp4"],
    );
    expect(await relinkMedia(store, "media_a", "E:/moved/a.mp4")).toEqual({
      ok: true,
      relinked: ["media_a"],
      remaining: 1,
    });
  });

  // A relinked entry's path can end in another name ("b (1).mp4"); the name it was imported under
  // is the handle the user knows it by, and the one the moved folder holds.
  it("matches and names files by the name they were imported under", async () => {
    const { fs, store } = project(
      [
        linked("media_a", "D:/shoot/take_7.mp3", "Interview.mp3", "audio"),
        linked("media_b", "D:/shoot/b (1).mp4", "b.mp4"),
      ],
      ["E:/moved/take_7.jpg", "E:/moved/take_7.mp3", "E:/moved/b.mp4"],
    );
    const refused = await relinkMedia(store, "media_a", "E:/moved/take_7.jpg");
    expect(String(!refused.ok && refused.error)).toContain("cannot stand in for 'Interview.mp3'");
    expect(await relinkMedia(store, "media_a", "E:/moved/take_7.mp3")).toMatchObject({
      ok: true,
      relinked: ["media_a", "media_b"],
    });
    expect(row(fs, "media_b")?.path).toBe("E:/moved/b.mp4");
  });

  // Windows' file dialog hands back backslashes; the catalog stores one form.
  it("takes a Windows path from the file dialog, and sweeps its folder", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4"), linked("media_b", "D:/shoot/b.mp4", "b.mp4")],
      ["E:/moved/a.mp4", "E:/moved/b.mp4"],
    );
    expect(await relinkMedia(store, "media_a", "E:\\moved\\a.mp4")).toMatchObject({
      ok: true,
      remaining: 0,
    });
    expect(rows(fs).map((c) => c.path)).toEqual(["E:/moved/a.mp4", "E:/moved/b.mp4"]);
  });

  // "The project is closing" is an answer for a closing project only: a disk that refused the
  // write must reach the caller as the failure it is.
  it("lets a failed catalog write through, instead of calling it a closing project", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["E:/moved/a.mp4"],
    );
    fs.failCatalogWrites = true;
    await expect(relinkMedia(store, "media_a", "E:/moved/a.mp4")).rejects.toThrow(/EACCES/);
  });

  it("is heard by the editor once the catalog points at the file", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp3", "a.mp3", "audio")],
      ["E:/moved/a.mp3"],
    );
    const h = heard();
    try {
      expect(await relinkMedia(store, "media_a", "E:/moved/a.mp3")).toEqual({
        ok: true,
        relinked: ["media_a"],
        remaining: 0,
      });
      await settle();
      expect(row(fs, "media_a")?.path).toBe("E:/moved/a.mp3");
      expect(h.count()).toBe(1);
    } finally {
      h.stop();
    }
  });

  // An offline audio track pointed at a photo would "relink" and then fail every render.
  it("refuses a file of a different kind, and changes nothing", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp3", "a.mp3", "audio")],
      ["E:/moved/a.jpg"],
    );
    const before = fs.files.get(CATALOG);
    const h = heard();
    try {
      const res = await relinkMedia(store, "media_a", "E:/moved/a.jpg");
      await settle();
      expect(res.ok).toBe(false);
      expect(String(!res.ok && res.error)).toMatch(/not an audio file/);
      expect(fs.files.get(CATALOG)).toBe(before);
      expect(h.count()).toBe(0);
    } finally {
      h.stop();
    }
  });

  it("refuses a file that is not there, and media that is not linked", async () => {
    const { fs, store } = project(
      [
        linked("media_a", "D:/shoot/a.mp3", "a.mp3", "audio"),
        { id: "media_c", path: "library/media_c.mp3", filename: "c.mp3", kind: "audio" },
      ],
      ["E:/moved/c.mp3"],
    );
    const before = fs.files.get(CATALOG);
    expect((await relinkMedia(store, "media_a", "E:/moved/a.mp3")).ok).toBe(false);
    expect((await relinkMedia(store, "media_c", "E:/moved/c.mp3")).ok).toBe(false);
    expect(fs.files.get(CATALOG)).toBe(before);
  });

  // The other library writers commit through the project's gate; a relink beside them must not
  // lose their row, or have its own lost.
  it("keeps an import that lands at the same moment, and the import keeps the relink", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp3", "a.mp3", "audio")],
      ["E:/moved/a.mp3"],
    );
    const [relinked, imported] = await Promise.all([
      relinkMedia(store, "media_a", "E:/moved/a.mp3"),
      registerLibraryClip(store, new Uint8Array([7, 7, 7]), "b.mp3", "audio"),
    ]);
    expect(relinked.ok).toBe(true);
    expect(row(fs, "media_a")?.path).toBe("E:/moved/a.mp3");
    expect(row(fs, imported.id)).toBeTruthy();
  });

  it("writes nothing into a project that is closing", async () => {
    const { fs, doc, store } = project(
      [linked("media_a", "D:/shoot/a.mp3", "a.mp3", "audio")],
      ["E:/moved/a.mp3"],
    );
    const before = fs.files.get(CATALOG);
    void doc.gate.beginClose();
    expect((await relinkMedia(store, "media_a", "E:/moved/a.mp3")).ok).toBe(false);
    expect(fs.files.get(CATALOG)).toBe(before);
  });
});

describe("copyIntoProject", () => {
  it("copies the file in, stops the entry depending on where it was, and is heard", async () => {
    const { fs, store } = project(
      [linked("media_b", "D:/shoot/b.mp4", "b.mp4"), linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4", "D:/shoot/b.mp4"],
    );
    const h = heard();
    try {
      expect(await copyIntoProject(store, "media_a")).toEqual({
        ok: true,
        path: "library/media_a.mp4",
      });
      await settle();
      expect(fs.copied).toEqual([["D:/shoot/a.mp4", "C:/proj/library/media_a.mp4"]]);
      expect(row(fs, "media_a")?.path).toBe("library/media_a.mp4");
      expect(row(fs, "media_a")?.external).toBeUndefined(); // no longer a reference
      expect(row(fs, "media_b")).toMatchObject({ path: "D:/shoot/b.mp4", external: true });
      expect(h.count()).toBe(1);
    } finally {
      h.stop();
    }
  });

  it("refuses when the original is offline instead of writing an empty file", async () => {
    const { fs, store } = project([linked("media_a", "D:/shoot/a.mp4", "a.mp4")], []);
    const res = await copyIntoProject(store, "media_a");
    expect(String(!res.ok && res.error)).toMatch(/'a\.mp4' is offline/);
    expect(fs.copied).toEqual([]);
  });

  it("refuses media the library does not have", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4"],
    );
    expect(await copyIntoProject(store, "media_zz")).toEqual({
      ok: false,
      error: expect.stringContaining("media_zz"),
    });
    expect(fs.copied).toEqual([]);
  });

  it("names the copy by the file's last extension, lower-cased", async () => {
    const { store } = project(
      [linked("media_a", "D:/shoot/CLIP.Final.MOV", "CLIP.Final.MOV")],
      ["D:/shoot/CLIP.Final.MOV"],
    );
    expect(await copyIntoProject(store, "media_a")).toEqual({
      ok: true,
      path: "library/media_a.mov",
    });
  });

  it("names the copy by its id alone when the file has no extension", async () => {
    const { store } = project([linked("media_a", "D:/shoot/take7", "take7")], ["D:/shoot/take7"]);
    expect(await copyIntoProject(store, "media_a")).toEqual({
      ok: true,
      path: "library/media_a",
    });
  });

  // An earlier copy whose catalog turn was refused left its bytes behind: they are the same bytes.
  it("does not copy again over a copy that is already there", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4", "C:/proj/library/media_a.mp4"],
    );
    expect((await copyIntoProject(store, "media_a")).ok).toBe(true);
    expect(fs.copied).toEqual([]);
  });

  it("records nothing when the entry was deleted while its bytes were copied", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4"],
    );
    fs.duringCopy = async () => {
      fs.duringCopy = null;
      await writeLibraryCatalog(store, { version: 1, clips: [], folders: [] });
    };
    expect((await copyIntoProject(store, "media_a")).ok).toBe(false);
    expect(rows(fs)).toEqual([]);
  });

  it("lets two copies of one entry land as one, and both say where it is", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4"],
    );
    const both = await Promise.all([
      copyIntoProject(store, "media_a"),
      copyIntoProject(store, "media_a"),
    ]);
    expect(both).toEqual([
      { ok: true, path: "library/media_a.mp4" },
      { ok: true, path: "library/media_a.mp4" },
    ]);
    expect(rows(fs)).toHaveLength(1);
    expect(row(fs, "media_a")?.external).toBeUndefined();
  });

  it("lets a failed catalog write through, instead of calling it a closing project", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4"],
    );
    fs.failCatalogWrites = true;
    await expect(copyIntoProject(store, "media_a")).rejects.toThrow(/EACCES/);
  });

  it("is a no-op for media already inside the project", async () => {
    const { fs, store } = project(
      [{ id: "media_c", path: "library/media_c.mp4", filename: "c.mp4", kind: "video" }],
      ["C:/proj/library/media_c.mp4"],
    );
    expect(await copyIntoProject(store, "media_c")).toEqual({
      ok: true,
      path: "library/media_c.mp4",
    });
    expect(fs.copied).toEqual([]);
  });

  // The bytes are copied before the catalog's turn at the gate. A relink landing in between
  // means the copy is of a file the entry no longer names: recording it would swap the media.
  it("records nothing when the entry was relinked while its bytes were copied", async () => {
    const { fs, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4", "E:/moved/a.mp4"],
    );
    fs.duringCopy = async () => {
      fs.duringCopy = null;
      expect((await relinkMedia(store, "media_a", "E:/moved/a.mp4")).ok).toBe(true);
    };
    const res = await copyIntoProject(store, "media_a");
    expect(res.ok).toBe(false);
    expect(String(!res.ok && res.error)).toMatch(/relinked/);
    expect(row(fs, "media_a")).toMatchObject({ path: "E:/moved/a.mp4", external: true });
  });

  it("records nothing into a project that is closing", async () => {
    const { fs, doc, store } = project(
      [linked("media_a", "D:/shoot/a.mp4", "a.mp4")],
      ["D:/shoot/a.mp4"],
    );
    const before = fs.files.get(CATALOG);
    void doc.gate.beginClose();
    expect((await copyIntoProject(store, "media_a")).ok).toBe(false);
    expect(fs.files.get(CATALOG)).toBe(before);
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
    expect(offlineUnderPlayhead(t, 10, ["media_a"]), "first frame is covered").toEqual(["media_a"]);
    expect(offlineUnderPlayhead(t, 20, ["media_a"]), "the out frame is NOT covered").toEqual([]);
  });

  it("finds it on a LOWER track, not just the first one it looks at", () => {
    // Picking the easiest member to verify is how a per-track bug ships: the offline clip is
    // as likely to be on v3 as on v1.
    const t = tl(
      { clips: [clip("media_ok", 0, 100)] },
      { clips: [] },
      {
        clips: [clip("media_a", 0, 100)],
      },
    );
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
