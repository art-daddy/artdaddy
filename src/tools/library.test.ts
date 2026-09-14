import { afterEach, describe, expect, it } from "vitest";

import type { ClientToolContext } from "./context";
import { registerLibraryTools } from "./library";
import { ClientToolRegistry } from "./registry";
import { ProjectStoreAccess, joinPath, type FsLike } from "./store";
import { registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { doRedo, doUndo, loadTimeline, replaceTimeline } from "../timeline/engine";
import { emptyTimeline } from "../timeline/model";

const DIR = "C:/proj";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Args = Record<string, unknown>;

// A shared-filesystem mock mirroring the one in media.test.ts, extended with the
// dir-listing / rename / remove capabilities that library_op's `rescan` +
// `delete` exercise. `unreadable` lets a listed file exist yet fail a binary read
// (the "readBytes throws" branch inside rescan).
class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  unreadable = new Set<string>();
  touch(p: string): void {
    this.files.set(joinPath(p), "");
  }
  set(p: string, c: string): void {
    this.files.set(joinPath(p), c);
  }
  setBytes(p: string, b: Uint8Array): void {
    this.bytes.set(joinPath(p), b);
  }
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
    const n = joinPath(p);
    if (this.unreadable.has(n)) throw new Error("unreadable");
    const b = this.bytes.get(n);
    if (b !== undefined) return b;
    const t = this.files.get(n);
    if (t !== undefined) return new TextEncoder().encode(t);
    throw new Error("ENOENT");
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async mkdir(): Promise<void> {}
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.files.delete(n);
    this.bytes.delete(n);
    for (const k of [...this.files.keys()]) if (k.startsWith(`${n}/`)) this.files.delete(k);
    for (const k of [...this.bytes.keys()]) if (k.startsWith(`${n}/`)) this.bytes.delete(k);
  }
  async rename(from: string, to: string): Promise<void> {
    const f = joinPath(from);
    const t = joinPath(to);
    if (this.files.has(f)) {
      this.files.set(t, this.files.get(f) as string);
      this.files.delete(f);
    }
    if (this.bytes.has(f)) {
      this.bytes.set(t, this.bytes.get(f) as Uint8Array);
      this.bytes.delete(f);
    }
  }
  async readDir(p: string): Promise<{ name: string; isDirectory: boolean }[]> {
    const base = joinPath(p);
    const seen = new Map<string, boolean>();
    for (const k of [...this.files.keys(), ...this.bytes.keys()]) {
      if (!k.startsWith(`${base}/`)) continue;
      const rest = k.slice(base.length + 1);
      const seg = rest.split("/")[0];
      if (!seen.has(seg)) seen.set(seg, rest.includes("/"));
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
}

function ctxWith(fs: MockFs): ClientToolContext {
  return {
    store: new ProjectStoreAccess(DIR, fs),
    runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
  };
}

/** Register library_op on a fresh registry bound to `ctx`, then invoke it — the
 *  real dispatch path (registry.run → clampArgs → handler). */
function runLib(ctx: ClientToolContext | null, args: Args): Promise<Any> {
  const reg = new ClientToolRegistry();
  registerLibraryTools(reg, () => ctx);
  return reg.run("library_op", args) as Promise<Any>;
}

function seed(
  fs: MockFs,
  cat: { version?: number; clips?: Any[]; folders?: Any[] } | string,
): void {
  const p = joinPath(DIR, "internals/library.json");
  fs.set(
    p,
    typeof cat === "string" ? cat : JSON.stringify({ version: 1, clips: [], folders: [], ...cat }),
  );
}
function seedTimeline(fs: MockFs, tl: unknown): void {
  fs.set(
    joinPath(DIR, "internals/timeline.json"),
    typeof tl === "string" ? tl : JSON.stringify(tl),
  );
}
async function readCat(fs: MockFs): Promise<Any> {
  return JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
}
async function mediaId(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return `media_${Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12)}`;
}

// A doc-registering test (the in-memory ref-check) must not leak its resolver/timeline into the
// bare-store tests that follow; flush + clear after every test (a no-op when none was registered).
afterEach(async () => {
  await resetTestDocuments();
});

describe("library_op guards", () => {
  it("returns not-ready without a context", async () => {
    const r = await runLib(null, { action: "list" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not ready");
  });
  it("requires an action", async () => {
    expect((await runLib(ctxWith(new MockFs()), {})).error).toContain("'action' is required");
    expect((await runLib(ctxWith(new MockFs()), { action: "   " })).error).toContain(
      "'action' is required",
    );
  });
  it("rejects an unknown action", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "bogus" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown action bogus");
  });
});

describe("readCatalog", () => {
  it("lists an empty library when no catalog exists", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "list" });
    expect(r.ok).toBe(true);
    expect(r.clips).toEqual([]);
  });
  it("recovers from a corrupt catalog", async () => {
    const fs = new MockFs();
    seed(fs, "{ not json");
    const r = await runLib(ctxWith(fs), { action: "list" });
    expect(r.ok).toBe(true);
    expect(r.clips).toEqual([]);
  });
  it("ignores non-array clips/folders", async () => {
    const fs = new MockFs();
    seed(fs, JSON.stringify({ version: 3, clips: "nope", folders: "nope" }));
    const r = await runLib(ctxWith(fs), { action: "list" });
    expect(r.clips).toEqual([]);
  });
  it("defaults the version when the catalog omits it", async () => {
    const fs = new MockFs();
    seed(fs, JSON.stringify({ clips: [{ id: "media_x", path: "library/x.mp4" }] })); // no version
    const r = await runLib(ctxWith(fs), { action: "list" });
    expect(r.clips).toHaveLength(1);
  });
});

