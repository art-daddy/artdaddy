import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";

import { packProject, packProjectToDownloads } from "./pack";
import { PACKAGE_EXT } from "../brand";
import { joinPath, ProjectStoreAccess, type FsLike } from "../tools/store";
import { registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { replaceTimeline } from "./engine";
import { emptyTimeline } from "./model";

const DIR = "C:/data/projects/p1";
const EXT = "D:/footage/hero.mp4";

class MockFs implements FsLike {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  downloads = "C:/Users/x/Downloads";
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
  async mkdir(): Promise<void> {}
  async downloadDir(): Promise<string> {
    return this.downloads;
  }
}

function setup(): { fs: MockFs; store: ProjectStoreAccess } {
  const fs = new MockFs();
  fs.files.set(
    joinPath(DIR, "internals/project.json"),
    JSON.stringify({ name: "My Reel", settings: {} }),
  );
  fs.files.set(
    joinPath(DIR, "internals/timeline.json"),
    JSON.stringify({ units: "frames", tracks: [] }),
  );
  fs.files.set(
    joinPath(DIR, "internals/library.json"),
    JSON.stringify({
      version: 1,
      clips: [
        { id: "media_copy", path: "library/media_copy.mp4", filename: "a.mp4", kind: "video" },
        { id: "media_ext", path: EXT, external: true, filename: "hero.mp4", kind: "video" },
        { id: "media_gone", path: "library/media_gone.mp4", filename: "gone.mp4", kind: "video" },
      ],
      folders: [],
    }),
  );
  fs.bytes.set(joinPath(DIR, "library/media_copy.mp4"), new Uint8Array([1, 2, 3]));
  fs.bytes.set(joinPath(EXT), new Uint8Array([4, 5, 6, 7])); // external source lives outside the project
  // media_gone: no bytes on disk -> missing
  return { fs, store: new ProjectStoreAccess(DIR, fs) };
}

// The in-memory-timeline test registers an open document; flush + clear the injected resolver after
// every test so it never leaks into the bare-store pack tests.
afterEach(async () => {
  await resetTestDocuments();
});

describe("packProject", () => {
  it("collects project + external media, rewrites refs project-relative, reports missing", async () => {
    const { store } = setup();
    const { zip, report, name } = await packProject(store);
    expect(name).toBe("My Reel");
    expect(report.clips).toBe(3);
    expect(report.collected).toBe(1); // the external clip pulled in
    expect(report.missing).toEqual([{ id: "media_gone", path: "library/media_gone.mp4" }]);
    expect(report.bytes).toBe(3 + 4);

    const entries = unzipSync(zip);
    const names = Object.keys(entries);
    expect(names).toContain("internals/project.json");
    expect(names).toContain("internals/timeline.json");
    expect(names).toContain("internals/library.json");
    expect(names).toContain("library/media_copy.mp4");
    expect(names).toContain("library/media_ext.mp4"); // external, collected under a project-relative name
    expect(names).not.toContain("library/media_gone.mp4");

    // library.json rewritten: external flag dropped, path project-relative, missing clip removed.
    const cat = JSON.parse(strFromU8(entries["internals/library.json"]));
    const ext = cat.clips.find((c: { id: string }) => c.id === "media_ext");
    expect(ext.external).toBeUndefined();
    expect(ext.path).toBe("library/media_ext.mp4");
    expect(cat.clips.find((c: { id: string }) => c.id === "media_gone")).toBeUndefined();
    expect(cat.clips).toHaveLength(2);
  });

  it("writes the bundle to the Downloads dir named after the project", async () => {
    const { fs, store } = setup();
    const { path, report } = await packProjectToDownloads(store);
    expect(path).toBe(joinPath("C:/Users/x/Downloads", `My Reel.${PACKAGE_EXT}`));
    expect(fs.bytes.has(joinPath(path))).toBe(true);
    expect(report.collected).toBe(1);
  });

  it("bundles the OPEN document's UNSAVED in-memory timeline, not stale disk", async () => {
    // Failure direction: the project is open with edits ahead of disk (autosave lags). A disk-read
    // pack would ship a STALE timeline.json — the shared bundle would silently lose the user's latest
    // edits. The aggregate reads the in-memory authority, so the bundle matches what the editor shows.
    const { fs, store } = setup(); // disk timeline.json is empty
    registerTestDocument(DIR);
    const placed = await replaceTimeline(new ProjectStoreAccess(DIR, fs), {
      ...emptyTimeline(),
      tracks: [
        {
          id: "v",
          kind: "video",
          z: 0,
          clips: [
            { id: "c1", media_ref: "library/media_copy.mp4", timeline_in: 0, timeline_out: 30 },
          ],
        },
      ],
    });
    expect(placed).toBe(true); // the swap hit the open document's in-memory session
    const { zip } = await packProject(store);
    const packedTl = JSON.parse(strFromU8(unzipSync(zip)["internals/timeline.json"]));
    expect(packedTl.tracks.map((t: { id: string }) => t.id)).toEqual(["v"]); // in-memory captured, not stale disk
  });
});
