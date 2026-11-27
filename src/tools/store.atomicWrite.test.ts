// Saving can never leave a half-written project file: whatever fails part-way through a save, the
// file on disk is the old one or the new one, whole.
//
// How the app saves (store.ts atomicWriteText, the one writer behind timeline.json, project.json,
// library.json, the chat and projects.json): the new text goes to a temp file beside the target
// (`timeline.tmp-<random>.json`), then a rename puts it in place (on the desktop, the native
// commit_file: std::fs::rename, which replaces the target in one step). If that rename throws, it
// writes the target itself instead, in place.
//
// The disk here fails the ways a person's does: a write that stops part-way (a full disk, an I/O
// error, the app or the PC going down while it writes), and a rename into place that is refused
// (on Windows, another program holding the file open: a virus scanner, a sync client, the indexer).
// A crash freezes the disk at that instant: nothing after it runs, and the next launch opens what is
// there.
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { cancelWriteRecovery, ensureStarterTimeline, replaceTimeline } from "../timeline/engine";
import { emptyTimeline, type Timeline } from "../timeline/model";
import { ProjectDisk } from "../test/projectDisk";
import { registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { isProjectScratch } from "./tempNames";
import { atomicWriteText, INTERNAL_DIR, joinPath, ProjectStoreAccess } from "./store";

interface Faults {
  /** The save's nth write (1 = its first, whatever file that is) stops after `at` bytes. */
  cutWrite?: { nth: number; at: number };
  /** The rename into place is refused. */
  refuseRename?: boolean;
  /** A stopped write is the app going down: nothing after it reaches the disk. */
  crash?: boolean;
}

class FailingDisk extends ProjectDisk {
  faults: Faults = {};
  frozen = false;
  private writes = 0;
  private gone(): void {
    if (this.frozen) throw new Error("the app is not running");
  }
  private stop(path: string, text: string, at: number): never {
    this.put(path, new TextEncoder().encode(text).slice(0, at));
    if (this.faults.crash) this.frozen = true;
    throw new Error(`EIO: i/o error, write '${path}' (stopped after ${at} bytes)`);
  }
  override async writeTextFile(path: string, text: string): Promise<void> {
    this.gone();
    this.writes += 1;
    const cut = this.faults.cutWrite;
    if (cut && cut.nth === this.writes) this.stop(path, text, cut.at);
    this.put(path, text);
  }
  override async rename(from: string, to: string): Promise<void> {
    this.gone();
    if (this.faults.refuseRename)
      throw new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
    return super.rename(from, to);
  }
  override async remove(path: string): Promise<void> {
    this.gone();
    return super.remove(path);
  }
  override async mkdir(path: string): Promise<void> {
    this.gone();
    return super.mkdir(path);
  }
}

const DIR = "C:/Users/someone/AppData/Roaming/ArtDaddy/projects/save_check_a1b2c3";
const TARGET = joinPath(DIR, INTERNAL_DIR, "timeline.json");
const textAt = (d: ProjectDisk, path: string) => {
  const b = d.bytes(path);
  return b === undefined ? undefined : new TextDecoder().decode(b);
};

/** A project document as the app writes one: pretty-printed JSON with any content. */
const documentText = fc
  .dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 3 }), {
    minKeys: 1,
    maxKeys: 6,
  })
  .map((v) => JSON.stringify(v, null, 2));

/** One failure part-way through a save, placed anywhere in what is being written. */
const oneFailure = (nextLength: number) =>
  fc.oneof(
    fc
      .integer({ min: 0, max: nextLength })
      .chain((at) =>
        fc.constantFrom<Faults>(
          { cutWrite: { nth: 1, at } },
          { cutWrite: { nth: 1, at }, crash: true },
        ),
      ),
    fc.constant<Faults>({ refuseRename: true }),
  );