describe("list", () => {
  function seedTree(fs: MockFs): void {
    seed(fs, {
      clips: [
        { id: "media_root", path: "library/root.mp4", folder: "" },
        { id: "media_a", path: "library/a.mp4", folder: "a" },
        { id: "media_ab", path: "library/ab.mp4", folder: "a/b" },
        { id: "media_c", path: "library/c.mp4" }, // no folder key → undefined
      ],
    });
  }
  it("returns every clip with no folder filter", async () => {
    const fs = new MockFs();
    seedTree(fs);
    const r = await runLib(ctxWith(fs), { action: "list" });
    expect(r.clips.map((c: Any) => c.id).sort()).toEqual([
      "media_a",
      "media_ab",
      "media_c",
      "media_root",
    ]);
  });
  it("filters by exact folder when recursive is false", async () => {
    const fs = new MockFs();
    seedTree(fs);
    const r = await runLib(ctxWith(fs), { action: "list", folder: "a", recursive: false });
    expect(r.clips.map((c: Any) => c.id)).toEqual(["media_a"]);
  });
  it("filters recursively by folder prefix", async () => {
    const fs = new MockFs();
    seedTree(fs);
    const r = await runLib(ctxWith(fs), { action: "list", folder: "a", recursive: true });
    expect(r.clips.map((c: Any) => c.id).sort()).toEqual(["media_a", "media_ab"]);
  });
  it("returns everything for an empty folder even when recursive", async () => {
    const fs = new MockFs();
    seedTree(fs);
    const r = await runLib(ctxWith(fs), { action: "list", folder: "" });
    expect(r.clips).toHaveLength(4);
  });
});

describe("get", () => {
  it("returns a clip by id", async () => {
    const fs = new MockFs();
    seed(fs, { clips: [{ id: "media_x", path: "library/x.mp4" }] });
    const r = await runLib(ctxWith(fs), { action: "get", id: "media_x" });
    expect(r.ok).toBe(true);
    expect(r.clip.path).toBe("library/x.mp4");
  });
  it("errors for an unknown id", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "get", id: "media_missing" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown clip id media_missing");
  });
  it("errors when no id is supplied", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "get" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown clip id");
  });
});

