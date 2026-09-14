import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectStoreAccess } from "../tools/store";
import {
  clearSourceUrlCache,
  resolvePosterUrl,
  resolvePreviewUrl,
  resolveSourceUrl,
  setAssetUrlConverter,
} from "./resolve";
import { posterRel, proxyRel } from "./proxyPaths";
import { shortHash } from "../tools/media";

function storeWith(fn: (ref: string) => Promise<string | null>) {
  const resolveRef = vi.fn(fn);
  const store = { projectDir: "/proj", resolveRef } as unknown as ProjectStoreAccess;
  return { store, resolveRef };
}

beforeEach(() => {
  clearSourceUrlCache();
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
  const store = { projectDir: "/proj", exists, resolveRef } as unknown as ProjectStoreAccess;
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

describe("resolvePreviewUrl", () => {
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
      ({ projectDir: dir, exists, resolveRef }) as unknown as ProjectStoreAccess;
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