describe("a save that fails part-way (store.ts atomicWriteText)", () => {
  it("leaves the old file or the new one, whole, after any one failure (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        documentText,
        documentText.chain((next) => fc.tuple(fc.constant(next), oneFailure(next.length))),
        async (old, [next, faults]) => {
          const d = new FailingDisk();
          d.put(TARGET, old);
          d.faults = faults;
          await atomicWriteText(d, TARGET, next).catch(() => undefined);
          expect([old, next]).toContain(textAt(d, TARGET));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a crash part-way through leaves its temp file under a name the next open sweeps as scratch", async () => {
    const d = new FailingDisk();
    d.put(TARGET, '{"old": true}');
    d.faults = { cutWrite: { nth: 1, at: 5 }, crash: true };
    await expect(atomicWriteText(d, TARGET, '{"new": true}')).rejects.toThrow(
      /stopped after 5 bytes/,
    );
    const left = [...d.files.keys()].filter((k) => k !== ProjectDisk.key(TARGET));
    expect(left).toHaveLength(1);
    expect(isProjectScratch("internals", left[0].split("/").pop()!, false)).toBe(true);
    expect(textAt(d, TARGET)).toBe('{"old": true}');
  });

  it.fails(
    "BUG: leaves the old file or the new one when the rename into place is refused and the write that replaces it then stops part-way (today: the file is left cut short)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          documentText,
          documentText.chain((next) =>
            fc.tuple(fc.constant(next), fc.integer({ min: 0, max: next.length - 1 })),
          ),
          async (old, [next, at]) => {
            const d = new FailingDisk();
            d.put(TARGET, old);
            d.faults = { refuseRename: true, cutWrite: { nth: 2, at } };
            await atomicWriteText(d, TARGET, next).catch(() => undefined);
            expect([old, next]).toContain(textAt(d, TARGET));
          },
        ),
      );
    },
  );
});

describe("the timeline's own save, then the next launch", () => {
  afterEach(async () => {
    cancelWriteRecovery(DIR);
    await resetTestDocuments().catch(() => undefined);
  });

  const before: Timeline = {
    ...emptyTimeline(1920, 1080, 30),
    tracks: [
      {
        id: "v1",
        kind: "video",
        z: 0,
        clips: [
          {
            id: "c1",
            media_ref: "media_aaaaaaaaaaaa",
            kind: "video",
            timeline_in: 0,
            timeline_out: 90,
          },
        ],
      },
    ],
  };
  const after: Timeline = {
    ...before,
    tracks: [
      {
        ...before.tracks[0],
        clips: [
          ...before.tracks[0].clips!,
          {
            id: "c2",
            media_ref: "media_bbbbbbbbbbbb",
            kind: "video",
            timeline_in: 90,
            timeline_out: 300,
          },
        ],
      },
    ],
  };

  /** Edit the open project and let the autosave write it while the disk fails as `faults` say;
   *  then launch again on whatever the disk holds and open the project. */
  async function saveThenRelaunch(faults: Faults): Promise<Timeline> {
    const d = new FailingDisk();
    d.put(TARGET, JSON.stringify(before, null, 2));
    const doc = registerTestDocument(DIR);
    const store = new ProjectStoreAccess(DIR, d);
    d.faults = faults;
    expect(await replaceTimeline(store, structuredClone(after))).toBe(true);
    await doc.autosave.flush().catch(() => undefined);
    cancelWriteRecovery(DIR); // the 5 s retry while a folder is unreachable: not this test's subject
    await resetTestDocuments().catch(() => undefined);
    const relaunch = new ProjectDisk();
    for (const [k, v] of d.files) relaunch.put(k, v);
    return ensureStarterTimeline(new ProjectStoreAccess(DIR, relaunch));
  }

  it("with no failure, the next launch opens the new timeline", async () => {
    expect(await saveThenRelaunch({})).toEqual(after);
  });

  it("a crash part-way through writing the temp file: the next launch opens the timeline as last saved", async () => {
    const at = Math.floor(JSON.stringify(after, null, 2).length / 2);
    expect(await saveThenRelaunch({ cutWrite: { nth: 1, at }, crash: true })).toEqual(before);
  });

  it("the rename into place refused, nothing else failing: the next launch opens the new timeline", async () => {
    expect(await saveThenRelaunch({ refuseRename: true })).toEqual(after);
  });

  it.fails(
    "BUG: the rename into place refused and a crash part-way through the write that replaces it: the next launch still opens the project (today: 'Couldn't open this project', the timeline file is cut short)",
    async () => {
      const at = Math.floor(JSON.stringify(after, null, 2).length / 2);
      const opened = await saveThenRelaunch({
        refuseRename: true,
        cutWrite: { nth: 2, at },
        crash: true,
      }).catch((e: unknown) => String(e));
      expect([before, after]).toContainEqual(opened);
    },
  );
});
