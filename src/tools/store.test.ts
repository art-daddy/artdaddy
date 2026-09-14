import { afterEach, describe, expect, it } from "vitest";

import {
  clipAbs,
  isProjectDirDead,
  joinPath,
  markProjectDirDead,
  ProjectStoreAccess,
  readJsonOrRecover,
  reviveProjectDir,
  type FsLike,
} from "./store";

class MockFs implements FsLike {
  files = new Map<string, string>();
  touch(path: string): void {
    this.files.set(joinPath(path), "");
  }
  set(path: string, contents: string): void {
    this.files.set(joinPath(path), contents);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(joinPath(path));
  }
  async readTextFile(path: string): Promise<string> {
    const v = this.files.get(joinPath(path));
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }
  async writeTextFile(path: string, contents: string): Promise<void> {
    this.files.set(joinPath(path), contents);
  }
  async mkdir(): Promise<void> {}
}

const DIR = "C:/Users/x/projects/proj1";

function withLibrary(fs: MockFs, clips: unknown[]): void {
  fs.set(
    joinPath(DIR, "internals", "library.json"),
    JSON.stringify({ version: 1, clips, folders: [] }),
  );
}

describe("readJsonOrRecover", () => {
  const P = joinPath(DIR, "internals", "library.json");

  it("returns the fallback for a missing file (no backup written)", async () => {
    const fs = new MockFs();
    expect(await readJsonOrRecover(fs, P, { v: 0 })).toEqual({ v: 0 });
    expect([...fs.files.keys()].some((k) => k.includes(".corrupt-"))).toBe(false);
  });

  it("parses valid JSON", async () => {
    const fs = new MockFs();
    fs.set(P, JSON.stringify({ version: 2, clips: [1] }));
    expect(await readJsonOrRecover(fs, P, {})).toEqual({ version: 2, clips: [1] });
  });

  it("preserves corrupt bytes to a .corrupt sibling (copy) and degrades to fallback", async () => {
    const fs = new MockFs();
    fs.set(P, "{ not json");
    const out = await readJsonOrRecover(fs, P, { version: 1, clips: [] });
    expect(out).toEqual({ version: 1, clips: [] });
    const backup = [...fs.files.entries()].find(([k]) => k.includes(".corrupt-"));
    expect(backup?.[1]).toBe("{ not json"); // exact bytes preserved for recovery
    expect(fs.files.get(joinPath(P))).toBe("{ not json"); // no rename support -> original left in place
  });

  it("moves corrupt bytes aside via rename when available (original removed)", async () => {
    const renames: [string, string][] = [];
    const fs = new (class extends MockFs {
      async rename(from: string, to: string): Promise<void> {
        renames.push([from, to]);
        const v = this.files.get(joinPath(from));
        this.files.delete(joinPath(from));
        if (v !== undefined) this.files.set(joinPath(to), v);
      }
    })();
    fs.set(P, "corrupt");
    const out = await readJsonOrRecover(fs, P, { ok: true });
    expect(out).toEqual({ ok: true });
    expect(renames.length).toBe(1);
    expect(await fs.exists(P)).toBe(false); // original moved away, not clobbered
    const backup = [...fs.files.entries()].find(([k]) => k.includes(".corrupt-"));
    expect(backup?.[1]).toBe("corrupt");
  });
});

describe("joinPath", () => {
  it("normalises separators and trims stray slashes", () => {
    expect(joinPath("C:\\a\\", "/b/", "c")).toBe("C:/a/b/c");
    expect(joinPath("", "x")).toBe("x");
  });
});

describe("clipAbs", () => {
  it("joins a copied clip onto the project dir; uses an external clip's absolute path as-is", () => {
    expect(clipAbs(DIR, { id: "a", path: "library/a.mp4" })).toBe(joinPath(DIR, "library/a.mp4"));
    expect(clipAbs(DIR, { id: "b", path: "D:/footage/hero.mp4", external: true })).toBe(
      "D:/footage/hero.mp4",
    );
  });
});