describe("add (removed — redirect to import_media)", () => {
  it("rejects the removed add action with a redirect to import_media", async () => {
    // `add` left the contract in CONTRACT_VERSION 1.2.0; import_media is the single
    // import door now. A stale server that still emits it is REJECTED, not executed.
    // (Its old `path` arg is caught even earlier by top-level param validation.)
    const r = await runLib(ctxWith(new MockFs()), { action: "add" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("import_media");
    expect(String(r.error)).toContain("removed");
  });
});

describe("update / move", () => {
  function seedOne(fs: MockFs): void {
    seed(fs, {
      clips: [
        { id: "media_x", path: "library/x.mp4", filename: "x.mp4", folder: "", tags: ["keep"] },
      ],
    });
  }
  it("updates filename, folder, tags, and notes", async () => {
    const fs = new MockFs();
    seedOne(fs);
    const r = await runLib(ctxWith(fs), {
      action: "update",
      id: "media_x",
      filename: "new.mp4",
      folder: " x\\y ",
      tags: [" t1 ", "", "t2"],
      notes: 5,
    });
    expect(r.ok).toBe(true);
    expect(r.clip.filename).toBe("new.mp4");
    expect(r.clip.folder).toBe("x/y");
    expect(r.clip.tags).toEqual(["t1", "t2"]);
    expect(r.clip.notes).toBe("5");
    const cat = await readCat(fs);
    expect(cat.folders).toEqual(expect.arrayContaining(["x", "x/y"]));
  });
  it("keeps the old filename when the new one is blank and ignores null notes", async () => {
    const fs = new MockFs();
    seedOne(fs);
    const r = await runLib(ctxWith(fs), {
      action: "update",
      id: "media_x",
      filename: "   ",
      notes: null,
    });
    expect(r.clip.filename).toBe("x.mp4");
    expect(r.clip.notes).toBeUndefined();
  });
  it("moves a clip to a folder without touching its tags", async () => {
    const fs = new MockFs();
    seedOne(fs);
    const r = await runLib(ctxWith(fs), {
      action: "move",
      id: "media_x",
      folder: "z",
      tags: ["ignored"],
    });
    expect(r.ok).toBe(true);
    expect(r.clip.folder).toBe("z");
    expect(r.clip.tags).toEqual(["keep"]); // move ignores tags
  });
  it("accepts a move to the root folder", async () => {
    const fs = new MockFs();
    seedOne(fs);
    const r = await runLib(ctxWith(fs), { action: "move", id: "media_x", folder: "   " });
    expect(r.ok).toBe(true);
    expect(r.clip.folder).toBe("");
  });
  it("errors for an unknown id", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "update", id: "media_none" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown clip id media_none");
  });
  it("errors when no id is supplied", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "move" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown clip id");
  });
});

