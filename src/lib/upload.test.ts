import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectStoreAccess } from "../tools/store";

// uploadFiles imports through the default desktopStore(); the tests set it.
let currentStore: ProjectStoreAccess | null = null;
vi.mock("./desktop", () => ({ desktopStore: () => currentStore }));

let platformName = "web";
vi.mock("../platform", () => ({
  get platform() {
    return { name: platformName, capabilities: { localTools: true, fileSystem: true } };
  },
}));

const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));

import {
  filesFromItems,
  importFile,
  importFileByReference,
  importViaDialog,
  MEDIA_RE,
  MIME_EXT,
  uploadFiles,
} from "./upload";
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, kindOf } from "../media/formats";
import { useProjectNotice } from "../store/projectNotice";

const fakeFile = (name: string, bytes: number[] = [1]) =>
  ({ name, arrayBuffer: async () => new Uint8Array(bytes).buffer }) as unknown as File;
const fakeStore = (writeBytesAtomic = vi.fn(async (_path: string, _bytes: Uint8Array) => {})) => {
  const cat = new Map<string, string>();
  return {
    projectDir: "C:/proj",
    writeBytesAtomic, // registerLibraryClip content-addresses the bytes through the atomic writer
    readBytes: async () => new Uint8Array([1]), // importFileByReference hashes the source
    exists: async (p: string) => cat.has(p),
    readText: async (p: string) => cat.get(p) ?? "",
    writeText: async (p: string, c: string) => void cat.set(p, c),
    writeTextAtomic: async (p: string, c: string) => {
      cat.set(p, c);
      return true; // the real writer returns committed:true; registerLibraryClip now checks it
    },
    readJson: async (_p: string, fallback: unknown) => fallback, // empty library.json -> the fallback catalog
  } as unknown as ProjectStoreAccess & { writeBytesAtomic: typeof writeBytesAtomic };
};

beforeEach(() => {
  currentStore = null;
  platformName = "web";
  openDialog.mockReset();
  useProjectNotice.setState({ message: null });
});

// A clipboard/drop carries SEVERAL flavours of one file, and macOS adds a QuickLook still of a
// copied video. Picking the wrong one is invisible: the import succeeds, and the user gets a
// .jpeg of frame 1 — which then lands on a lane as a 1-frame sliver.
describe("filesFromItems", () => {
  const item = (type: string, file: File | null) =>
    ({ kind: "file", type, getAsFile: () => file }) as unknown as DataTransferItem;
  const list = (...items: DataTransferItem[]) => items as unknown as DataTransferItemList;
  const blob = (name: string, type: string) => new File(["x"], name, { type });

  it("takes the video, not macOS's preview still of it", () => {
    const out = filesFromItems(
      list(
        item("image/jpeg", blob("", "image/jpeg")),
        item("video/quicktime", blob("clip.mov", "video/quicktime")),
      ),
    );
    expect(out.map((f) => f.name)).toEqual(["clip.mov"]);
  });

  it("maps the MIME type to a REAL extension instead of its subtype", () => {
    const out = filesFromItems(list(item("video/quicktime", blob("", "video/quicktime"))));
    expect(out).toHaveLength(1);
    // `.quicktime` is what splitting the MIME type gives, and nothing downstream can read it.
    expect(out[0].name).toMatch(/\.mov$/);
    expect(MEDIA_RE.test(out[0].name)).toBe(true);
  });

  it("drops a flavour that maps to no supported extension", () => {
    const t = "image/vnd.adobe.photoshop";
    expect(filesFromItems(list(item(t, blob("", t))))).toEqual([]);
  });

  it("falls back to the preview when the richer flavour has no bytes", () => {
    const out = filesFromItems(
      list(item("video/quicktime", null), item("image/jpeg", blob("shot.jpg", "image/jpeg"))),
    );
    expect(out.map((f) => f.name)).toEqual(["shot.jpg"]);
  });

  it("keeps a real filename rather than renaming it", () => {
    const out = filesFromItems(list(item("video/mp4", blob("holiday.mp4", "video/mp4"))));
    expect(out.map((f) => f.name)).toEqual(["holiday.mp4"]);
  });

  // MIME_EXT is a TABLE that decides what a pasted file is CALLED, and a wrong or empty entry is
  // invisible in use: the import succeeds and the asset is simply unreadable afterwards. Mutation
  // testing proved the point — blanking any audio entry survived the three hand-picked cases
  // above. Walk every row instead.
  describe("every MIME_EXT row", () => {
    const SUPPORTED = new Set<string>([...VIDEO_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS]);

    it.each(Object.entries(MIME_EXT))("%s names a file the app can actually read", (mime, ext) => {
      expect(ext).toMatch(/^\.[a-z0-9]+$/);
      expect(SUPPORTED.has(ext.slice(1))).toBe(true);
      expect(MEDIA_RE.test(`x${ext}`)).toBe(true);
      // the extension must imply the SAME kind as the MIME family, or the library row lies
      expect(kindOf(`x${ext}`)).toBe(mime.split("/")[0]);
    });

    it.each(Object.entries(MIME_EXT))("%s survives the paste reader", (mime, ext) => {
      const out = filesFromItems(list(item(mime, blob("", mime))));
      expect(out).toHaveLength(1);
      expect(out[0].name.endsWith(ext)).toBe(true);
    });
  });
});

