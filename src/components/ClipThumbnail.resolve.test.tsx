// The thumbnail a user actually sees, end to end.
//
// ClipThumbnail.test.tsx mocks resolveSourceUrl to return "blob:fake", so it passes whether or
// not resolution works — it cannot fail when thumbnails disappear. This drives the REAL chain
// (resolveRef -> thumbnail -> poster fallback) against the layout a real project has on disk:
// a populated posters/ directory and an EMPTY thumbnails/ one, which is what ships today.
import { describe, expect, it } from "vitest";

import { posterRel } from "../preview/proxyPaths";
import { resolveSourceUrl, setAssetUrlConverter, clearSourceUrlCache } from "../preview/resolve";
import { joinPath, ProjectStoreAccess, type FsLike } from "../tools/store";

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

const DIR = "C:/Users/x/AppData/Roaming/artdaddy/projects/steel_trailer_3";
const ID = "media_07a5d5a521ac";
const LIB_REL = `library/${ID}.mp4`;

function project(): ProjectStoreAccess {
  const fs = new MockFs();
  fs.set(
    joinPath(DIR, "internals", "library.json"),
    JSON.stringify({ clips: [{ id: ID, kind: "video", path: LIB_REL }] }),
  );
  fs.touch(joinPath(DIR, LIB_REL));
  // What a real project looks like: the poster exists, the thumbnail never does.
  fs.touch(joinPath(DIR, posterRel(LIB_REL)));
  return new ProjectStoreAccess(DIR, fs);
}

/** The exact lookup ClipThumbnail performs, minus React. */
async function thumbnailUrlFor(store: ProjectStoreAccess, source: string): Promise<string | null> {
  const resolved = (await store.resolveRef(source)) ?? source;
  const m = /(?:^|[\\/])library[\\/]([^\\/]+)\.[^.\\/]+$/i.exec(resolved);
  const thumb = m ? `internals/cache/thumbnails/${m[1]}.jpg` : null;
  let u = thumb ? await resolveSourceUrl(store, thumb) : null;
  if (!u) u = await resolveSourceUrl(store, posterRel(resolved));
  return u;
}

describe("a library clip's thumbnail", () => {
  it("falls back to the generated poster when no thumbnail was ever written", async () => {
    clearSourceUrlCache();
    setAssetUrlConverter((p) => `asset://${p}`);
    const store = project();

    // Both doors: the timeline passes the bare library id, the library panel the rel path.
    for (const source of [ID, LIB_REL]) {
      const url = await thumbnailUrlFor(store, source);
      expect(url, `no thumbnail resolved for source "${source}"`).toBeTruthy();
      expect(url).toContain("posters");
    }
  });

  it("does NOT hand back the video itself when the thumbnail is missing", async () => {
    clearSourceUrlCache();
    setAssetUrlConverter((p) => `asset://${p}`);
    const store = project();
    // The failure this guards: resolveRef stem-matching answered the library VIDEO for a
    // missing thumbnail path, which is non-null and so suppressed the poster fallback —
    // the <img> then pointed at an mp4 and drew nothing.
    const asThumb = await resolveSourceUrl(store, `internals/cache/thumbnails/${ID}.jpg`);
    expect(asThumb, "a missing thumbnail must resolve to null, not to the source video").toBeNull();
  });
});
