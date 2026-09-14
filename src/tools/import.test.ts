import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientToolContext } from "./context";
import {
  failPendingClip,
  finalizePendingClip,
  importMediaTool,
  newPendingMediaId,
  readMediaTool,
  registerLibraryClip,
  registerPendingClip,
} from "./import";
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "./store";
import { ClientToolRegistry } from "./registry";
import { endProjectSession } from "./coordinator";
import { MutationAbortedError, ProjectClosingError } from "../project/MutationGate";
import { registerTestDocument, resetTestDocuments } from "../test/timelineKit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const DIR = "C:/data/projects/p1";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    if (this.files.has(n) || this.bytes.has(n)) return true;
    const prefix = `${n.replace(/\/+$/, "")}/`; // a directory "exists" when it has children
    for (const k of [...this.files.keys(), ...this.bytes.keys()])
      if (k.startsWith(prefix)) return true;
    return false;
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
    const v = this.bytes.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async readDir(p: string): Promise<DirEntry[]> {
    const base = joinPath(p).replace(/\/+$/, "");
    const seen = new Map<string, boolean>(); // name -> isDirectory
    for (const k of [...this.files.keys(), ...this.bytes.keys()]) {
      if (!k.startsWith(`${base}/`)) continue;
      const rest = k.slice(base.length + 1);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async mkdir(): Promise<void> {}
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.files.delete(n);
    this.bytes.delete(n);
  }
}

function ctxWith(fs: MockFs = new MockFs()): ClientToolContext {
  return { store: new ProjectStoreAccess(DIR, fs), runner: { run: vi.fn() } } as Any;
}

afterEach(() => vi.unstubAllGlobals());
afterEach(async () => resetTestDocuments());
beforeEach(() => vi.clearAllMocks());

describe("registerLibraryClip (by reference)", () => {
  it("references an external file in place (no copy) + tags it external", async () => {
    const fs = new MockFs();
    const ABS = "D:/footage/hero.mp4";
    await fs.writeBytes(joinPath(ABS), new Uint8Array([5, 6, 7]));
    const store = new ProjectStoreAccess(DIR, fs);
    const entry = await registerLibraryClip(
      store,
      new Uint8Array([5, 6, 7]),
      "hero.mp4",
      "video",
      undefined,
      ABS,
    );
    expect(entry.path).toBe(ABS);
    // nothing was copied into the project library
    expect(await fs.exists(joinPath(DIR, `library/${entry.id}.mp4`))).toBe(false);
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    const row = cat.clips.find((c: Any) => c.id === entry.id);
    expect(row.external).toBe(true);
    expect(row.path).toBe(ABS);
    expect(row.added_by).toBe("import_reference");
    // the id resolves back to the external file
    expect(await store.resolveRef(entry.id)).toBe(joinPath(ABS));
  });
});

describe("registerLibraryClip (close / session fence — reviewer blocker 1)", () => {
  it("ABANDONS the catalog publish + CLEANS its staged bytes when the session is STALE (post-close belt)", async () => {
    // The reviewer's EXACT repro: a zombie import job whose store was captured BEFORE close (sessionLive
    // now false) landed its catalog write and the clip count went 0->1. With the sessionLive guard on
    // the catalog write, the publish is now abandoned — nothing is written and the staged bytes are
    // cleaned, so the count stays 0.
    const fs = new MockFs();
    const store = new ProjectStoreAccess(DIR, fs);
    endProjectSession(DIR); // the project was CLOSED after this store was captured -> sessionLive() is false
    await expect(
      registerLibraryClip(store, new Uint8Array([1, 2, 3, 4]), "clip.mp4", "video"),
    ).rejects.toBeInstanceOf(ProjectClosingError);
    expect(fs.files.has(joinPath(DIR, "internals/library.json"))).toBe(false); // NOTHING published (count stays 0)
    expect(await fs.readDir(joinPath(DIR, "library")).catch(() => [])).toEqual([]); // staged bytes cleaned, not orphaned
  });

  it("REJECTS a catalog publish whose Stop signal aborted (open document) + cleans its staged bytes", async () => {
    // Full fence: an agent import Stopped mid-flight must not publish. With an OPEN document the gate's
    // signal fence rejects it before the write, and the staged bytes are cleaned.
    const fs = new MockFs();
    registerTestDocument(DIR); // an OPEN document -> its gate enforces the signal fence
    const store = new ProjectStoreAccess(DIR, fs);
    const ac = new AbortController();
    ac.abort();
    await expect(
      registerLibraryClip(
        store,
        new Uint8Array([7, 7, 7, 7]),
        "clip.mp4",
        "video",
        undefined,
        undefined,
        { signal: ac.signal },
      ),
    ).rejects.toBeInstanceOf(MutationAbortedError);
    expect(fs.files.has(joinPath(DIR, "internals/library.json"))).toBe(false); // nothing published
    expect(await fs.readDir(joinPath(DIR, "library")).catch(() => [])).toEqual([]); // staged bytes cleaned
  });
});