describe("ProjectStoreAccess.resolveRef", () => {
  it("resolves a clip id", async () => {
    const fs = new MockFs();
    withLibrary(fs, [{ id: "media_abc", path: "library/media_abc.mp4", filename: "vid.mp4" }]);
    fs.touch(joinPath(DIR, "library/media_abc.mp4"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveRef("media_abc")).toBe(joinPath(DIR, "library/media_abc.mp4"));
  });

  // The catalog stores `path: library/media_abc.mp4` while the id has no extension, so the
  // basename of the very path we persist is a shape a caller will inevitably use. It used to
  // return null: a `media_`-prefixed ref got ONE chance at an exact id and no fallback, which
  // broke inspect_media/library_op on real pasted media.
  it.each([
    ["id + extension", "media_abc.mp4"],
    ["the stored project-relative path", "library/media_abc.mp4"],
    ["the stored path's basename", "media_abc.mp4"],
    ["the catalog filename", "vid.mp4"],
  ])("resolves a clip by %s", async (_label, ref) => {
    const fs = new MockFs();
    withLibrary(fs, [{ id: "media_abc", path: "library/media_abc.mp4", filename: "vid.mp4" }]);
    fs.touch(joinPath(DIR, "library/media_abc.mp4"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveRef(ref)).toBe(joinPath(DIR, "library/media_abc.mp4"));
  });

  it("still returns null for a media_ ref that names nothing in the catalog", async () => {
    const fs = new MockFs();
    withLibrary(fs, [{ id: "media_abc", path: "library/media_abc.mp4", filename: "vid.mp4" }]);
    fs.touch(joinPath(DIR, "library/media_abc.mp4"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveRef("media_nope")).toBeNull();
    expect(await store.resolveRef("media_nope.mp4")).toBeNull();
  });

  // A DERIVED artifact is named after the media it came from, so the catalog's
  // basename/stem matching used to swallow it: asking for the thumbnail JPG returned the
  // library MP4, and since that answer was non-null the poster fallback never ran — every
  // timeline + library thumbnail became an <img> pointing at an 85 MB video.
  it("resolves an artifact PATH to the artifact, not to the media sharing its stem", async () => {
    const fs = new MockFs();
    withLibrary(fs, [{ id: "media_abc", path: "library/media_abc.mp4", filename: "vid.mp4" }]);
    fs.touch(joinPath(DIR, "library/media_abc.mp4"));
    fs.touch(joinPath(DIR, "internals/cache/thumbnails/media_abc.jpg"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveRef("internals/cache/thumbnails/media_abc.jpg")).toBe(
      joinPath(DIR, "internals/cache/thumbnails/media_abc.jpg"),
    );
  });

  it("returns null for an artifact path that does NOT exist, so callers fall through", async () => {
    // The bug wasn't just the wrong path — it was a TRUTHY wrong path, which suppressed
    // every fallback the caller had (poster, then the source image).
    const fs = new MockFs();
    withLibrary(fs, [{ id: "media_abc", path: "library/media_abc.mp4", filename: "vid.mp4" }]);
    fs.touch(joinPath(DIR, "library/media_abc.mp4"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveRef("internals/cache/thumbnails/media_abc.jpg")).toBeNull();
  });

  it("does not let a media_ prefix smuggle a path escape past the agent guard", async () => {
    const fs = new MockFs();
    withLibrary(fs, [{ id: "media_abc", path: "library/media_abc.mp4", filename: "vid.mp4" }]);
    fs.touch(joinPath(DIR, "library/media_abc.mp4"));
    fs.touch("C:/secret/passwords.txt");
    const store = new ProjectStoreAccess(DIR, fs);
    // The widened matching must not have opened a new route for an untrusted ref.
    expect(await store.resolveMediaRef("media_../../secret/passwords.txt")).toBeNull();
    expect(await store.resolveMediaRef("media_abc/../../../secret/passwords.txt")).toBeNull();
    expect(await store.resolveMediaRef("C:/secret/passwords.txt")).toBeNull();
  });

  it("resolves an external (referenced-in-place) clip by its absolute path; null when missing", async () => {
    const fs = new MockFs();
    const ABS = "D:/footage/hero.mp4";
    fs.set(
      joinPath(DIR, "internals", "library.json"),
      JSON.stringify({
        version: 1,
        clips: [{ id: "media_ext", path: ABS, external: true, filename: "hero.mp4" }],
        folders: [],
      }),
    );
    fs.touch(ABS);
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveRef("media_ext")).toBe(joinPath(ABS));
    fs.files.delete(joinPath(ABS)); // source went offline
    expect(await store.resolveRef("media_ext")).toBeNull();
  });

  it("resolves by filename and by alias", async () => {
    const fs = new MockFs();
    withLibrary(fs, [
      { id: "clip_a", path: "library/clip_a.mp4", filename: "vid.mp4", aliases: ["hero"] },
    ]);
    fs.touch(joinPath(DIR, "library/clip_a.mp4"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveRef("vid.mp4")).toBe(joinPath(DIR, "library/clip_a.mp4"));
    expect(await store.resolveRef("hero")).toBe(joinPath(DIR, "library/clip_a.mp4"));
  });

  it("resolves an existing absolute path", async () => {
    const fs = new MockFs();
    fs.touch("C:/tmp/x.mp4");
    expect(await new ProjectStoreAccess(DIR, fs).resolveRef("C:/tmp/x.mp4")).toBe("C:/tmp/x.mp4");
  });

  it("resolves a project-relative path", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "inputs/a.wav"));
    expect(await new ProjectStoreAccess(DIR, fs).resolveRef("inputs/a.wav")).toBe(
      joinPath(DIR, "inputs/a.wav"),
    );
  });

  it("returns null for empty / unknown / missing refs", async () => {
    const store = new ProjectStoreAccess(DIR, new MockFs());
    expect(await store.resolveRef("")).toBeNull();
    expect(await store.resolveRef("nope")).toBeNull();
    expect(await store.resolveRef("clip_missing")).toBeNull();
    expect(await store.resolveRef("C:/nope.mp4")).toBeNull();
  });

  it("tolerates a missing or corrupt catalog", async () => {
    const fs = new MockFs();
    fs.set(joinPath(DIR, "internals", "library.json"), "{bad json");
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.listClips()).toEqual([]);
    expect(await store.resolveRef("clip_x")).toBeNull();
  });
});

describe("ProjectStoreAccess.resolveMediaRef (narrow agent-facing resolver)", () => {
  it("REJECTS a bare absolute path even when the file exists (resolveRef would accept it)", async () => {
    const fs = new MockFs();
    fs.touch("C:/secret/passwords.txt");
    const store = new ProjectStoreAccess(DIR, fs);
    // The trusted internal resolver accepts an absolute path...
    expect(await store.resolveRef("C:/secret/passwords.txt")).toBe("C:/secret/passwords.txt");
    // ...but the narrow agent-facing resolver refuses it: a crafted media_ref must not become an
    // arbitrary-file read (+ exfil-to-model via video_ask/inspect_media).
    expect(await store.resolveMediaRef("C:/secret/passwords.txt")).toBeNull();
    expect(await store.resolveMediaRef("/etc/passwd")).toBeNull();
    expect(await store.resolveMediaRef("\\\\server\\share\\x")).toBeNull();
  });

  it("REJECTS a project-relative path that escapes the project with `..` (even if the target exists)", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "../../etc/passwd"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveMediaRef("../../etc/passwd")).toBeNull();
    expect(await store.resolveMediaRef("sub/../../escape.txt")).toBeNull();
  });

  it("still resolves a registered library id / filename / alias", async () => {
    const fs = new MockFs();
    withLibrary(fs, [
      { id: "media_abc", path: "library/media_abc.mp4", filename: "vid.mp4", aliases: ["hero"] },
    ]);
    fs.touch(joinPath(DIR, "library/media_abc.mp4"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveMediaRef("media_abc")).toBe(joinPath(DIR, "library/media_abc.mp4"));
    expect(await store.resolveMediaRef("vid.mp4")).toBe(joinPath(DIR, "library/media_abc.mp4"));
    expect(await store.resolveMediaRef("hero")).toBe(joinPath(DIR, "library/media_abc.mp4"));
  });

  it("reaches an EXTERNAL clip via its media_id (its registered absolute path), NOT via a raw absolute string", async () => {
    const fs = new MockFs();
    const ABS = "D:/footage/hero.mp4";
    fs.set(
      joinPath(DIR, "internals", "library.json"),
      JSON.stringify({
        version: 1,
        clips: [{ id: "media_ext", path: ABS, external: true, filename: "hero.mp4" }],
        folders: [],
      }),
    );
    fs.touch(ABS);
    const store = new ProjectStoreAccess(DIR, fs);
    // Named by its id -> resolves to the registered external path (legitimate).
    expect(await store.resolveMediaRef("media_ext")).toBe(joinPath(ABS));
    // The very same absolute path typed directly by the agent is refused.
    expect(await store.resolveMediaRef(ABS)).toBeNull();
  });

  it("resolves a contained project-relative path; null for empty / unknown", async () => {
    const fs = new MockFs();
    fs.touch(joinPath(DIR, "inputs/a.wav"));
    const store = new ProjectStoreAccess(DIR, fs);
    expect(await store.resolveMediaRef("inputs/a.wav")).toBe(joinPath(DIR, "inputs/a.wav"));
    expect(await store.resolveMediaRef("")).toBeNull();
    expect(await store.resolveMediaRef("nope")).toBeNull();
  });
});

