// A damaged library.json must never lead the app to delete media the person owns.
//
// The close-time sweep (mediaGc.ts) deletes owned files in library/ that nothing persisted names, and
// it is built to fail closed: a catalog that is there but cannot be read stops it. But the open sets a
// damaged catalog aside first (readJsonOrRecover, when the opened project's catalog is checked), so by
// the close there is no catalog at all, which the sweep reads as "nothing in the library". Media the
// person imported or generated and has not placed on the timeline is then only named by the catalog
// that was set aside, and goes.
//
// The project is today's golden (__fixtures__/goldenProjects/0.29.1, written by 0.29.1's own code), with
// one more file imported through the app's own door and not placed. The open and the close run the
// steps project/documentRegistry.ts runs on a project's files, in its order.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureStarterTimeline } from "../timeline/engine";
import { ProjectDisk } from "../test/projectDisk";
import { reconcilePendingMedia, registerLibraryClip } from "./import";
import { sweepOwnedMedia } from "./mediaGc";
import { INTERNAL_DIR, joinPath, ProjectStoreAccess } from "./store";

const GOLDEN = join(__dirname, "__fixtures__", "goldenProjects", "0.29.1");
const golden = JSON.parse(readFileSync(join(GOLDEN, "golden.json"), "utf8")) as {
  dataFolder: string;
  linkedOutsideProject: string;
  media: Record<string, { id: string }>;
  projects: Array<{ id: string }>;
};
const DATA_ROOT = `C:/Users/golden/AppData/Roaming/${golden.dataFolder}`;
const DIR = `${DATA_ROOT}/projects/${golden.projects[0].id}`;
const CATALOG = joinPath(DIR, INTERNAL_DIR, "library.json");

async function projectWithUnplacedMedia() {
  const d = new ProjectDisk();
  d.mount(join(GOLDEN, "appdata", golden.dataFolder), DATA_ROOT);
  d.put(golden.linkedOutsideProject, "linked footage, not media");
  const store = new ProjectStoreAccess(DIR, d);
  // Imported and not on the timeline yet: a take kept for later, or a generation that landed.
  const entry = await registerLibraryClip(
    store,
    new TextEncoder().encode("the only copy of a clip, not media"),
    "take-2.mp4",
    "video",
  );
  const placed = ["interview.mp4", "broll.mov", "music.mp3", "logo.png"].map((name) =>
    joinPath(DIR, "library", `${golden.media[name].id}${name.slice(name.lastIndexOf("."))}`),
  );
  return { d, store, unplaced: joinPath(DIR, entry.path), placed };
}

/** Open, then close: the editor reads the timeline; the opened project's catalog is checked for
 *  generations that finished while it was closed (recoverGeneratedMedia); at close, owned media no
 *  persisted reference names is collected (the document's dispose). */
async function openThenClose(store: ProjectStoreAccess): Promise<string[]> {
  await ensureStarterTimeline(store);
  try {
    await reconcilePendingMedia(store);
  } catch {
    /* the app shows a notice and goes on */
  }
  return (await sweepOwnedMedia(store)).removed;
}

const cutShort = (b: Uint8Array) => b.slice(0, Math.floor(b.length / 2));

describe("closing a project after opening it", () => {
  it("keeps media that only the library names, while library.json is intact", async () => {
    const { d, store, unplaced, placed } = await projectWithUnplacedMedia();
    expect(await openThenClose(store)).toEqual([]);
    expect(d.bytes(unplaced)).toBeDefined();
    for (const p of placed) expect(d.bytes(p)).toBeDefined();
  });

  it("removes nothing when a damaged library.json is still where it was: the sweep fails closed", async () => {
    const { d, store, unplaced } = await projectWithUnplacedMedia();
    d.put(CATALOG, cutShort(d.bytes(CATALOG)!));
    expect((await sweepOwnedMedia(store)).removed).toEqual([]);
    expect(d.bytes(unplaced)).toBeDefined();
  });

  it("with library.json damaged, still keeps every file the timeline uses, and sets the catalog aside whole", async () => {
    const { d, store, placed } = await projectWithUnplacedMedia();
    const damaged = cutShort(d.bytes(CATALOG)!);
    d.put(CATALOG, damaged);
    await openThenClose(store);
    for (const p of placed) expect(d.bytes(p), p).toBeDefined();
    expect(d.bytes(CATALOG)).toBeUndefined();
    const aside = [...d.files].filter(([k]) => k.startsWith(`${CATALOG}.corrupt-`));
    expect(aside.map(([, v]) => [...v])).toEqual([[...damaged]]);
  });

  it.fails(
    "BUG: with library.json damaged, does not delete media only the library named (today: the open sets the catalog aside, the close reads 'no catalog' and deletes the file)",
    async () => {
      const { d, store, unplaced } = await projectWithUnplacedMedia();
      d.put(CATALOG, cutShort(d.bytes(CATALOG)!));
      const removed = await openThenClose(store);
      expect(removed).toEqual([]);
      expect(d.bytes(unplaced)).toBeDefined();
    },
  );
});