describe("registerLibraryClip (renderable-media fence)", () => {
  // A PNG header is enough to state the size; the importer must not need the pixels.
  const png = (w: number, h: number): Uint8Array =>
    new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
      0x49,
      0x48,
      0x44,
      0x52,
      ...[24, 16, 8, 0].map((s) => (w >>> s) & 255),
      ...[24, 16, 8, 0].map((s) => (h >>> s) & 255),
    ]);
  const OVERSIZE = png(6864, 41754); // the real full-page screenshot that hung a render

  it("leaves NOTHING behind when the image is one ffmpeg cannot decode", async () => {
    // The outcome that matters is not the throw: it is that no library file and no catalog row
    // exist afterwards, so the asset can never be placed on a timeline and hang a render.
    const fs = new MockFs();
    registerTestDocument(DIR);
    const store = new ProjectStoreAccess(DIR, fs);
    await expect(registerLibraryClip(store, OVERSIZE, "shot.png", "image")).rejects.toThrow(
      /6864x41754/,
    );
    expect(fs.files.has(joinPath(DIR, "internals/library.json"))).toBe(false);
    expect(await fs.readDir(joinPath(DIR, "library")).catch(() => [])).toEqual([]);
  });

  it("still admits a large-but-decodable image (the fence must not block real work)", async () => {
    const fs = new MockFs();
    registerTestDocument(DIR);
    const store = new ProjectStoreAccess(DIR, fs);
    const entry = await registerLibraryClip(store, png(8000, 8000), "poster.png", "image");
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    expect(cat.clips.map((c: Any) => c.id)).toEqual([entry.id]);
  });

  it("fences a LINKED file too — nothing is copied, so nothing was staged to clean", async () => {
    // Referenced-in-place media skips the byte staging entirely; the fence has to sit before it.
    const fs = new MockFs();
    registerTestDocument(DIR);
    const ABS = "D:/shots/page.png";
    await fs.writeBytes(joinPath(ABS), OVERSIZE);
    const store = new ProjectStoreAccess(DIR, fs);
    await expect(
      registerLibraryClip(store, OVERSIZE, "page.png", "image", undefined, ABS),
    ).rejects.toThrow(/renderer/i);
    expect(fs.files.has(joinPath(DIR, "internals/library.json"))).toBe(false);
  });

  it("surfaces as a readable tool error through import_media, not a thrown turn", async () => {
    // A sibling producer, at the boundary the MODEL sees: it has to learn WHY so it can pick a
    // different asset, and a throw here would kill the turn instead.
    const fs = new MockFs();
    registerTestDocument(DIR);
    const ctx = { store: new ProjectStoreAccess(DIR, fs), runner: { run: vi.fn() } } as Any;
    const registry = new ClientToolRegistry().register("import_media", (a) =>
      importMediaTool(a, ctx),
    );
    const r = (await registry.run("import_media", {
      source: { bytes: btoa(String.fromCharCode(...OVERSIZE)), mimeType: "image/png" },
    })) as Any;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/6864x41754/);
    expect(r.media_ref).toBeUndefined();
  });
});