describe("ProjectStoreAccess.writeBytesAtomic (staged library commit)", () => {
  class BytesFs implements FsLike {
    files = new Map<string, string>();
    bytes = new Map<string, Uint8Array>();
    renames: Array<[string, string]> = [];
    failRename = false;
    async exists(p: string): Promise<boolean> {
      const n = joinPath(p);
      return this.files.has(n) || this.bytes.has(n);
    }
    async readTextFile(p: string): Promise<string> {
      const v = this.files.get(joinPath(p));
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    }
    async writeTextFile(p: string, c: string): Promise<void> {
      this.files.set(joinPath(p), c);
    }
    async mkdir(): Promise<void> {}
    async writeBytes(p: string, d: Uint8Array): Promise<void> {
      this.bytes.set(joinPath(p), d);
    }
    async readBytes(p: string): Promise<Uint8Array> {
      const v = this.bytes.get(joinPath(p));
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    }
    async rename(from: string, to: string): Promise<void> {
      this.renames.push([joinPath(from), joinPath(to)]);
      if (this.failRename) throw new Error("EXDEV cross-device");
      const b = this.bytes.get(joinPath(from));
      if (b === undefined) throw new Error(`ENOENT rename ${from}`);
      this.bytes.set(joinPath(to), b);
      this.bytes.delete(joinPath(from));
    }
    async remove(p: string): Promise<void> {
      this.bytes.delete(joinPath(p));
      this.files.delete(joinPath(p));
    }
  }
  const strays = (fs: BytesFs, dest: string): string[] =>
    [...fs.bytes.keys()].filter((k) => k !== joinPath(dest));

  it("stages to a temp then renames onto the destination — no partial + no temp left", async () => {
    const fs = new BytesFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const dest = joinPath(DIR, "library/media_abc.mp4");
    await store.writeBytesAtomic(dest, new Uint8Array([1, 2, 3]));
    expect(await store.readBytes(dest)).toEqual(new Uint8Array([1, 2, 3])); // committed
    expect(fs.renames.length).toBe(1); // went via temp -> rename, never a direct write to dest
    expect(fs.renames[0][1]).toBe(joinPath(dest)); // renamed ONTO the content-addressed dest
    expect(fs.renames[0][0].endsWith(".mp4")).toBe(false); // temp is NOT a media file (rescan can't pick it up)
    expect(strays(fs, dest)).toEqual([]); // no temp lingers
  });

  it("falls back to a direct write when the fs cannot rename", async () => {
    const fs = new BytesFs();
    (fs as { rename?: (from: string, to: string) => Promise<void> }).rename = undefined; // no atomic rename (tests / web)
    const store = new ProjectStoreAccess(DIR, fs);
    const dest = joinPath(DIR, "library/media_x.mp4");
    await store.writeBytesAtomic(dest, new Uint8Array([9]));
    expect(await store.readBytes(dest)).toEqual(new Uint8Array([9]));
  });

  it("on a rename failure, falls back to a direct write and cleans the temp", async () => {
    const fs = new BytesFs();
    fs.failRename = true;
    const store = new ProjectStoreAccess(DIR, fs);
    const dest = joinPath(DIR, "library/media_y.mp4");
    await store.writeBytesAtomic(dest, new Uint8Array([5, 6]));
    expect(await store.readBytes(dest)).toEqual(new Uint8Array([5, 6])); // fallback committed
    expect(strays(fs, dest)).toEqual([]); // temp cleaned up
  });
});

