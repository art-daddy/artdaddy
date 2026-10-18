import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import manifest from "../../src-tauri/resources/brand/manifest.json";
import { recoverBrandAsset } from "./brandRecovery";

const state = vi.hoisted(() => ({ root: "", failRename: false }));
vi.mock("../tools/dataRoot", () => ({ appCacheRoot: async () => state.root }));
vi.mock("../api/config", () => ({ apiBase: () => "https://branding.test" }));
vi.mock("../api/auth", () => ({
  authedFetch: (url: string, init: RequestInit, send: typeof fetch) => send(url, init),
}));
vi.mock("../tools/tauri", async () => {
  const files = await import("node:fs/promises");
  const crypto = await import("node:crypto");
  return {
    TauriFs: class {
      async exists(file: string) {
        return !!(await files.stat(file).catch(() => null));
      }
      async stat(file: string) {
        return files.stat(file);
      }
      async mkdir(file: string) {
        await files.mkdir(file, { recursive: true });
      }
      async writeBytes(file: string, bytes: Uint8Array) {
        await files.writeFile(file, bytes);
      }
      async remove(file: string) {
        await files.rm(file, { force: true });
      }
      async rename(from: string, to: string) {
        if (state.failRename) throw new Error("deep cache publication failure");
        await files.rename(from, to);
      }
      async probeMedia(file: string) {
        const bytes = await files.readFile(file);
        return {
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
        };
      }
    },
  };
});

const assets = path.resolve(process.cwd(), "src-tauri/resources/brand");
const names = Object.keys(manifest.assets) as Array<keyof typeof manifest.assets>;

beforeEach(async () => {
  state.root = await fsp.mkdtemp(path.join(os.tmpdir(), "artdaddy-brand-recovery-"));
  state.failRename = false;
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await fsp.rm(state.root, { recursive: true, force: true });
});

describe("backend branding asset recovery", () => {
  it("accepts verified decoded bytes when content length describes a compressed response", async () => {
    const name = "watermark-16x9.png";
    const bytes = await fsp.readFile(path.join(assets, name));
    const request = vi.fn(
      async () =>
        new Response(bytes, { headers: { "content-length": "71", "content-encoding": "gzip" } }),
    );
    vi.stubGlobal("fetch", request);
    const file = await recoverBrandAsset(name);
    expect(file).not.toBeNull();
    expect((await fsp.readFile(file!)).equals(bytes)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("recovers and reuses every real pinned asset without changing its bytes", async () => {
    const request = vi.fn(
      async (url: string) =>
        new Response(await fsp.readFile(path.join(assets, url.split("/").at(-1)!))),
    );
    vi.stubGlobal("fetch", request);
    for (const name of names) {
      const file = await recoverBrandAsset(name);
      expect(file).not.toBeNull();
      const bytes = await fsp.readFile(file!);
      expect(bytes.equals(await fsp.readFile(path.join(assets, name)))).toBe(true);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.assets[name].sha256);
      expect(await recoverBrandAsset(name)).toBe(file);
    }
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("uses one initial request and three retries before returning unavailable", async () => {
    const request = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", request);
    expect(await recoverBrandAsset("watermark-16x9.png")).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
    expect(await fsp.readdir(state.root)).toEqual([]);
  });

  it("rejects incorrect or oversized bytes and never installs them", async () => {
    const name = "watermark-16x9.png";
    const wrong = Buffer.alloc(manifest.assets[name].bytes + 1, 42);
    const request = vi.fn(async () => new Response(wrong));
    vi.stubGlobal("fetch", request);
    expect(await recoverBrandAsset(name)).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
    expect(await fsp.readdir(state.root)).toEqual([]);
  });

  it("rejects same-size corruption and repairs a corrupted cache from verified backend bytes", async () => {
    const name = "watermark-16x9.png";
    const good = await fsp.readFile(path.join(assets, name));
    const request = vi.fn(async () => new Response(Buffer.alloc(good.length, 42)));
    vi.stubGlobal("fetch", request);
    expect(await recoverBrandAsset(name)).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
    request.mockImplementation(async () => new Response(good));
    const file = await recoverBrandAsset(name);
    expect(file).not.toBeNull();
    await fsp.writeFile(file!, Buffer.alloc(good.length, 42));
    expect(await recoverBrandAsset(name)).toBe(file);
    expect((await fsp.readFile(file!)).equals(good)).toBe(true);
  });

  it("refuses out-of-catalog names without network or filesystem effects", async () => {
    const request = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", request);
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 256 }), async (name) => {
        if (!Object.hasOwn(manifest.assets, name)) expect(await recoverBrandAsset(name)).toBeNull();
      }),
      { numRuns: 100 },
    );
    for (const name of [
      "../app.py",
      "..\\watermark-16x9.png",
      "C:/assets/endcard-1x1.mp4",
      "__proto__",
      "manifest.json",
    ])
      expect(await recoverBrandAsset(name)).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(await fsp.readdir(state.root)).toEqual([]);
  });

  it("coalesces concurrent recovery and cleans failed atomic publication", async () => {
    const request = vi.fn(
      async (url: string) =>
        new Response(await fsp.readFile(path.join(assets, url.split("/").at(-1)!))),
    );
    vi.stubGlobal("fetch", request);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => recoverBrandAsset("watermark-1x1.png")),
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    state.failRename = true;
    expect(await recoverBrandAsset("watermark-9x16.png")).toBeNull();
    const files = await fsp.readdir(path.dirname(results[0]!));
    expect(files).toEqual(["watermark-1x1.png"]);
  });

  it("never publishes a late response from a request that ignored abort", async () => {
    const bytes = await fsp.readFile(path.join(assets, "endcard-1x1.mp4"));
    vi.useFakeTimers();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const replies: Array<(response: Response) => void> = [];
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          replies.push(resolve);
          entered();
        }),
    );
    vi.stubGlobal("fetch", request);
    const pending = recoverBrandAsset("endcard-1x1.mp4");
    await started;
    await vi.advanceTimersByTimeAsync(13000);
    expect(await pending).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
    for (const reply of replies) reply(new Response(bytes));
    await vi.advanceTimersByTimeAsync(1);
    expect(await fsp.readdir(state.root)).toEqual([]);
  });
});
