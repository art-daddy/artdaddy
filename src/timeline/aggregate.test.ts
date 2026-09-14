import { afterEach, describe, expect, it } from "vitest";

import { INTERNAL_DIR, joinPath, ProjectStoreAccess } from "../tools/store";
import { DIR, MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { applyOp, ensureTimeline } from "./engine";
import { emptyTimeline } from "./model";
import { projectAggregate } from "./aggregate";

const TL = (dir: string): string => joinPath(dir, INTERNAL_DIR, "timeline.json");
const LIB = (dir: string): string => joinPath(dir, INTERNAL_DIR, "library.json");
const PJ = (dir: string): string => joinPath(dir, INTERNAL_DIR, "project.json");

// Every test either registers a fresh open document or none; the afterEach flushes + clears the
// injected resolver so a doc-registering test never leaks its in-memory timeline into the next.
afterEach(async () => {
  await resetTestDocuments();
});

describe("projectAggregate — flat consistency bridge", () => {
  it("captures an OPEN document's unsaved in-memory timeline (source=memory), not stale disk", async () => {
    const fs = new MemFs();
    const store = new ProjectStoreAccess(DIR, fs);
    registerTestDocument(DIR);
    await ensureTimeline(store); // disk seeded empty; doc.timeline still null
    await applyOp(store, "add_track", (t) => {
      t.tracks.push({ id: "v", kind: "video", z: 0, clips: [] });
    });
    // Force disk to DIVERGE (autosave lag): a stale, different timeline sits on disk. The bridge must
    // still return the in-memory authority — the same short-circuit get_timeline/inspect/export use.
    fs.files.set(
      TL(DIR),
      JSON.stringify({
        ...emptyTimeline(),
        tracks: [{ id: "STALE", kind: "video", z: 0, clips: [] }],
      }),
    );
    const agg = await projectAggregate(store);
    expect(agg.timelineSource).toBe("memory");
    expect(agg.timeline.tracks.map((t) => t.id)).toEqual(["v"]); // in-memory wins, NOT "STALE"
  });

  it("reads on-disk timeline.json when NO document is open (source=disk)", async () => {
    const fs = new MemFs();
    const store = new ProjectStoreAccess(DIR, fs);
    fs.files.set(
      TL(DIR),
      JSON.stringify({ ...emptyTimeline(), tracks: [{ id: "d", kind: "video", z: 0, clips: [] }] }),
    );
    const agg = await projectAggregate(store);
    expect(agg.timelineSource).toBe("disk");
    expect(agg.timeline.tracks.map((t) => t.id)).toEqual(["d"]);
  });

  it("is TOTAL: an absent disk timeline + no open document degrades to a valid empty timeline (no throw)", async () => {
    const fs = new MemFs();
    const store = new ProjectStoreAccess(DIR, fs);
    const agg = await projectAggregate(store); // nothing on disk, no open document
    expect(agg.timelineSource).toBe("disk");
    expect(agg.timeline.tracks).toEqual([]);
  });

  it("reads the on-disk library catalog + project settings (their disk authority)", async () => {
    const fs = new MemFs();
    const store = new ProjectStoreAccess(DIR, fs);
    fs.files.set(
      LIB(DIR),
      JSON.stringify({
        version: 1,
        clips: [{ id: "media_x", path: "library/x.mp4" }],
        folders: ["f"],
      }),
    );
    fs.files.set(PJ(DIR), JSON.stringify({ name: "My Reel" }));
    const agg = await projectAggregate(store);
    expect((agg.library.clips ?? []).map((c) => c.id)).toEqual(["media_x"]);
    expect(agg.project?.name).toBe("My Reel");
  });

  it("degrades a corrupt library catalog to empty + absent settings to null (no throw)", async () => {
    const fs = new MemFs();
    const store = new ProjectStoreAccess(DIR, fs);
    fs.files.set(LIB(DIR), "{ not valid json");
    const agg = await projectAggregate(store);
    expect(agg.library.clips ?? []).toEqual([]);
    expect(agg.project).toBeNull();
  });
});