describe("delete", () => {
  function seedClipFile(fs: MockFs): void {
    seed(fs, { clips: [{ id: "media_x", path: "library/media_x.mp4" }] });
    fs.setBytes(joinPath(DIR, "library/media_x.mp4"), new Uint8Array([1]));
  }
  it("unlinks an external clip without deleting its source file", async () => {
    const fs = new MockFs();
    const EXT = "D:/footage/hero.mp4";
    seed(fs, {
      clips: [{ id: "media_ext", path: EXT, external: true, filename: "hero.mp4", kind: "video" }],
    });
    fs.setBytes(EXT, new Uint8Array([1, 2, 3])); // the user's original, OUTSIDE the project
    const r = await runLib(ctxWith(fs), { action: "delete", id: "media_ext" });
    expect(r.ok).toBe(true);
    expect(r.removed_file).toBeNull();
    expect(r.unlinked_external).toBe(true);
    expect(await fs.exists(EXT)).toBe(true); // source left untouched
    expect((await readCat(fs)).clips).toEqual([]); // catalog row gone
  });
  it("deletes a clip and removes its file", async () => {
    const fs = new MockFs();
    seedClipFile(fs);
    const r = await runLib(ctxWith(fs), { action: "delete", id: "media_x" });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("media_x");
    expect(String(r.removed_file)).toContain("library/media_x.mp4");
    expect(await fs.exists(joinPath(DIR, "library/media_x.mp4"))).toBe(false);
    expect((await readCat(fs)).clips).toEqual([]);
  });
  it("errors for an unknown id", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "delete", id: "media_none" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown clip id media_none");
  });
  it("errors when no id is supplied", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "delete" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown clip id");
  });
  it("cascades a used clip: removes the using clip from the on-disk timeline AND the catalog item (bare store)", async () => {
    const fs = new MockFs();
    seedClipFile(fs);
    seedTimeline(fs, {
      ...emptyTimeline(),
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [{ id: "c1", media_ref: "library/media_x.mp4", timeline_in: 0, timeline_out: 30 }],
        },
      ],
    });
    const r = await runLib(ctxWith(fs), { action: "delete", id: "media_x" });
    expect(r.ok).toBe(true);
    expect(r.removed_clips).toBe(1);
    expect((await readCat(fs)).clips).toEqual([]); // catalog item gone
    // the using clip was removed from the on-disk timeline — no dangling ref left behind
    const tl = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/timeline.json")));
    expect((tl.tracks ?? []).flatMap((t: Any) => t.clips ?? [])).toEqual([]);
  });
  it("cascade-deletes a used clip through the OPEN document as ONE composite undo entry; undo restores both, redo re-removes", async () => {
    const fs = new MockFs();
    seedClipFile(fs); // catalog media_x + its owned bytes
    seedTimeline(fs, emptyTimeline());
    registerTestDocument(DIR);
    const store = new ProjectStoreAccess(DIR, fs);
    await replaceTimeline(store, {
      ...emptyTimeline(),
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [{ id: "c1", media_ref: "library/media_x.mp4", timeline_in: 0, timeline_out: 30 }],
        },
      ],
    });
    const usesX = async (): Promise<boolean> =>
      (await loadTimeline(store)).tracks.some((t) =>
        (t.clips ?? []).some((c) => c.media_ref === "library/media_x.mp4"),
      );
    const hasRow = async (): Promise<boolean> =>
      (await readCat(fs)).clips.some((c: Any) => c.id === "media_x");

    // DELETE cascades: the using clip + the catalog item go as ONE entry; owned bytes are KEPT.
    const del = await runLib(ctxWith(fs), { action: "delete", id: "media_x" });
    expect(del.ok).toBe(true);
    expect(del.removed_clips).toBe(1);
    expect(del.undoable).toBe(true);
    expect(await hasRow()).toBe(false);
    expect(await usesX()).toBe(false);
    expect(await fs.exists(joinPath(DIR, "library/media_x.mp4"))).toBe(true); // bytes pinned for undo (deferred GC)

    // UNDO restores BOTH halves as one entry.
    const un = await doUndo(store);
    expect(un.ok).toBe(true);
    expect(await hasRow()).toBe(true);
    expect(await usesX()).toBe(true);

    // REDO re-removes BOTH.
    const re = await doRedo(store);
    expect(re.ok).toBe(true);
    expect(await hasRow()).toBe(false);
    expect(await usesX()).toBe(false);
  });
  it("REVERTS the timeline when the composite cascade's catalog write FAILS — truthful {ok:false}, no phantom history (blocker 3)", async () => {
    // A fs whose CATALOG write throws (library.json + its atomic temp), leaving the timeline half of
    // the composite applied. The tool must roll the timeline back cleanly and report failure — never
    // report {ok:false} while the timeline lost its clip + gained an undo entry (the reviewer's repro).
    class CatalogFailFs extends MockFs {
      async writeTextFile(p: string, c: string): Promise<void> {
        if (joinPath(p).includes("library.")) throw new Error("disk full — catalog write");
        return super.writeTextFile(p, c);
      }
    }
    const fs = new CatalogFailFs();
    seedClipFile(fs); // catalog media_x + owned bytes (seeded directly, so the fail-fs doesn't block it)
    seedTimeline(fs, emptyTimeline());
    registerTestDocument(DIR);
    const store = new ProjectStoreAccess(DIR, fs);
    await replaceTimeline(store, {
      ...emptyTimeline(),
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [{ id: "c1", media_ref: "library/media_x.mp4", timeline_in: 0, timeline_out: 30 }],
        },
      ],
    });
    const usesX = async (): Promise<boolean> =>
      (await loadTimeline(store)).tracks.some((t) =>
        (t.clips ?? []).some((c) => c.media_ref === "library/media_x.mp4"),
      );
    const hasRow = async (): Promise<boolean> =>
      (await readCat(fs)).clips.some((c: Any) => c.id === "media_x");

    const del = await runLib(ctxWith(fs), { action: "delete", id: "media_x" });
    expect(del.ok).toBe(false); // truthful — the catalog could not be written
    expect(await usesX()).toBe(true); // timeline REVERTED: the using clip is back
    expect(await hasRow()).toBe(true); // catalog UNCHANGED: the row is still there (neither half changed)
    const un = await doUndo(store);
    expect(un.ok).toBe(false); // NO phantom history — the failed cascade left no undo entry to unwind
  });
  it("cascade-removes every clip that resolves to the same file, skipping junk refs (bare store)", async () => {
    const fs = new MockFs();
    seedClipFile(fs);
    seedTimeline(fs, {
      tracks: [
        { clips: [{ media_ref: "media_x" }, { media_ref: 123 }, {}, { media_ref: "ghost" }] },
        {}, // track without clips → clips ?? []
      ],
    });
    const r = await runLib(ctxWith(fs), { action: "delete", id: "media_x" });
    expect(r.ok).toBe(true);
    expect(r.removed_clips).toBe(1); // only the "media_x" ref resolves; 123 / {} / "ghost" are skipped
    expect((await readCat(fs)).clips).toEqual([]);
  });
  it("cascades an EXTERNAL used clip: unlinks the catalog + removes the clip, never deletes the source", async () => {
    const fs = new MockFs();
    const EXT = "D:/footage/hero.mp4";
    seed(fs, {
      clips: [{ id: "media_ext", path: EXT, external: true, filename: "hero.mp4", kind: "video" }],
    });
    fs.setBytes(EXT, new Uint8Array([1, 2, 3])); // the user's original, OUTSIDE the project
    seedTimeline(fs, {
      ...emptyTimeline(),
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [{ id: "c1", media_ref: EXT, timeline_in: 0, timeline_out: 30 }],
        },
      ],
    });
    const r = await runLib(ctxWith(fs), { action: "delete", id: "media_ext" });
    expect(r.ok).toBe(true);
    expect(r.removed_clips).toBe(1);
    expect(r.unlinked_external).toBe(true);
    expect(await fs.exists(EXT)).toBe(true); // external source is NEVER deleted
    expect((await readCat(fs)).clips).toEqual([]);
  });
  it("treats a timeline without tracks and an unparseable timeline as zero references", async () => {
    const fs = new MockFs();
    seedClipFile(fs);
    seedTimeline(fs, {}); // no tracks
    expect((await runLib(ctxWith(fs), { action: "delete", id: "media_x" })).ok).toBe(true);

    const fs2 = new MockFs();
    seedClipFile(fs2);
    seedTimeline(fs2, "{ broken");
    expect((await runLib(ctxWith(fs2), { action: "delete", id: "media_x" })).ok).toBe(true);
  });
  it("deletes even when the filesystem cannot remove files", async () => {
    const fs = new MockFs();
    seedClipFile(fs);
    // remove rejects → the best-effort .catch(() => undefined) swallows it.
    (fs as Any).remove = async () => {
      throw new Error("EPERM");
    };
    const r = await runLib(ctxWith(fs), { action: "delete", id: "media_x" });
    expect(r.ok).toBe(true);
    expect((await readCat(fs)).clips).toEqual([]);
  });
});

