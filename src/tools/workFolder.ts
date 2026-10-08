// The app's work folder: the scratch a long job writes while it runs (whisper's 16 kHz audio and
// its raw output), OUTSIDE every project (4i). A transcription in progress when its project closes
// finishes here and keeps its result in the app cache; nothing it does writes into the project it
// came from, which may be closed, moved or deleted by then.
//
// Each run of the app writes under its own folder, named by its launch. So a launch can remove
// whatever earlier ones left (a crash, a kill, a quit mid-run) and never the files of a job of its
// own that outlived a reload of the page.
import { currentLaunch } from "./launch";
import { joinPath, type FsLike } from "./store";

const roots = new WeakMap<FsLike, Promise<string | null>>();

/** This launch's work folder on `fs`, or null where the filesystem has none (the web build, some
 *  test fakes): then scratch stays in the project, as it did before. */
export function workRoot(fs: FsLike): Promise<string | null> {
  let root = roots.get(fs);
  if (!root) {
    root = (async () => {
      if (!fs.workDir) return null;
      try {
        const dir = await fs.workDir();
        return dir ? joinPath(dir, await currentLaunch()) : null;
      } catch {
        return null;
      }
    })();
    roots.set(fs, root);
  }
  return root;
}

/** The names a launch's folder can have: the app process's launch id, or a page's own (a UUID, or
 *  where there is none, base-36 time and random parts). The work folder is ours alone, but a sweep
 *  deletes whole folders, so it deletes only these. */
const LAUNCH_FOLDER =
  /^(launch-[0-9a-f]+-[0-9a-f]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{8,9}-[0-9a-z]{1,8})$/;

async function desktopFs(): Promise<FsLike | null> {
  if (typeof window === "undefined" || !(window.__TAURI_INTERNALS__ ?? window.__TAURI__)) {
    return null; // no desktop bridge: nothing was written
  }
  try {
    const { TauriFs } = await import("./tauri");
    return new TauriFs();
  } catch {
    return null;
  }
}

/** Remove the folders earlier launches left in the work folder; this launch's is kept. Returns the
 *  folders removed. One that cannot be removed yet (a file in it still open) is left for the next
 *  launch. Never throws. */
export async function sweepWork(given?: FsLike | null): Promise<string[]> {
  const fs = given === undefined ? await desktopFs() : given;
  if (!fs?.workDir || !fs.readDir || !fs.remove) return [];
  try {
    const dir = await fs.workDir();
    const mine = await currentLaunch();
    const removed: string[] = [];
    for (const e of await fs.readDir(dir)) {
      if (!e.isDirectory || e.name === mine || !LAUNCH_FOLDER.test(e.name)) continue;
      const path = joinPath(dir, e.name);
      try {
        await fs.remove(path);
        removed.push(path);
      } catch {
        /* still in use: the next launch tries again */
      }
    }
    return removed;
  } catch {
    return []; // no work folder yet
  }
}