describe("ProjectStoreAccess io", () => {
  it("artifactPath maps to internals/cache/", () => {
    const store = new ProjectStoreAccess(DIR, new MockFs());
    expect(store.artifactPath("ffmpeg/out.mp4")).toBe(
      joinPath(DIR, "internals/cache/ffmpeg/out.mp4"),
    );
  });

  it("read/write/exists pass through the fs", async () => {
    const store = new ProjectStoreAccess(DIR, new MockFs());
    const p = joinPath(DIR, "cache/x.txt");
    await store.writeText(p, "hi");
    expect(await store.exists(p)).toBe(true);
    expect(await store.readText(p)).toBe("hi");
  });
});

describe("ProjectStoreAccess.writeTextAtomic", () => {
  class RenameFs extends MockFs {
    renames = 0;
    failRename = false;
    async remove(path: string): Promise<void> {
      this.files.delete(joinPath(path));
    }
    async rename(from: string, to: string): Promise<void> {
      this.renames++;
      if (this.failRename) throw new Error("rename unsupported");
      const v = this.files.get(joinPath(from));
      this.files.delete(joinPath(from));
      if (v !== undefined) this.files.set(joinPath(to), v);
    }
  }

  it("writes a temp file then renames it onto the target (no leftover temp)", async () => {
    const fs = new RenameFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const p = joinPath(DIR, "internals/timeline.json");
    await store.writeTextAtomic(p, "hello");
    expect(await store.readText(p)).toBe("hello");
    expect(fs.renames).toBe(1);
    expect([...fs.files.keys()].filter((k) => k.includes(".tmp-"))).toHaveLength(0);
  });

  it("falls back to a direct write when the fs has no rename", async () => {
    const store = new ProjectStoreAccess(DIR, new MockFs());
    const p = joinPath(DIR, "a/b.json");
    await store.writeTextAtomic(p, "x");
    expect(await store.readText(p)).toBe("x");
  });

  it("falls back to a direct write when rename throws (extensionless path)", async () => {
    const fs = new RenameFs();
    fs.failRename = true;
    const store = new ProjectStoreAccess(DIR, fs);
    const p = joinPath(DIR, "history");
    await store.writeTextAtomic(p, "y");
    expect(await store.readText(p)).toBe("y");
    expect(fs.renames).toBe(1);
  });

  it("commits (renames) when the liveness guard stays true", async () => {
    const fs = new RenameFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const p = joinPath(DIR, "internals/timeline.json");
    const committed = await store.writeTextAtomic(p, "NEW", () => true);
    expect(committed).toBe(true);
    expect(fs.renames).toBe(1);
    expect(await store.readText(p)).toBe("NEW");
  });

  it("abandons the commit (no rename) when the guard goes false between the temp write and the rename (finding #2)", async () => {
    const fs = new RenameFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const p = joinPath(DIR, "internals/timeline.json");
    fs.set(p, "OLD");
    let live = true;
    const realWrite = fs.writeTextFile.bind(fs);
    fs.writeTextFile = async (path: string, contents: string) => {
      await realWrite(path, contents);
      live = false; // the project closes AFTER the temp file is written but BEFORE the rename
    };
    const committed = await store.writeTextAtomic(p, "NEW", () => live);
    expect(committed).toBe(false); // abandoned at the rename boundary
    expect(fs.renames).toBe(0); // never renamed the temp into place
    expect(await store.readText(p)).toBe("OLD"); // the original is untouched
    expect([...fs.files.keys()].filter((k) => k.includes(".tmp-"))).toHaveLength(0); // temp cleaned up
  });

  it("re-checks the guard in the rename-failure fallback (finding #3)", async () => {
    const fs = new RenameFs();
    fs.failRename = true;
    const store = new ProjectStoreAccess(DIR, fs);
    const p = joinPath(DIR, "internals/timeline.json");
    fs.set(p, "OLD");
    let live = true;
    const origRename = fs.rename.bind(fs);
    fs.rename = async (from: string, to: string) => {
      live = false; // the session closes DURING the (failing) rename attempt
      return origRename(from, to); // throws (failRename) -> falls back to a direct write
    };
    const committed = await store.writeTextAtomic(p, "NEW", () => live);
    expect(committed).toBe(false); // the fallback re-checked the guard and abandoned
    expect(await store.readText(p)).toBe("OLD"); // OLD not clobbered by the unguarded fallback
  });
});

