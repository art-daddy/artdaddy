import { describe, expect, it } from "vitest";

import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "./store";
import { proxyKey } from "../preview/proxyPaths";
import { sweepArtifactCache, sweepOwnedMedia } from "./mediaGc";

const DIR = "C:/proj";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
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
    const v = this.bytes.get(joinPath(p));
    if (v === undefined) throw new Error("ENOENT");
    return v;
  }
  async writeBytes(p: string, b: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), b);
  }
  async readDir(p: string): Promise<DirEntry[]> {
    const base = joinPath(p).replace(/\/+$/, "");
    const seen = new Map<string, boolean>();
    for (const k of [...this.files.keys(), ...this.bytes.keys()]) {
      if (!k.startsWith(`${base}/`)) continue;
      const rest = k.slice(base.length + 1);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.files.delete(n);
    this.bytes.delete(n);
  }
  async mkdir(): Promise<void> {}
}

interface Seed {
  catalog?: unknown;
  timeline?: unknown;
  session?: unknown;
  libFiles?: string[];
}
function seed(fs: MockFs, s: Seed): void {
  if (s.catalog !== undefined)
    fs.files.set(joinPath(DIR, "internals/library.json"), JSON.stringify(s.catalog));
  if (s.timeline !== undefined)
    fs.files.set(joinPath(DIR, "internals/timeline.json"), JSON.stringify(s.timeline));
  if (s.session !== undefined)
    fs.files.set(joinPath(DIR, "internals/transcript.json"), JSON.stringify(s.session));
  for (const f of s.libFiles ?? [])
    fs.bytes.set(joinPath(DIR, `library/${f}`), new Uint8Array([1]));
}
const has = (fs: MockFs, f: string): Promise<boolean> => fs.exists(joinPath(DIR, `library/${f}`));

describe("sweepOwnedMedia (deferred close-time GC)", () => {
  it("removes an orphaned owned file (no catalog / timeline / checkpoint reference)", async () => {
    const fs = new MockFs();
    seed(fs, {
      catalog: { clips: [] },
      timeline: { tracks: [] },
      libFiles: ["media_orphan1234.mp4"],
    });
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual(["media_orphan1234.mp4"]);
    expect(await has(fs, "media_orphan1234.mp4")).toBe(false);
  });

  it("keeps a cataloged file and removes only the orphan alongside it", async () => {
    const fs = new MockFs();
    seed(fs, {
      catalog: { clips: [{ id: "media_keep0001", path: "library/media_keep0001.mp4" }] },
      timeline: { tracks: [] },
      libFiles: ["media_keep0001.mp4", "media_gone9999.mp4"],
    });
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual(["media_gone9999.mp4"]);
    expect(await has(fs, "media_keep0001.mp4")).toBe(true);
  });

  it("keeps a file the CURRENT timeline references even if the catalog dropped its row", async () => {
    const fs = new MockFs();
    seed(fs, {
      catalog: { clips: [] }, // row gone (e.g. an in-session undo window), but a clip still uses it
      timeline: { tracks: [{ id: "v", clips: [{ media_ref: "library/media_intl0001.mp4" }] }] },
      libFiles: ["media_intl0001.mp4"],
    });
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual([]);
    expect(await has(fs, "media_intl0001.mp4")).toBe(true);
  });

  it("keeps a file referenced ONLY by a chat checkpoint (a restore could bring it back)", async () => {
    const fs = new MockFs();
    seed(fs, {
      catalog: { clips: [] },
      timeline: { tracks: [] },
      // a persisted turn whose BEFORE checkpoint still references the media — a catalog+timeline-only
      // sweep would wrongly delete it, breaking a later checkpoint restore.
      session: {
        requests: [
          {
            id: "t1",
            checkpoint: {
              timeline: { tracks: [{ id: "v", clips: [{ media_ref: "media_ckpt0001" }] }] },
            },
          },
        ],
      },
      libFiles: ["media_ckpt0001.mp4"],
    });
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual([]);
    expect(await has(fs, "media_ckpt0001.mp4")).toBe(true);
  });

  it("never removes a non-content-addressed file (only media_<hash> is GC-eligible)", async () => {
    const fs = new MockFs();
    seed(fs, {
      catalog: { clips: [] },
      timeline: { tracks: [] },
      libFiles: ["notes.txt", "cover.jpg"],
    });
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual([]);
  });

  it("FAILS CLOSED on a CORRUPT catalog — keeps ALL media, removes nothing (blocker 2)", async () => {
    const fs = new MockFs();
    seed(fs, { timeline: { tracks: [] }, libFiles: ["media_recover001.mp4"] });
    // A torn/corrupt library.json (PRESENT but unparseable): the earlier readJson-fallback treated this
    // as an EMPTY catalog and deleted recoverable media. It must now ABORT the whole sweep.
    fs.files.set(joinPath(DIR, "internals/library.json"), "{ corrupt not json");
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual([]);
    expect(await has(fs, "media_recover001.mp4")).toBe(true); // recoverable media preserved, not deleted
  });

  it("FAILS CLOSED on a CORRUPT current timeline — keeps all media", async () => {
    const fs = new MockFs();
    seed(fs, { catalog: { clips: [] }, libFiles: ["media_recover002.mp4"] });
    fs.files.set(joinPath(DIR, "internals/timeline.json"), "]]not json[[");
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual([]);
    expect(await has(fs, "media_recover002.mp4")).toBe(true);
  });

  it("FAILS CLOSED on a CORRUPT chat transcript — keeps all media", async () => {
    const fs = new MockFs();
    seed(fs, {
      catalog: { clips: [] },
      timeline: { tracks: [] },
      libFiles: ["media_recover003.mp4"],
    });
    fs.files.set(joinPath(DIR, "internals/transcript.json"), "{bad");
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual([]);
    expect(await has(fs, "media_recover003.mp4")).toBe(true);
  });

  it("PROCEEDS when timeline + transcript are ABSENT (absent ≠ corrupt) — still collects a true orphan", async () => {
    const fs = new MockFs();
    // Only an empty catalog; no timeline.json / transcript.json at all (a legitimately fresh project).
    // Absent sources must NOT abort the sweep (that is the distinction the owner required, Q4).
    seed(fs, { catalog: { clips: [] }, libFiles: ["media_orphan777.mp4"] });
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual(["media_orphan777.mp4"]);
    expect(await has(fs, "media_orphan777.mp4")).toBe(false);
  });

  it("is a no-op when the filesystem cannot list directories", async () => {
    const fs = new MockFs();
    (fs as unknown as { readDir?: unknown }).readDir = undefined; // no directory-listing capability
    seed(fs, { libFiles: ["media_x000000000.mp4"] });
    const { removed } = await sweepOwnedMedia(new ProjectStoreAccess(DIR, fs));
    expect(removed).toEqual([]);
  });
});