describe("import_media", () => {
  it("requires url, bytes, or path", async () => {
    expect(((await importMediaTool({}, ctxWith())) as Any).ok).toBe(false);
    expect(((await importMediaTool({ source: {} }, ctxWith())) as Any).ok).toBe(false);
  });

  it("coerces multiple sources to the most concrete (url > bytes) + notes it", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    // A real Response, not a hand-made stub: the download path reads headers and streams the
    // body to enforce the size cap, and an invented shape would hide that.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    // url + bytes: url wins over bytes; the drop is reported in `note`.
    const r = (await importMediaTool(
      { source: { url: "https://ex.com/a.mp4", bytes: btoa("inline") } },
      ctxWith(),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.filename).toBe("a.mp4");
    expect(String(r.note)).toContain("used url");
    expect(String(r.note)).toContain("ignored bytes");
  });

  it("imports base64 bytes with a content-hash id and registers it", async () => {
    const fs = new MockFs();
    const ctx = ctxWith(fs);
    const r = (await importMediaTool(
      { source: { bytes: btoa("hello-mp4"), mimeType: "video/mp4" }, name: "clip.mp4" },
      ctx,
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.media_ref).toMatch(/^media_[0-9a-f]{12}$/);
    expect(r.path).toBeUndefined(); // the model gets a ref, never a path
    expect(r.kind).toBe("video");
    expect(r.existed).toBe(false);
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    const row = cat.clips.find((c: Any) => c.id === r.media_ref);
    expect(row?.path).toBe(`library/${r.media_ref}.mp4`); // the CATALOG still records where it lives
    expect(await fs.exists(joinPath(DIR, row.path))).toBe(true);
    // the returned id resolves back to the on-disk file
    expect(await ctx.store.resolveRef(r.media_ref)).toBe(joinPath(DIR, row.path));
  });

  it("dedups byte-identical imports to one id + one catalog entry", async () => {
    const fs = new MockFs();
    const ctx = ctxWith(fs);
    const source = { bytes: btoa("same-bytes"), mimeType: "image/png" };
    const a = (await importMediaTool({ source }, ctx)) as Any;
    const b = (await importMediaTool({ source }, ctx)) as Any;
    expect(a.media_ref).toBe(b.media_ref);
    expect(a.existed).toBe(false);
    expect(b.existed).toBe(true);
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    expect(cat.clips.filter((c: Any) => c.id === a.media_ref)).toHaveLength(1);
  });

  it("links a local FILE in place via source.path (external media_ref, nothing copied)", async () => {
    const fs = new MockFs();
    const ABS = "D:/footage/hero.mp4";
    await fs.writeBytes(joinPath(ABS), new Uint8Array([5, 6, 7]));
    const ctx = ctxWith(fs);
    const r = (await importMediaTool({ source: { path: ABS } }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
    expect(r.media_ref).toMatch(/^media_[0-9a-f]{12}$/);
    expect(r.path).toBeUndefined(); // linked in place, but the model still only gets a ref
    expect(r.kind).toBe("video");
    // nothing was copied into the project library
    expect(await fs.exists(joinPath(DIR, `library/${r.media_ref}.mp4`))).toBe(false);
    // the id resolves back to the external file
    expect(await ctx.store.resolveRef(r.media_ref)).toBe(joinPath(ABS));
  });

  it("path wins over url/bytes and notes the drop", async () => {
    const fs = new MockFs();
    const ABS = "D:/footage/hero.mp4";
    await fs.writeBytes(joinPath(ABS), new Uint8Array([5, 6, 7]));
    const r = (await importMediaTool(
      { source: { path: ABS, url: "https://ex.com/a.mp4" } },
      ctxWith(fs),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
    expect(String(r.note)).toContain("used path");
    expect(String(r.note)).toContain("ignored url");
  });

  it("links every media file in a DIRECTORY via source.path (batch), skipping non-media", async () => {
    const fs = new MockFs();
    const DIRPATH = "D:/footage/broll";
    await fs.writeBytes(joinPath(`${DIRPATH}/a.mp4`), new Uint8Array([1, 1]));
    await fs.writeBytes(joinPath(`${DIRPATH}/b.png`), new Uint8Array([2, 2]));
    await fs.writeBytes(joinPath(`${DIRPATH}/notes.txt`), new Uint8Array([3, 3])); // non-media: skipped
    const ctx = ctxWith(fs);
    const r = (await importMediaTool({ source: { path: DIRPATH } }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
    expect(r.count).toBe(2);
    expect((r.imported as Any[]).map((e) => e.kind).sort()).toEqual(["image", "video"]);
    for (const e of r.imported as Any[])
      expect(String(e.media_ref)).toMatch(/^media_[0-9a-f]{12}$/);
    // every linked clip is external (no copy into the project)
    const cat = JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json")));
    expect(cat.clips.length).toBe(2);
    expect(cat.clips.every((c: Any) => c.external === true)).toBe(true);
  });

  it("downloads a url via fetch", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    const r = (await importMediaTool(
      { source: { url: "https://ex.com/a.mp4" } },
      ctxWith(),
    )) as Any;
    expect(r.ok).toBe(true);
    expect(r.filename).toBe("a.mp4");
    expect(r.kind).toBe("video");
  });

  it("rejects media whose type can't be inferred", async () => {
    expect(((await importMediaTool({ source: { bytes: btoa("x") } }, ctxWith())) as Any).ok).toBe(
      false,
    );
  });

  // A COPY source has to have a ceiling: the bytes land on the user's disk and in the webview.
  // A referenced local file has none, because we never read it.
  describe("size ceilings", () => {
    it("stops an oversized download MID-TRANSFER instead of after buffering it", async () => {
      // Content-Length is a claim; a lying or absent header must not get past the cap, and the
      // point of streaming is that we stop pulling rather than discover the size at the end.
      let pulled = 0;
      const chunk = new Uint8Array(1024 * 1024);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                pull(c) {
                  pulled += chunk.length;
                  if (pulled > 8 * 1024 * 1024 * 1024)
                    c.close(); // a runaway body
                  else c.enqueue(chunk);
                },
              }),
            ),
        ),
      );
      const r = (await importMediaTool(
        { source: { url: "https://ex.com/huge.mp4" } },
        ctxWith(),
      )) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/5 GB/);
      expect(pulled).toBeLessThan(6 * 1024 * 1024 * 1024); // abandoned, not read to the end
    }, 60_000);

    it("refuses inline base64 over the limit, and says what to use instead", async () => {
      const r = (await importMediaTool(
        { source: { bytes: "A".repeat(16 * 1024 * 1024) }, name: "big.mp4" },
        ctxWith(),
      )) as Any;
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/url or path/);
    });

    it("still accepts a normal-sized inline import (the cap is not blanket)", async () => {
      const r = (await importMediaTool(
        { source: { bytes: btoa("small video bytes") }, name: "ok.mp4" },
        ctxWith(),
      )) as Any;
      expect(r.ok).toBe(true);
    });
  });
});