describe("ProjectStoreAccess.resolveWritable (write containment)", () => {
  const store = new ProjectStoreAccess(DIR, new MockFs());
  it("rejects a `..` traversal ref", () => {
    expect(store.resolveWritable("../secret.json")).toBeNull();
    expect(store.resolveWritable("a/../../b")).toBeNull();
    expect(store.resolveWritable("./../../etc/passwd")).toBeNull();
    expect(store.resolveWritable("..\\..\\evil")).toBeNull(); // backslashes normalise to /
  });
  it("rejects an absolute path outside the project root", () => {
    expect(store.resolveWritable("C:/Windows/System32/evil.dll")).toBeNull();
    expect(store.resolveWritable("/etc/cron.d/evil")).toBeNull();
  });
  it("accepts a project-relative path (joined under the root)", () => {
    expect(store.resolveWritable("renderer/out.mp4")).toBe(joinPath(DIR, "renderer/out.mp4"));
  });
  it("accepts an in-project absolute path unchanged", () => {
    const inside = joinPath(DIR, "cache/x.bin");
    expect(store.resolveWritable(inside)).toBe(inside);
  });
  it("rejects empty / whitespace", () => {
    expect(store.resolveWritable("")).toBeNull();
    expect(store.resolveWritable("   ")).toBeNull();
  });
});

