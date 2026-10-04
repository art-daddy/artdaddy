// An agent-typed ref may only reach media the project already knows.
//
// Found 2026-10-03 (Phase 2): clip_video and crop_image handed the model's `media_ref` to the
// TRUSTED resolver, which resolves any absolute path that exists. So `clip_video` with
// "C:/Users/u/Documents/private.mp4" copied that file into the library, where every other tool
// (inspect_media, video_ask) could then read it and send it to a model. library_op resolve
// answered "does this path exist" for any path. The rule is now enforced where the agent's store
// is built, not per tool.
import { describe, expect, it } from "vitest";

import { agentStoreView, projectKnowsPath } from "./agentStore";
import { joinPath, ProjectStoreAccess, type FsLike } from "./store";

const DIR = "C:/Users/u/projects/p1";
const SECRET = "C:/Users/u/Documents/secret.mp4";
const LINKED = "D:/Footage/interview.mp4";
const LEGACY = "E:/old/legacy.mov";

/** A Windows-like fs: case-insensitive, separator-agnostic, and it records every path it is asked about. */
class RecFs implements FsLike {
  files = new Map<string, string>();
  touched: string[] = [];
  private k(p: string): string {
    return joinPath(p).toLowerCase();
  }
  put(p: string, c = ""): void {
    this.files.set(this.k(p), c);
  }
  async exists(p: string): Promise<boolean> {
    this.touched.push(joinPath(p));
    return this.files.has(this.k(p));
  }
  async readTextFile(p: string): Promise<string> {
    this.touched.push(joinPath(p));
    const v = this.files.get(this.k(p));
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(this.k(p), c);
  }
  async mkdir(): Promise<void> {}
}

function project(opts: { timelineRefs?: string[]; catalog?: string } = {}) {
  const fs = new RecFs();
  for (const p of [
    SECRET,
    LINKED,
    LEGACY,
    joinPath(DIR, "library/media_a.mp4"),
    joinPath(DIR, "internals/cache/inspect/f1.jpg"),
  ])
    fs.put(p);
  fs.put(
    joinPath(DIR, "internals/library.json"),
    opts.catalog ??
      JSON.stringify({
        version: 1,
        folders: [],
        clips: [
          { id: "media_a", path: "library/media_a.mp4", filename: "a.mp4", kind: "video" },
          {
            id: "media_ext",
            path: LINKED,
            external: true,
            filename: "interview.mp4",
            kind: "video",
          },
        ],
      }),
  );
  fs.put(
    joinPath(DIR, "internals/timeline.json"),
    JSON.stringify({
      version: 1,
      canvas: { width: 1920, height: 1080, fps: 30 },
      tracks: [
        {
          id: "v1",
          kind: "video",
          z: 0,
          clips: (opts.timelineRefs ?? []).map((ref, i) => ({
            id: `c${i}`,
            kind: "video",
            media_ref: ref,
            timeline_in: i * 30,
            timeline_out: i * 30 + 30,
            source_in: 0,
            source_out: 30,
          })),
        },
      ],
    }),
  );
  const raw = new ProjectStoreAccess(DIR, fs);
  return { fs, raw, view: agentStoreView(raw) };
}