describe("read_media (gateway<->client bytes bridge)", () => {
  it("resolves a clip ref to its base64 bytes (round-trips import_media)", async () => {
    const fs = new MockFs();
    const ctx = ctxWith(fs);
    const imp = (await importMediaTool(
      { source: { bytes: btoa("PNGDATA"), mimeType: "image/png" }, name: "ref.png" },
      ctx,
    )) as Any;
    expect(imp.ok).toBe(true);
    const r = (await readMediaTool({ ref: imp.media_ref }, ctx)) as Any;
    expect(r.ok).toBe(true);
    expect(r.ext).toBe(".png");
    expect(atob(r.bytes as string)).toBe("PNGDATA");
    expect(r.size_bytes).toBe(7);
  });

  it("errors on an empty or unresolvable ref", async () => {
    expect(((await readMediaTool({}, ctxWith())) as Any).ok).toBe(false);
    expect(((await readMediaTool({ ref: "clip_nope" }, ctxWith())) as Any).ok).toBe(false);
  });
});

describe("pending (still-generating) media", () => {
  const rows = async (fs: MockFs): Promise<Any[]> =>
    JSON.parse(await fs.readTextFile(joinPath(DIR, "internals/library.json"))).clips;
  // A real 1x1 PNG header, so the renderability check sees a decodable image.
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
    1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
  ]);

  it("publishes a placeable row carrying its FUTURE path", async () => {
    const fs = new MockFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const id = newPendingMediaId();

    await registerPendingClip(store, { id, filename: "hero.mp4", kind: "video", duration_s: 5 });

    const [row] = await rows(fs);
    expect(row).toMatchObject({
      id,
      kind: "video",
      status: "generating",
      path: `library/${id}.mp4`,
      duration_s: 5,
    });
  });

  // The load-bearing property: anything the agent placed while it generated points at this id.
  it("finalizes under the SAME id, so clips placed meanwhile still resolve", async () => {
    const fs = new MockFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const id = newPendingMediaId();
    await registerPendingClip(store, { id, filename: "shot.png", kind: "image" });

    const out = await finalizePendingClip(store, id, PNG);

    expect(out.id).toBe(id);
    const [row] = await rows(fs);
    expect(row.id).toBe(id);
    expect(row.status).toBeUndefined();
    expect(row.size_bytes).toBe(PNG.length);
    expect(await fs.exists(joinPath(DIR, `library/${id}.png`))).toBe(true);
    expect(await store.resolveRef(id)).toBe(joinPath(DIR, `library/${id}.png`));
  });

  // The whole reason this belongs in import.ts: an undecodable generated image spins ffmpeg
  // under -loop 1 with no frames and no error, exactly like an imported one.
  it("refuses to finalize an image ffmpeg could not decode", async () => {
    const fs = new MockFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const id = newPendingMediaId();
    await registerPendingClip(store, { id, filename: "huge.png", kind: "image" });
    // A PNG header declaring 60000x60000 — past av_image_check_size2.
    const huge = new Uint8Array(PNG);
    huge.set([0, 0, 0xea, 0x60], 16);
    huge.set([0, 0, 0xea, 0x60], 20);

    await expect(finalizePendingClip(store, id, huge)).rejects.toThrow(/can't be used as media/i);

    expect((await rows(fs))[0].status).toBe("generating");
  });

  it("keeps a failed row so a clip already placed does not vanish", async () => {
    const fs = new MockFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const id = newPendingMediaId();
    await registerPendingClip(store, { id, filename: "a.mp4", kind: "video" });

    await failPendingClip(store, id, "content filter");

    const [row] = await rows(fs);
    expect(row).toMatchObject({ id, status: "failed", error: "content filter" });
  });

  it("refuses to finalize media it never issued", async () => {
    const store = new ProjectStoreAccess(DIR, new MockFs());
    await expect(finalizePendingClip(store, "media_gen_nope", PNG)).rejects.toThrow(/no pending/i);
  });

  it("is idempotent: registering the same placeholder twice leaves one row", async () => {
    const fs = new MockFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const id = newPendingMediaId();

    await registerPendingClip(store, { id, filename: "a.mp4", kind: "video" });
    await registerPendingClip(store, { id, filename: "a.mp4", kind: "video" });

    expect(await rows(fs)).toHaveLength(1);
  });

  it("issues distinct ids — a placeholder cannot be content-addressed", () => {
    expect(newPendingMediaId()).not.toBe(newPendingMediaId());
  });
});