describe("create_folder", () => {
  it("creates nested folders (collapsing repeated slashes)", async () => {
    const fs = new MockFs();
    const r = await runLib(ctxWith(fs), { action: "create_folder", folder: "a///b" });
    expect(r.ok).toBe(true);
    expect(r.folders).toEqual(["a", "a/b"]);
  });
  it("errors on a null name", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "create_folder", folder: null });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("name is empty");
  });
  it("errors on a slash-only name", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "create_folder", folder: "  /  " });
    expect(r.ok).toBe(false);
  });
});

describe("rename_folder", () => {
  it("renames a folder and its subfolders", async () => {
    const fs = new MockFs();
    seed(fs, {
      clips: [
        { id: "media_a", path: "library/a.mp4", folder: "a" },
        { id: "media_ab", path: "library/ab.mp4", folder: "a/b" },
        { id: "media_root", path: "library/root.mp4", folder: "" },
        { id: "media_c", path: "library/c.mp4", folder: "c" },
      ],
      folders: ["a", "a/b", "c"],
    });
    const r = await runLib(ctxWith(fs), { action: "rename_folder", old: "a", new: "x" });
    expect(r.ok).toBe(true);
    expect(r.clips_moved).toBe(2);
    const cat = await readCat(fs);
    expect(cat.folders).toEqual(["c", "x", "x/b"]);
    const byId = Object.fromEntries(cat.clips.map((c: Any) => [c.id, c.folder]));
    expect(byId.media_a).toBe("x");
    expect(byId.media_ab).toBe("x/b");
    expect(byId.media_c).toBe("c");
  });
  it("errors when old is empty", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "rename_folder", old: "", new: "x" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("old name is empty");
  });
  it("errors when new is empty", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "rename_folder", old: "a", new: "" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("new name is empty");
  });
});