describe("agentStoreView: refs resolve only to media the project knows", () => {
  it("refuses an absolute path the project does not know, without touching the file", async () => {
    const { fs, raw, view } = project();
    expect(await raw.resolveRef(SECRET)).toBe(SECRET); // the trusted resolver hands it over
    fs.touched = [];
    expect(await view.resolveRef(SECRET)).toBeNull();
    expect(fs.touched.map((p) => p.toLowerCase())).not.toContain(SECRET.toLowerCase());
  });

  it("refuses the same file named with backslashes or another case", async () => {
    const { view } = project();
    expect(await view.resolveRef("C:\\Users\\u\\Documents\\secret.mp4")).toBeNull();
    expect(await view.resolveRef("c:/users/U/documents/SECRET.mp4")).toBeNull();
  });

  it("refuses a `..` escape without asking the fs about it", async () => {
    const { fs, view } = project();
    fs.touched = [];
    expect(await view.resolveRef("library/../../../Documents/secret.mp4")).toBeNull();
    expect(await view.resolveRef(`${DIR}/library/../../../Documents/secret.mp4`)).toBeNull();
    expect(fs.touched.filter((p) => p.includes(".."))).toEqual([]);
  });

  it("refuses a UNC or verbatim path the project does not know", async () => {
    const { view } = project();
    expect(await view.resolveRef("\\\\server\\share\\secret.mp4")).toBeNull();
    expect(await view.resolveRef("\\\\?\\C:\\Users\\u\\Documents\\secret.mp4")).toBeNull();
  });

  it("resolves library ids, filenames and contained paths exactly as the trusted resolver does", async () => {
    const { raw, view } = project();
    for (const ref of [
      "media_a",
      "a.mp4",
      "library/media_a.mp4",
      "internals/cache/inspect/f1.jpg",
      joinPath(DIR, "internals/cache/inspect/f1.jpg"),
    ]) {
      const want = await raw.resolveRef(ref);
      expect(want, ref).not.toBeNull();
      expect(await view.resolveRef(ref), ref).toBe(want);
    }
  });

  it("resolves linked media by id, by filename AND by the absolute path the catalog stores", async () => {
    const { view } = project();
    expect(await view.resolveRef("media_ext")).toBe(LINKED);
    expect(await view.resolveRef("interview.mp4")).toBe(LINKED);
    expect(await view.resolveRef(LINKED)).toBe(LINKED);
    expect(await view.resolveRef("d:\\footage\\INTERVIEW.mp4")).not.toBeNull();
  });

  it("resolves a legacy absolute ref the timeline already holds", async () => {
    const { view } = project({ timelineRefs: [LEGACY] });
    expect(await view.resolveRef(LEGACY)).toBe(LEGACY);
    // ...but not some other file in the same folder.
    const other = project({ timelineRefs: [LEGACY] });
    other.fs.put("E:/old/other.mov");
    expect(await other.view.resolveRef("E:/old/other.mov")).toBeNull();
  });

  it("fails closed when the catalog cannot be read", async () => {
    const { view } = project({ catalog: "{ not json" });
    expect(await view.resolveRef(LINKED)).toBeNull();
    expect(await view.resolveRef(SECRET)).toBeNull();
  });

  it("keeps resolveMediaRef's stricter rule (no absolute path at all)", async () => {
    const { view } = project();
    expect(await view.resolveMediaRef(LINKED)).toBeNull();
    expect(await view.resolveMediaRef("media_ext")).toBe(LINKED);
  });

  it("is the same store underneath: state, identity checks and every other method", async () => {
    const { raw, view } = project();
    expect(view).toBeInstanceOf(ProjectStoreAccess);
    expect(view.projectDir).toBe(raw.projectDir);
    expect(view.sessionLive()).toBe(raw.sessionLive());
    expect(await view.listClips()).toEqual(await raw.listClips());
    expect(await view.toMediaRef(LINKED)).toBe("media_ext");
  });
});

describe("projectKnowsPath", () => {
  it("knows the project folder, the catalog and the timeline, and nothing else", async () => {
    const { raw } = project({ timelineRefs: [LEGACY] });
    expect(await projectKnowsPath(raw, joinPath(DIR, "anything/at/all.mp4"))).toBe(true);
    expect(await projectKnowsPath(raw, LINKED)).toBe(true);
    expect(await projectKnowsPath(raw, LEGACY)).toBe(true);
    expect(await projectKnowsPath(raw, SECRET)).toBe(false);
    // A sibling folder that merely starts with the project's name is not inside it.
    expect(await projectKnowsPath(raw, `${DIR}-evil/x.mp4`)).toBe(false);
    expect(await projectKnowsPath(raw, `${DIR}/../p2/x.mp4`)).toBe(false);
  });
});
