import { beforeEach, describe, expect, it, vi } from "vitest";

import { joinPath, ProjectStoreAccess, type FsLike } from "../tools/store";
import { MemFs } from "../test/timelineKit";
import { serializePackIndex } from "../media/stillFrames";
import { highH264DecodesCorrectly } from "./h264Support";
import { announceMediaDerived } from "./mediaDerived";
import {
  _resetAssetAccess,
  clearSourceUrlCache,
  projectThumbnailUrl,
  resolvePosterUrl,
  resolvePreviewUrl,
  resolveSourceUrl,
  resolveStillAnimation,
  setAssetAccessGrant,
  setAssetUrlConverter,
} from "./resolve";
import { animIndexRel, animPackRel, posterRel, proxyKey, proxyRel, webOkRel } from "./proxyPaths";
import { shortHash } from "../tools/media";

vi.mock("./h264Support", () => ({ highH264DecodesCorrectly: vi.fn() }));

/** The store's own containment and library rules, over an empty disk (these fakes mock resolveRef). */
const NO_DISK = { exists: async () => false } as unknown as FsLike;
const REAL = new ProjectStoreAccess("/proj", NO_DISK);
const rules = {
  resolveWritable: (p: string) => REAL.resolveWritable(p),
  linksFile: (p: string) => REAL.linksFile(p),
};

function storeWith(fn: (ref: string) => Promise<string | null>) {
  const resolveRef = vi.fn(fn);
  const store = { projectDir: "/proj", resolveRef, ...rules } as unknown as ProjectStoreAccess;
  return { store, resolveRef };
}

let grants: Array<[string, boolean]> = [];
beforeEach(() => {
  vi.mocked(highH264DecodesCorrectly).mockResolvedValue(true);
  clearSourceUrlCache();
  _resetAssetAccess();
  grants = [];
  setAssetAccessGrant(async (path, directory) => {
    grants.push([path, directory]);
  });
  setAssetUrlConverter((p) => `asset://${p}`);
});