describe("delete_folder", () => {
  function seedFolder(fs: MockFs): void {
    seed(fs, {
      clips: [
        { id: "media_a", path: "library/a.mp4", folder: "a" },
        { id: "media_ab", path: "library/ab.mp4", folder: "a/b" },
        { id: "media_c", path: "library/c.mp4", folder: "c" },
      ],
      folders: ["a", "a/b", "c"],
    });
    fs.setBytes(joinPath(DIR, "library/a.mp4"), new Uint8Array([1]));
    fs.setBytes(joinPath(DIR, "library/ab.mp4"), new Uint8Array([2]));
  }
  it("refuses to delete a non-empty folder without force", async () => {
    const fs = new MockFs();
    seedFolder(fs);
    const r = await runLib(ctxWith(fs), { action: "delete_folder", folder: "a" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("contains 2 clip(s)");
    expect((await readCat(fs)).clips).toHaveLength(3); // untouched
  });
  it("force-deletes a folder and its clips", async () => {
    const fs = new MockFs();
    seedFolder(fs);
    const r = await runLib(ctxWith(fs), { action: "delete_folder", folder: "a", force: true });
    expect(r.ok).toBe(true);
    expect(r.removed_clip_ids.sort()).toEqual(["media_a", "media_ab"]);
    const cat = await readCat(fs);
    expect(cat.clips.map((c: Any) => c.id)).toEqual(["media_c"]);
    expect(cat.folders).toEqual(["c"]);
    expect(await fs.exists(joinPath(DIR, "library/a.mp4"))).toBe(false);
    expect(await fs.exists(joinPath(DIR, "library/ab.mp4"))).toBe(false);
  });
  it("force-deletes a folder but NEVER deletes a linked-external source (only unlinks it)", async () => {
    // Invariant 28 / §16.1: deletion never follows the external path. A folder holding a linked
    // clip is force-deleted -> the linked SOURCE (outside the project) survives; only the copy's
    // bytes are removed. Closes the one deletion path (delete_folder) the other tests didn't cover.
    const fs = new MockFs();
    const EXT = "D:/footage/hero.mp4";
    seed(fs, {
      clips: [
        { id: "media_copy", path: "library/copy.mp4", folder: "a" },
        {
          id: "media_ext",
          path: EXT,
          external: true,
          filename: "hero.mp4",
          kind: "video",
          folder: "a",
        },
      ],
      folders: ["a"],
    });
    fs.setBytes(joinPath(DIR, "library/copy.mp4"), new Uint8Array([1])); // a project-owned copy
    fs.setBytes(EXT, new Uint8Array([2, 3])); // the user's original, OUTSIDE the project
    const r = await runLib(ctxWith(fs), { action: "delete_folder", folder: "a", force: true });
    expect(r.ok).toBe(true);
    expect(r.removed_clip_ids.sort()).toEqual(["media_copy", "media_ext"]); // both unlinked from the catalog
    expect(await fs.exists(joinPath(DIR, "library/copy.mp4"))).toBe(false); // the COPY's bytes are removed
    expect(await fs.exists(EXT)).toBe(true); // the LINKED source is NEVER deleted
    expect((await readCat(fs)).clips).toEqual([]); // catalog rows gone
  });
  it("deletes an empty folder without force", async () => {
    const fs = new MockFs();
    seed(fs, { clips: [], folders: ["empty"] });
    const r = await runLib(ctxWith(fs), { action: "delete_folder", folder: "empty" });
    expect(r.ok).toBe(true);
    expect(r.removed_clip_ids).toEqual([]);
    expect((await readCat(fs)).folders).toEqual([]);
  });
  it("errors on an empty name", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "delete_folder", folder: "" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("name is empty");
  });
});

describe("rescan", () => {
  it("keeps an external clip whose source is missing and flags it offline (never prunes a link)", async () => {
    const fs = new MockFs();
    const EXT = "D:/footage/hero.mp4";
    seed(fs, {
      clips: [
        { id: "media_ext", path: EXT, external: true, filename: "hero.mp4", kind: "video" },
        { id: "media_gone", path: "library/gone.mp4" }, // a COPY whose bytes vanished
      ],
    });
    // EXT is never created -> the external source is offline; the copy is absent too.
    (fs as Any).readDir = undefined; // isolate the prune loop from the folder scan
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.removed_catalog_rows).toEqual(["media_gone"]); // only the orphaned copy is pruned
    expect(r.offline_external).toEqual(["media_ext"]);
    expect((await readCat(fs)).clips.map((c: Any) => c.id)).toEqual(["media_ext"]); // link kept
  });

  it("keeps an external clip whose source exists and does not flag it offline", async () => {
    const fs = new MockFs();
    const EXT = "D:/footage/hero.mp4";
    seed(fs, { clips: [{ id: "media_ext", path: EXT, external: true, kind: "video" }] });
    fs.setBytes(EXT, new Uint8Array([7])); // source present, outside the project
    (fs as Any).readDir = undefined;
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.offline_external).toEqual([]);
    expect((await readCat(fs)).clips.map((c: Any) => c.id)).toEqual(["media_ext"]);
  });

  it("skips scanning without readDir and prunes rows whose files vanished", async () => {
    const fs = new MockFs();
    seed(fs, {
      clips: [
        { id: "media_has", path: "library/has.mp4" },
        { id: "media_gone", path: "library/gone.mp4" },
        { id: "media_nopath" }, // no path → pruned
      ],
    });
    fs.setBytes(joinPath(DIR, "library/has.mp4"), new Uint8Array([1]));
    (fs as Any).readDir = undefined; // force the "no scan" branch
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual([]);
    expect(r.removed_dup_files).toEqual([]);
    expect(r.removed_catalog_rows.sort()).toEqual(["media_gone", "media_nopath"]);
    expect((await readCat(fs)).clips.map((c: Any) => c.id)).toEqual(["media_has"]);
  });
  it("imports a new non-canonical file by renaming it to its content hash", async () => {
    const fs = new MockFs();
    seed(fs, { clips: [] });
    const bytes = new Uint8Array([10, 20, 30]);
    fs.setBytes(joinPath(DIR, "library/raw.mp4"), bytes);
    const id = await mediaId(bytes);
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual([id]);
    expect(await fs.exists(joinPath(DIR, `library/${id}.mp4`))).toBe(true);
    expect(await fs.exists(joinPath(DIR, "library/raw.mp4"))).toBe(false);
    const cat = await readCat(fs);
    expect(cat.clips.map((c: Any) => c.id)).toEqual([id]);
  });
  it("removes a duplicate when the canonical file already exists", async () => {
    const fs = new MockFs();
    const bytes = new Uint8Array([9, 9, 9]);
    const id = await mediaId(bytes);
    seed(fs, { clips: [{ id, path: `library/${id}.mp4`, kind: "video" }] });
    fs.setBytes(joinPath(DIR, `library/${id}.mp4`), bytes); // canonical, already catalogued
    fs.setBytes(joinPath(DIR, "library/dup.mp4"), bytes); // byte-identical dup
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual([]); // canonical already known → existing.has
    expect(r.removed_dup_files).toEqual(["dup.mp4"]);
    expect(await fs.exists(joinPath(DIR, "library/dup.mp4"))).toBe(false);
    expect((await readCat(fs)).clips.map((c: Any) => c.id)).toEqual([id]);
  });
  it("skips a non-canonical file when rename is unavailable", async () => {
    const fs = new MockFs();
    seed(fs, { clips: [] });
    fs.setBytes(joinPath(DIR, "library/raw.mp4"), new Uint8Array([4, 4]));
    (fs as Any).rename = undefined; // no way to canonicalise → skip
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual([]);
    expect(await fs.exists(joinPath(DIR, "library/raw.mp4"))).toBe(true);
  });
  it("skips a non-canonical file when the rename fails", async () => {
    const fs = new MockFs();
    seed(fs, { clips: [] });
    fs.setBytes(joinPath(DIR, "library/raw.mp4"), new Uint8Array([6, 6]));
    (fs as Any).rename = async () => {
      throw new Error("EXDEV");
    };
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual([]);
  });
  it("ignores directories, non-video files, and unreadable files", async () => {
    const fs = new MockFs();
    seed(fs, { clips: [] });
    fs.setBytes(joinPath(DIR, "library/sub/inner.mp4"), new Uint8Array([1])); // → "sub" dir entry
    fs.set(joinPath(DIR, "library/note.txt"), "hi"); // non-video
    fs.set(joinPath(DIR, "library/broken.mp4"), ""); // listed but…
    fs.unreadable.add(joinPath(DIR, "library/broken.mp4")); // …readBytes throws
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual([]);
  });
  it("recovers when readDir throws", async () => {
    const fs = new MockFs();
    seed(fs, { clips: [{ id: "media_gone", path: "library/gone.mp4" }] });
    (fs as Any).readDir = async () => {
      throw new Error("EIO");
    };
    const r = await runLib(ctxWith(fs), { action: "rescan" });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual([]);
    expect(r.removed_catalog_rows).toEqual(["media_gone"]);
  });
});

describe("resolve", () => {
  it("errors without an id or path", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "resolve" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("id or path is required");
  });
  it("resolves a library id to its stored path", async () => {
    const fs = new MockFs();
    seed(fs, { clips: [{ id: "media_x", path: "library/x.mp4" }] });
    const r = await runLib(ctxWith(fs), { action: "resolve", id: "media_x" });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("library/x.mp4");
  });
  it("errors for an unknown library id", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "resolve", id: "media_zzz" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("unknown library id media_zzz");
  });
  it("resolves a project-relative path via id_or_path", async () => {
    const fs = new MockFs();
    fs.setBytes(joinPath(DIR, "library/x.mp4"), new Uint8Array([1]));
    const r = await runLib(ctxWith(fs), { action: "resolve", id_or_path: "library/x.mp4" });
    expect(r.ok).toBe(true);
    expect(r.path).toBe("library/x.mp4");
  });
  it("errors when nothing matches the given id_or_path", async () => {
    const r = await runLib(ctxWith(new MockFs()), { action: "resolve", id_or_path: "nope.mp4" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("nothing matches");
  });
});