describe("deleted-project tombstones (RF4)", () => {
  const GHOST = "C:/Users/x/projects/ghost";
  afterEach(() => reviveProjectDir(GHOST));

  class RecFs extends MockFs {
    mkdirs: string[] = [];
    bytes = new Map<string, Uint8Array>();
    async mkdir(...args: string[]): Promise<void> {
      this.mkdirs.push(joinPath(args[0] ?? ""));
    }
    async writeBytes(path: string, data: Uint8Array): Promise<void> {
      this.bytes.set(joinPath(path), data);
    }
  }

  it("drops every write once the dir is dead, and resumes on revive", async () => {
    const fs = new RecFs();
    const store = new ProjectStoreAccess(GHOST, fs);

    markProjectDirDead(GHOST);
    expect(isProjectDirDead(GHOST)).toBe(true);

    await store.writeText(joinPath(GHOST, "internals/a.txt"), "x");
    await store.writeTextAtomic(joinPath(GHOST, "internals/b.json"), "{}");
    await store.writeProjectText(joinPath(GHOST, "internals/transcript.json"), "{}");
    await store.writeBytes(joinPath(GHOST, "internals/thumbnail.jpg"), new Uint8Array([1, 2, 3]));
    // Hands back the artifact path but must NOT recreate the dir tree (the vector
    // an ffmpeg/whisper job would otherwise use to resurrect the folder).
    const art = await store.prepareArtifact("proxies/x.mp4");
    expect(art).toBe(joinPath(GHOST, "internals/cache/proxies/x.mp4"));

    expect(fs.files.size).toBe(0); // no text / atomic / project write landed
    expect(fs.bytes.size).toBe(0); // no bytes landed
    expect(fs.mkdirs).toEqual([]); // no dir recreated

    reviveProjectDir(GHOST);
    expect(isProjectDirDead(GHOST)).toBe(false);
    await store.writeText(joinPath(GHOST, "internals/a.txt"), "y");
    expect(fs.files.size).toBe(1); // writes resume after revive
  });
});