describe("resolveSourceUrl", () => {
  it("returns null for an empty/blank source", async () => {
    const { store } = storeWith(async () => "/abs");
    expect(await resolveSourceUrl(store, "")).toBeNull();
    expect(await resolveSourceUrl(store, "   ")).toBeNull();
  });

  it("passes through already-fetchable URLs untouched", async () => {
    const { store, resolveRef } = storeWith(async () => "/abs");
    for (const u of ["https://x/y.mp4", "blob:abc", "data:xyz", "asset://z", "tauri://w"]) {
      expect(await resolveSourceUrl(store, u)).toBe(u);
    }
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it("resolves a ref to an absolute path then to an asset URL", async () => {
    const { store } = storeWith(async (ref) => (ref === "media_1" ? "/proj/library/a.mp4" : null));
    expect(await resolveSourceUrl(store, "media_1")).toBe("asset:///proj/library/a.mp4");
  });

  it("returns null when the ref does not resolve", async () => {
    const { store } = storeWith(async () => null);
    expect(await resolveSourceUrl(store, "missing.mp4")).toBeNull();
  });

  it("caches the resolution (resolveRef called once per source)", async () => {
    const { store, resolveRef } = storeWith(async () => "/proj/x.mp4");
    await resolveSourceUrl(store, "x.mp4");
    await resolveSourceUrl(store, "x.mp4");
    expect(resolveRef).toHaveBeenCalledTimes(1);
  });

  it("clearSourceUrlCache forces re-resolution", async () => {
    const { store, resolveRef } = storeWith(async () => "/proj/x.mp4");
    await resolveSourceUrl(store, "x.mp4");
    clearSourceUrlCache();
    await resolveSourceUrl(store, "x.mp4");
    expect(resolveRef).toHaveBeenCalledTimes(2);
  });
});

function previewStore(existsFn: (p: string) => boolean, refFn: (ref: string) => string | null) {
  const exists = vi.fn(async (p: string) => existsFn(p));
  const resolveRef = vi.fn(async (ref: string) => refFn(ref));
  const store = {
    projectDir: "/proj",
    exists,
    resolveRef,
    ...rules,
  } as unknown as ProjectStoreAccess;
  return { store, exists, resolveRef };
}

describe("proxyPaths", () => {
  it("derives stable, distinct proxy + poster paths from the source", () => {
    const h = shortHash("inputs/uploads/a.mp4");
    expect(proxyRel("inputs/uploads/a.mp4")).toMatch(
      new RegExp(`^internals/cache/proxies/${h}\\.r\\d+\\.mp4$`),
    );
    expect(posterRel("inputs/uploads/a.mp4")).toMatch(
      new RegExp(`^internals/cache/posters/${h}\\.r\\d+\\.jpg$`),
    );
  });
});

describe("every media resolution cache respects invalidation", () => {
  const resolvers = {
    source: resolveSourceUrl,
    preview: resolvePreviewUrl,
    poster: resolvePosterUrl,
    animation: resolveStillAnimation,
  };

  for (const [name, resolve] of Object.entries(resolvers)) {
    for (const ordering of ["old-first", "ready-first"] as const) {
      it(`${name}: ${ordering} cannot return or retain a pre-arrival answer`, async () => {
        vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
        const fs = new MemFs();
        const source = name === "animation" ? "library/take.gif" : "library/take.mp4";
        const nextSource = "library/relinked.mp4";
        const catalog = "/proj/internals/library.json";
        await fs.writeTextFile(`/proj/${source}`, "original bytes");
        await fs.writeTextFile(
          catalog,
          JSON.stringify({ clips: [{ id: "media_take", kind: "video", path: source }] }),
        );
        const store = new ProjectStoreAccess("/proj", fs);
        let release!: () => void;
        let reached!: () => void;
        const blocked = new Promise<void>((finish) => {
          release = finish;
        });
        const entered = new Promise<void>((finish) => {
          reached = finish;
        });
        if (name === "source") {
          setAssetUrlConverter(async (path) => {
            if (path === `/proj/${source}`) {
              reached();
              await blocked;
            }
            return `asset://${path}`;
          });
        } else {
          vi.spyOn(store, "exists").mockImplementationOnce(async () => {
            reached();
            await blocked;
            return false;
          });
        }
        const pending = resolve(store, "media_take");
        await entered;
        const timing = { den: 30, pts: [0, 30], period: 60, passes: Infinity };
        let ready: string | { url: string; timing: typeof timing };
        if (name === "source") {
          await fs.writeTextFile(`/proj/${nextSource}`, "replacement bytes");
          await fs.writeTextFile(
            catalog,
            JSON.stringify({ clips: [{ id: "media_take", kind: "video", path: nextSource }] }),
          );
          ready = `asset:///proj/${nextSource}`;
        } else if (name === "animation") {
          await fs.writeTextFile(
            `/proj/${animIndexRel(source)}`,
            serializePackIndex({ timing, w: 16, h: 16 }),
          );
          await fs.writeTextFile(`/proj/${animPackRel(source)}`, "frame pack");
          ready = { url: `asset:///proj/${animPackRel(source)}`, timing };
        } else {
          const artifact = name === "preview" ? proxyRel(source) : posterRel(source);
          await fs.writeTextFile(`/proj/${artifact}`, "derived bytes");
          ready = `asset:///proj/${artifact}`;
        }
        announceMediaDerived(source);
        if (ordering === "ready-first") expect(await resolve(store, "media_take")).toEqual(ready);
        release();
        expect(await pending).toEqual(ready);
        expect(await resolve(store, "media_take")).toEqual(ready);
        expect(await fs.readTextFile(`/proj/${source}`)).toBe("original bytes");
      });
    }
  }
});

describe("resolvePreviewUrl", () => {
  it("does not let a lookup started before proxy arrival replace the ready URL", async () => {
    vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
    const source = "/proj/library/recording.mp4";
    const proxy = `/proj/${proxyRel(source)}`;
    const files = new Set<string>();
    let finishOldCheck!: (found: boolean) => void;
    const oldCheck = new Promise<boolean>((resolve) => {
      finishOldCheck = resolve;
    });
    const { store, exists } = previewStore(
      (path) => files.has(path),
      (ref) => ref,
    );
    exists.mockImplementationOnce(() => oldCheck);
    const pending = resolvePreviewUrl(store, source);
    await vi.waitFor(() => expect(exists).toHaveBeenCalledOnce());

    files.add(proxy);
    announceMediaDerived(source);
    expect(await resolvePreviewUrl(store, source)).toBe(`asset://${proxy}`);
    finishOldCheck(false);
    expect(await pending).toBe(`asset://${proxy}`);

    expect(await resolvePreviewUrl(store, source)).toBe(`asset://${proxy}`);
  });

  it("prefers the H.264 proxy when one exists for a video source", async () => {
    const { store, exists } = previewStore(
      (p) => p.includes("cache/proxies/"),
      (r) => r,
    );
    const url = await resolvePreviewUrl(store, "inputs/uploads/a.mp4");
    expect(url).toBe(`asset:///proj/${proxyRel("inputs/uploads/a.mp4")}`);
    expect(exists).toHaveBeenCalledOnce();
  });

  it("falls back to the original when no proxy exists", async () => {
    const { store } = previewStore(
      () => false,
      (r) => (r === "inputs/uploads/a.mp4" ? "/proj/inputs/uploads/a.mp4" : null),
    );
    expect(await resolvePreviewUrl(store, "inputs/uploads/a.mp4")).toBe(
      "asset:///proj/inputs/uploads/a.mp4",
    );
  });

  it("does not present an unverified original or an obsolete proxy on a failing runtime", async () => {
    vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
    const source = "/proj/library/a.mp4";
    const files = new Set([
      `/proj/internals/cache/proxies/${proxyKey(source)}.webok`,
      `/proj/internals/cache/proxies/${proxyKey(source)}.r3.mp4`,
      `/proj/${webOkRel(source, true)}`,
    ]);
    const { store } = previewStore(
      (p) => files.has(p),
      (ref) => ref,
    );
    expect(await resolvePreviewUrl(store, source)).toBeNull();
    files.add(`/proj/${proxyRel(source)}`);
    announceMediaDerived(source);
    expect(await resolvePreviewUrl(store, source)).toBe(`asset:///proj/${proxyRel(source)}`);
  });

  it("permits an original approved for this runtime, not just any cached approval", async () => {
    vi.mocked(highH264DecodesCorrectly).mockResolvedValue(false);
    const source = "/proj/library/a.mp4";
    const { store } = previewStore(
      (p) => p === `/proj/${webOkRel(source, false)}`,
      (ref) => ref,
    );
    expect(await resolvePreviewUrl(store, source)).toBe(`asset://${source}`);
  });

  it("skips the proxy check for non-video and passthrough sources", async () => {
    const { store, exists } = previewStore(
      () => true,
      () => "/proj/x",
    );
    await resolvePreviewUrl(store, "inputs/uploads/pic.png"); // not a video
    expect(await resolvePreviewUrl(store, "https://x/a.mp4")).toBe("https://x/a.mp4"); // passthrough
    expect(exists).not.toHaveBeenCalled();
  });

  // The preview client re-resolves EVERY source whenever the timeline object changes, and an edit
  // or a single pointermove of a drag yields a new object. Each unmemoised resolve is a resolveRef
  // plus an `exists` over Tauri IPC, and the worker cannot draw the new timeline until they all
  // return. Counting the round-trips is the point: the URL comes back correct either way, so an
  // assertion on the URL alone cannot see the cost.
  it("asks the filesystem once per source, not once per render", async () => {
    const { store, exists, resolveRef } = previewStore(
      (p) => p.includes("cache/proxies/"),
      (r) => r,
    );
    for (let i = 0; i < 20; i++) await resolvePreviewUrl(store, "inputs/uploads/a.mp4");
    expect(exists).toHaveBeenCalledTimes(1);
    // Two: the source, then the proxy path it swapped in. Constant, not per render.
    expect(resolveRef).toHaveBeenCalledTimes(2);
  });

  it("re-checks after the cache is cleared, so a proxy written later is picked up", async () => {
    // Proxies are transcoded in the background AFTER import, so a "no proxy" answer must not be
    // permanent — indexCoordinator clears this once a transcode lands.
    let transcoded = false;
    const { store } = previewStore(
      (p) => transcoded && p.includes("cache/proxies/"),
      (r) => r,
    );
    const src = "inputs/uploads/a.mp4";
    expect(await resolvePreviewUrl(store, src)).toBe(`asset://${src}`);

    transcoded = true;
    expect(await resolvePreviewUrl(store, src)).toBe(`asset://${src}`); // still memoised
    clearSourceUrlCache();
    expect(await resolvePreviewUrl(store, src)).toBe(`asset:///proj/${proxyRel(src)}`);
  });

  it("keys the memo per project, so a switch does not serve another project's proxy", async () => {
    const exists = vi.fn(async (p: string) => p.startsWith("/a/"));
    const resolveRef = vi.fn(async (r: string) => r);
    const mk = (dir: string) =>
      Object.assign(new ProjectStoreAccess(dir, NO_DISK), { exists, resolveRef });
    const src = "inputs/uploads/a.mp4";

    expect(await resolvePreviewUrl(mk("/a"), src)).toBe(`asset:///a/${proxyRel(src)}`);
    expect(await resolvePreviewUrl(mk("/b"), src)).toBe(`asset://${src}`);
  });
});

// A cold video layer has no texture, so the compositor draws its black base — which is what
// pressing play on a freshly-opened project looked like for the first few seconds. The poster
// already exists on disk for the timeline thumbnail; these pin that the preview can find it.
describe("resolvePosterUrl", () => {
  const src = "inputs/uploads/a.mp4";

  it("finds the generated poster for a source", async () => {
    const { store } = previewStore(
      (p) => p.includes("cache/posters/"),
      (r) => r,
    );
    expect(await resolvePosterUrl(store, src)).toBe(`asset:///proj/${posterRel(src)}`);
  });

  it("answers null when none has been generated, rather than a broken URL", async () => {
    const { store } = previewStore(
      () => false,
      (r) => r,
    );
    expect(await resolvePosterUrl(store, src)).toBeNull();
  });

  it("does not go to disk for a passthrough URL", async () => {
    const { store, exists } = previewStore(
      () => true,
      (r) => r,
    );
    expect(await resolvePosterUrl(store, "https://x/a.mp4")).toBeNull();
    expect(exists).not.toHaveBeenCalled();
  });

  it("asks once per source, like the other resolutions", async () => {
    const { store, exists } = previewStore(
      (p) => p.includes("cache/posters/"),
      (r) => r,
    );
    for (let i = 0; i < 10; i++) await resolvePosterUrl(store, src);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it("does not collide with the proxy memo for the same source", async () => {
    // Both memos share one map; keying them the same would serve a poster as the video.
    const { store } = previewStore(
      () => true,
      (r) => r,
    );
    expect(await resolvePreviewUrl(store, src)).toBe(`asset:///proj/${proxyRel(src)}`);
    expect(await resolvePosterUrl(store, src)).toBe(`asset:///proj/${posterRel(src)}`);
  });
});

// The asset protocol serves only the app's data folder and the home folder by itself. Footage on a
// second drive or a camera card - or a project kept there - was readable only on the run it was
// picked in a dialog, black after every restart, and never for the agent's imports (UJ-027).
describe("preview file access: the library is the gate (UJ-027)", () => {
  const DIR = "D:/Projects/birthday_1a2b3c"; // kept on a second drive, as New Project allows
  const CARD = "E:/DCIM/100CANON/MVI_0001.MP4";
  const STRANGER = "E:/DCIM/100CANON/MVI_0002.MP4"; // same card, never imported

  class Disk implements FsLike {
    files = new Map<string, string>();
    put(p: string, s = ""): void {
      this.files.set(joinPath(p), s);
    }
    async exists(p: string): Promise<boolean> {
      return this.files.has(joinPath(p));
    }
    async readTextFile(p: string): Promise<string> {
      const v = this.files.get(joinPath(p));
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    }
    async writeTextFile(p: string, s: string): Promise<void> {
      this.put(p, s);
    }
    async mkdir(): Promise<void> {}
  }

  function project(dir = DIR): { store: ProjectStoreAccess; disk: Disk } {
    const disk = new Disk();
    disk.put(
      joinPath(dir, "internals", "library.json"),
      JSON.stringify({
        clips: [
          { id: "media_card", path: CARD, external: true, filename: "MVI_0001.MP4", kind: "video" },
          { id: "media_copy", path: "library/media_copy.mp4", kind: "video" },
        ],
      }),
    );
    for (const p of [CARD, STRANGER, joinPath(dir, "library/media_copy.mp4")]) disk.put(p);
    disk.put(joinPath(dir, posterRel("library/media_copy.mp4")));
    disk.put(`${dir}/../elsewhere/x.mp4`);
    return { store: new ProjectStoreAccess(dir, disk), disk };
  }

  it("opens a linked library file BEFORE its URL is handed out", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setAssetAccessGrant(async (path, directory) => {
      grants.push([path, directory]);
      await gate;
    });
    let url: string | null | undefined;
    const pending = resolveSourceUrl(project().store, "media_card").then((u) => (url = u));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(grants).toEqual([[CARD, false]]);
    expect(url, "a URL went out before the file was opened to the preview").toBeUndefined();
    release();
    await pending;
    expect(url).toBe(`asset://${CARD}`);
  });

  it("opens the project's own folder once for every file in it", async () => {
    const { store } = project();
    await resolveSourceUrl(store, "media_copy");
    await resolveSourceUrl(store, posterRel("library/media_copy.mp4"));
    await resolveSourceUrl(store, joinPath(DIR, "library/media_copy.mp4"));
    expect(grants).toEqual([[DIR, true]]);
  });

  it("opens nothing for a file the library does not link, even next to one it does", async () => {
    const { store } = project();
    // Today's answer stands for such a file: a URL, which the static scope then judges.
    expect(await resolveSourceUrl(store, STRANGER)).toBe(`asset://${STRANGER}`);
    // A `..` out of the project is not the project's folder.
    expect(await resolveSourceUrl(store, `${DIR}/../elsewhere/x.mp4`)).not.toBeNull();
    expect(grants).toEqual([]);
  });

  it("asks again after a grant fails, still hands out the URL, and asks once per run after", async () => {
    let calls = 0;
    setAssetAccessGrant(async () => {
      calls += 1;
      if (calls === 1) throw new Error("IPC down");
    });
    const { store } = project();
    expect(await resolveSourceUrl(store, "media_card")).toBe(`asset://${CARD}`);
    clearSourceUrlCache();
    await resolveSourceUrl(store, "media_card");
    expect(calls).toBe(2);
    clearSourceUrlCache();
    await resolveSourceUrl(store, "media_card");
    expect(calls, "a file already opened is not asked for again in the same run").toBe(2);
  });

  it("gives another project its own folder", async () => {
    await resolveSourceUrl(project().store, "media_copy");
    await resolveSourceUrl(project("F:/Work/promo_9f8e7d").store, "media_copy");
    expect(grants).toEqual([
      [DIR, true],
      ["F:/Work/promo_9f8e7d", true],
    ]);
  });

  it("serves a linked file's preview proxy from the project's folder", async () => {
    const { store, disk } = project();
    const proxy = joinPath(DIR, proxyRel(CARD));
    disk.put(proxy);
    expect(await resolvePreviewUrl(store, "media_card")).toBe(`asset://${proxy}`);
    expect(grants).toEqual([[DIR, true]]);
  });

  it("opens a listed project's folder for its thumbnail in the project picker", async () => {
    expect(await projectThumbnailUrl(DIR)).toBe(`asset://${DIR}/internals/thumbnail.jpg`);
    expect(grants).toEqual([[DIR, true]]);
  });
});