// `internals/cache/` previously had NO sweep: every derived byte a session wrote lived
// until the project was deleted. These test the two directions that matter — it actually
// collects, and it does not eat something that cannot be regenerated.
describe("sweepArtifactCache (close-time derived-artifact GC)", () => {
  const cache = (fs: MockFs, rel: string): void => {
    fs.bytes.set(joinPath(DIR, `internals/cache/${rel}`), new Uint8Array([1]));
  };
  const hasCache = (fs: MockFs, rel: string): Promise<boolean> =>
    fs.exists(joinPath(DIR, `internals/cache/${rel}`));
  const sweep = (fs: MockFs) => sweepArtifactCache(new ProjectStoreAccess(DIR, fs));

  it("collects one-shot artifacts nothing points at", async () => {
    const fs = new MockFs();
    seed(fs, { catalog: { clips: [] }, timeline: { tracks: [] } });
    cache(fs, "gemini/gem_vid_abc.mp4");
    cache(fs, "inspect/tl_30.png");
    cache(fs, "research/shot_deadbeef.png");
    const { removed } = await sweep(fs);
    expect(removed.sort()).toEqual([
      "gemini/gem_vid_abc.mp4",
      "inspect/tl_30.png",
      "research/shot_deadbeef.png",
    ]);
    expect(await hasCache(fs, "gemini/gem_vid_abc.mp4")).toBe(false);
  });

  it("NEVER touches exports (a user deliverable) or transcripts (a whisper run each)", async () => {
    const fs = new MockFs();
    seed(fs, { catalog: { clips: [] }, timeline: { tracks: [] } });
    cache(fs, "exports/my final cut.mp4");
    cache(fs, "transcripts/abc123.json");
    const { removed } = await sweep(fs);
    expect(removed).toEqual([]);
    expect(await hasCache(fs, "exports/my final cut.mp4")).toBe(true);
    expect(await hasCache(fs, "transcripts/abc123.json")).toBe(true);
  });

  // `transcribe/` is runWhisper's cache and holds both classes at once. Sweeping the whole
  // directory kept nothing that was expensive: the WAV is an ffmpeg rebuild away, the JSON is
  // a whisper run. Asserted in BOTH directions in one test, because keeping the JSON is only
  // correct if the 100 MB WAV beside it still goes.
  it("keeps whisper's JSON but still collects the big WAV next to it", async () => {
    const fs = new MockFs();
    seed(fs, { catalog: { clips: [] }, timeline: { tracks: [] } });
    cache(fs, "transcribe/7e596bc14733.wav");
    cache(fs, "transcribe/a2b0e5d209e0.json");
    const { removed } = await sweep(fs);
    expect(removed).toEqual(["transcribe/7e596bc14733.wav"]);
    expect(await hasCache(fs, "transcribe/a2b0e5d209e0.json")).toBe(true);
    expect(await hasCache(fs, "transcribe/7e596bc14733.wav")).toBe(false);
  });

  // The keep is scoped to that directory, not to .json everywhere: a gemini/inspect payload
  // that happens to be JSON is still a one-shot artifact.
  it("does not spare a .json in a directory that has no expensive results", async () => {
    const fs = new MockFs();
    seed(fs, { catalog: { clips: [] }, timeline: { tracks: [] } });
    cache(fs, "gemini/probe.json");
    const { removed } = await sweep(fs);
    expect(removed).toEqual(["gemini/probe.json"]);
  });

  it("keeps a LIVE asset's proxy/poster/thumbnail and drops an orphaned one", async () => {
    const fs = new MockFs();
    seed(fs, {
      catalog: { clips: [{ id: "media_live0001", path: "library/media_live0001.mp4" }] },
      timeline: { tracks: [] },
    });
    const live = proxyKey("library/media_live0001.mp4");
    cache(fs, `proxies/${live}.r3.mp4`);
    cache(fs, `posters/${live}.r1.jpg`);
    cache(fs, "thumbnails/media_live0001.jpg");
    cache(fs, "proxies/ffffffffffff.r3.mp4"); // asset deleted -> nothing can use this
    cache(fs, "thumbnails/media_dead0002.jpg");
    const { removed } = await sweep(fs);
    expect(removed.sort()).toEqual([
      "proxies/ffffffffffff.r3.mp4",
      "thumbnails/media_dead0002.jpg",
    ]);
    expect(await hasCache(fs, `proxies/${live}.r3.mp4`)).toBe(true);
    expect(await hasCache(fs, "thumbnails/media_live0001.jpg")).toBe(true);
  });

  it("keeps an artifact a chat CHECKPOINT still references (get_page html, a rendered cut)", async () => {
    const fs = new MockFs();
    seed(fs, {
      catalog: { clips: [] },
      timeline: { tracks: [] },
      session: {
        requests: [
          { checkpoint: { timeline: { tracks: [{ clips: [{ media_ref: "cuts/keepme.mp4" }] }] } } },
        ],
      },
    });
    cache(fs, "cuts/keepme.mp4");
    cache(fs, "cuts/other.mp4");
    const { removed } = await sweep(fs);
    expect(removed).toEqual(["cuts/other.mp4"]);
    expect(await hasCache(fs, "cuts/keepme.mp4")).toBe(true);
  });

  it("FAILS CLOSED on a corrupt catalog — removes nothing", async () => {
    const fs = new MockFs();
    seed(fs, { timeline: { tracks: [] } });
    fs.files.set(joinPath(DIR, "internals/library.json"), "{bad");
    cache(fs, "gemini/gem_vid_abc.mp4");
    const { removed } = await sweep(fs);
    expect(removed).toEqual([]);
    expect(await hasCache(fs, "gemini/gem_vid_abc.mp4")).toBe(true);
  });

  it("is a no-op with no cache dir, and when the fs cannot list directories", async () => {
    const fs = new MockFs();
    seed(fs, { catalog: { clips: [] }, timeline: { tracks: [] } });
    expect((await sweep(fs)).removed).toEqual([]);
    cache(fs, "gemini/x.mp4");
    (fs as unknown as { readDir?: unknown }).readDir = undefined;
    expect((await sweep(fs)).removed).toEqual([]);
    expect(await hasCache(fs, "gemini/x.mp4")).toBe(true);
  });
});