// The library panel refetches on this event and on nothing else. It used to be fired by the two UI
// import paths BY HAND, so an asset added by any agent tool -- import_media, download_video,
// get_page_image, run_ffmpeg, clip_video, every generation -- was written to library.json and then
// stayed invisible in the panel until the project was reopened. Reported as "the MCP import did not
// appear in the library". Asserts the EVENT, not the call site, so it holds for every producer.
describe("registerLibraryClip announces the change", () => {
  const heard = (): { count: () => number; stop: () => void } => {
    let n = 0;
    const on = (): void => {
      n += 1;
    };
    window.addEventListener("artdaddy:files-changed", on);
    return { count: () => n, stop: () => window.removeEventListener("artdaddy:files-changed", on) };
  };
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

  // The event is trailing-debounced on a module-level timer, so a registration from an earlier
  // test in this file can still have one in flight. Let it land before counting, or it is
  // attributed to this test and the count reads 2.
  beforeEach(settle);

  it("fires once the catalog row is committed", async () => {
    const store = new ProjectStoreAccess(DIR, new MockFs());
    const h = heard();
    try {
      await registerLibraryClip(store, new Uint8Array([1, 2, 3]), "a.mp4", "video");
      await settle();
      expect(h.count()).toBe(1);
    } finally {
      h.stop();
    }
  });

  it("does NOT fire when the write was refused", async () => {
    const store = new ProjectStoreAccess(DIR, new MockFs());
    const h = heard();
    try {
      // An image ffmpeg cannot decode: rejected before any bytes are staged, so there is no
      // catalog change to announce. Header only — the fence must not need the pixels.
      const oversize = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0,
        0,
        0,
        13,
        0x49,
        0x48,
        0x44,
        0x52,
        ...[24, 16, 8, 0].map((s) => (6864 >>> s) & 255),
        ...[24, 16, 8, 0].map((s) => (41754 >>> s) & 255),
      ]);
      await expect(registerLibraryClip(store, oversize, "huge.png", "image")).rejects.toThrow();
      await settle();
      expect(h.count()).toBe(0);
    } finally {
      h.stop();
    }
  });

  it("coalesces a batch into a single refetch", async () => {
    const store = new ProjectStoreAccess(DIR, new MockFs());
    const h = heard();
    try {
      // A folder import registers one asset per file, and the listener re-lists the directory.
      for (let i = 0; i < 5; i++)
        await registerLibraryClip(store, new Uint8Array([i, i, i]), `f${i}.mp4`, "video");
      await settle();
      expect(h.count()).toBe(1);
    } finally {
      h.stop();
    }
  });
});