// The macOS bug: the window runs with dragDropEnabled, which stops `<input type=file>` from ever
// opening a dialog there — the button does nothing at all, silently, while Windows is fine. So
// desktop must NOT reach for that input, and web must still be able to.
describe("importViaDialog", () => {
  it("returns null on web so the caller falls back to the file input", async () => {
    platformName = "web";
    const out = await importViaDialog("proj", "Attach media");
    expect(out).toBeNull();
    expect(openDialog).not.toHaveBeenCalled();
  });

  it("uses the OS dialog on desktop, never the file input", async () => {
    platformName = "tauri";
    currentStore = fakeStore();
    openDialog.mockResolvedValue(["/Users/me/a.mp4"]);
    const out = await importViaDialog("proj", "Attach media");
    expect(openDialog).toHaveBeenCalledOnce();
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    expect(out![0].name).toBe("a.mp4");
  });

  it("offers media extensions and allows several files", async () => {
    platformName = "tauri";
    currentStore = fakeStore();
    openDialog.mockResolvedValue([]);
    await importViaDialog("proj", "Attach media");
    const opts = openDialog.mock.calls[0][0] as {
      multiple: boolean;
      filters: { extensions: string[] }[];
    };
    expect(opts.multiple).toBe(true);
    for (const ext of ["mp4", "png", "mp3"]) expect(opts.filters[0].extensions).toContain(ext);
  });

  // Cancelling is not a failure, and telling the user it is would be worse than saying nothing.
  it("reports nothing when the dialog is cancelled", async () => {
    platformName = "tauri";
    openDialog.mockResolvedValue(null);
    const out = await importViaDialog("proj", "Attach media");
    expect(out).toEqual([]);
    expect(useProjectNotice.getState().message).toBeNull();
  });

  it("names a file it could not import", async () => {
    platformName = "tauri";
    currentStore = null; // no store -> importFileByReference throws
    openDialog.mockResolvedValue(["/Users/me/a.mp4"]);
    const out = await importViaDialog("proj", "Attach media");
    expect(out).toEqual([]);
    expect(useProjectNotice.getState().message).toMatch(/couldn't import a\.mp4/i);
  });
});

describe("uploadFiles", () => {
  it("content-addresses each file into the library and returns their refs", async () => {
    currentStore = fakeStore();
    const out = await uploadFiles("proj", [fakeFile("a.mp4", [1]), fakeFile("b.mp4", [2])]);
    expect(out).toHaveLength(2);
    for (const u of out) {
      expect(u.rel).toMatch(/^library\/media_[0-9a-f]{12}\.mp4$/);
      expect(u.path).toBe(`C:/proj/${u.rel}`);
      expect(u.name).toMatch(/^[ab]\.mp4$/);
    }
  });

  it("imports the rest when one file fails, and still reports the one that did", async () => {
    currentStore = fakeStore();
    const bad = {
      name: "a.mp4",
      arrayBuffer: async () => {
        throw new Error("boom");
      },
    } as unknown as File;
    const out = await uploadFiles("proj", [bad, fakeFile("b.mp4", [2])]);
    expect(out).toHaveLength(1);
    expect(useProjectNotice.getState().message).toMatch(/a\.mp4/); // partial success is still reported
    expect(out[0].rel).toMatch(/^library\/media_[0-9a-f]{12}\.mp4$/);
  });

  // This used to assert ONLY that nothing was imported, which is exactly what the bug did:
  // every picker, paste and drop returned an empty list and told the user nothing, so a broken
  // import was indistinguishable from a dead button. Reported as "attach does nothing".
  it("tells the user when there is no store (no desktop client)", async () => {
    currentStore = null;
    const out = await uploadFiles("proj", [fakeFile("a.mp4")]);
    expect(out).toEqual([]);
    expect(useProjectNotice.getState().message).toMatch(/couldn't import a\.mp4/i);
    expect(useProjectNotice.getState().message).toMatch(/desktop client/);
  });

  it("stays silent when every file imports", async () => {
    currentStore = fakeStore();
    await uploadFiles("proj", [fakeFile("a.mp4")]);
    expect(useProjectNotice.getState().message).toBeNull(); // no crying wolf on success
  });

  it("names every file that failed, not just the first", async () => {
    currentStore = fakeStore();
    const bad = (name: string) =>
      ({
        name,
        arrayBuffer: async () => {
          throw new Error("boom");
        },
      }) as unknown as File;
    await uploadFiles("proj", [bad("a.mp4"), bad("b.mp4")]);
    const msg = String(useProjectNotice.getState().message);
    expect(msg).toContain("a.mp4");
    expect(msg).toContain("b.mp4");
  });

  it("MEDIA_RE matches common media, rejects others", () => {
    expect(MEDIA_RE.test("clip.MP4")).toBe(true);
    expect(MEDIA_RE.test("a.png")).toBe(true);
    expect(MEDIA_RE.test("song.wav")).toBe(true);
    expect(MEDIA_RE.test("notes.txt")).toBe(false);
  });
});

describe("importFile", () => {
  it("content-addresses the bytes into the library (desktop)", async () => {
    const writeBytesAtomic = vi.fn(async (_path: string, _bytes: Uint8Array) => {});
    const out = await importFile(
      "proj",
      fakeFile("clip.mp4", [1, 2, 3]),
      fakeStore(writeBytesAtomic),
    );
    expect(out.name).toBe("clip.mp4");
    expect(out.rel).toMatch(/^library\/media_[0-9a-f]{12}\.mp4$/);
    expect(out.path).toBe(`C:/proj/${out.rel}`);
    expect(writeBytesAtomic).toHaveBeenCalledOnce();
    const [dest, bytes] = writeBytesAtomic.mock.calls[0];
    expect(dest).toBe(`C:/proj/${out.rel}`);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("keys the path on the content hash, so a dropped name can't escape", async () => {
    const out = await importFile("proj", fakeFile("../../etc/passwd.mp4"), fakeStore());
    expect(out.name).toBe("passwd.mp4");
    expect(out.rel).toMatch(/^library\/media_[0-9a-f]{12}\.mp4$/);
    expect(out.path).toBe(`C:/proj/${out.rel}`);
  });

  it("throws when there is no store (no desktop client)", async () => {
    await expect(importFile("proj", fakeFile("x.mp4"), null)).rejects.toThrow(/desktop client/);
  });
});

describe("importFileByReference", () => {
  const refStore = () => {
    const cat = new Map<string, string>();
    return {
      projectDir: "C:/proj",
      readBytes: async (_p: string) => new Uint8Array([1, 2, 3]),
      readJson: async (_p: string, fallback: unknown) => fallback,
      writeTextAtomic: async (p: string, c: string) => {
        cat.set(p, c);
        return true; // committed:true — registerLibraryClip now checks the write outcome
      },
    } as unknown as ProjectStoreAccess;
  };

  it("records the ABSOLUTE source path in the library without copying the bytes (external)", async () => {
    const out = await importFileByReference("proj", "D:/media/hero.mp4", refStore());
    expect(out.name).toBe("hero.mp4");
    expect(out.path).toBe("D:/media/hero.mp4"); // the absolute source, unchanged
    expect(out.rel).toBe("D:/media/hero.mp4"); // an external entry records the absolute path as its ref
  });

  it("throws without a store (no desktop client)", async () => {
    await expect(importFileByReference("proj", "D:/x.mp4", null)).rejects.toThrow(/desktop client/);
  });
});

// Reported in alpha: the app died on a ~1 GB import. `await file.arrayBuffer()` puts the WHOLE
// file in the webview's heap, so the renderer was killed before any of our code could report it
// -- which is why nothing reached Sentry. These assert the file NEVER passes through JS whole,
// not that some particular API was called.
describe("a large file is never materialised in the webview", () => {
  /** A file that refuses to be read whole, the way a real one refuses by crashing. */
  const hugeFile = (name: string, size: number, chunk = 8) => {
    let served = 0;
    return {
      name,
      arrayBuffer: () => {
        throw new Error("arrayBuffer() on a file this size is what killed the renderer");
      },
      stream: () => ({
        getReader: () => ({
          read: async () => {
            if (served >= size) return { done: true, value: undefined };
            const n = Math.min(chunk, size - served);
            served += n;
            return { done: false, value: new Uint8Array(n).fill(7) };
          },
          releaseLock: () => {},
        }),
      }),
    } as unknown as File;
  };

  const streamingStore = () => {
    const appended: number[] = [];
    const cat = new Map<string, string>();
    const renamed: Array<[string, string]> = [];
    const store = {
      projectDir: "C:/proj",
      canStreamImport: true,
      appendBytes: async (_p: string, d: Uint8Array) => {
        appended.push(d.length);
        return true;
      },
      probeMedia: async (_p: string, headBytes: number) => ({
        id12: "abcdef012345",
        size: 1_000_000_000,
        head: new Uint8Array(Math.min(headBytes, 16)).fill(7),
      }),
      rename: async (from: string, to: string) => void renamed.push([from, to]),
      remove: async () => {},
      exists: async (p: string) => cat.has(p),
      readJson: async (_p: string, fallback: unknown) => fallback,
      writeTextAtomic: async (p: string, c: string) => {
        cat.set(p, c);
        return true;
      },
      writeBytesAtomic: async () => {
        throw new Error("the whole-buffer write path must not be reached for a streamed import");
      },
      readBytes: async () => {
        throw new Error("a referenced import must not read the file");
      },
    } as unknown as ProjectStoreAccess;
    return { store, appended, renamed, cat };
  };

  it("spools a drag-dropped file in chunks and never calls arrayBuffer()", async () => {
    const { store, appended, renamed } = streamingStore();
    const out = await importFile("proj", hugeFile("big.mp4", 40), store);
    expect(out.rel).toBe("library/media_abcdef012345.mp4");
    expect(appended.reduce((a, b) => a + b, 0)).toBe(40); // every byte written, none held
    expect(renamed[0]?.[1]).toBe("C:/proj/library/media_abcdef012345.mp4");
  });

  it("records the size the file really is, not the size of what JS held", async () => {
    const { store, cat } = streamingStore();
    await importFile("proj", hugeFile("big.mp4", 40), store);
    const written = JSON.parse([...cat.values()][0]) as { clips: { size_bytes: number }[] };
    expect(written.clips[0].size_bytes).toBe(1_000_000_000);
  });

  it("a referenced import does not read the file at all", async () => {
    const { store, appended } = streamingStore();
    const out = await importFileByReference("proj", "D:/media/huge.mp4", store);
    expect(out.rel).toBe("D:/media/huge.mp4"); // still recorded in place
    expect(appended).toEqual([]); // nothing copied
  });

  it("still works whole-buffer where streaming is unavailable (web/tests)", async () => {
    const write = vi.fn(async (_p: string, _b: Uint8Array) => {});
    const out = await importFile("proj", fakeFile("small.mp4", [1, 2, 3]), fakeStore(write));
    expect(write).toHaveBeenCalled();
    expect(out.rel).toMatch(/^library\/media_[0-9a-f]{12}\.mp4$/);
  });
});
