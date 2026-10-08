// The temp files and scratch folders the app makes inside a project, and the one sweep that clears
// what a writer left behind (4j).
//
// Every writer removes its own temp when it finishes or fails, unless the page dies first: a JSON
// write stops between its temporary file and the rename, a proxy's ffmpeg runs to its end with
// nobody left to rename what it wrote (983 MB in one QA run), a caption run's folder outlives it.
// The close-time GC kept some of these forever (a half-built proxy carries its asset's key, which
// reads as live), never looked at folders, and a crash skips it anyway.
//
// So this runs when a project opens and when it closes, and removes a temp only once:
//  - nothing has written to it for TEMP_STALE_MS, so a writer still running keeps its file;
//  - no job of the app process names it (an export outlives its page and its project's close, and
//    its caption folder with it);
//  - no other machine has the project open (its writers are invisible from here).
// Anything it cannot judge, it keeps.
import { jobSupervisor } from "./jobSupervisor";
import { foreignProjectLock } from "./projectLock";
import { INTERNAL_DIR, joinPath, type ProjectStoreAccess } from "./store";
import { isScratchDirName, isStale, isTempName } from "./tempNames";

/** Every path a job of the app process names (its scratch folder, its partial file), or null when
 *  the jobs cannot be listed. No supervisor (tests, the web build) means no jobs. */
async function pathsJobsHold(): Promise<Set<string> | null> {
  const sup = await jobSupervisor();
  if (!sup) return new Set();
  try {
    const held = new Set<string>();
    for (const job of await sup.list())
      for (const v of Object.values(job.meta ?? {}))
        if (typeof v === "string" && v) held.add(joinPath(v));
    return held;
  } catch {
    return null;
  }
}

/** Remove the temps and scratch folders in the project that nothing can still finish. Returns
 *  what it removed, relative to the project. */
export async function sweepProjectTemps(
  store: ProjectStoreAccess,
  now: () => number = Date.now,
): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  if (await foreignProjectLock(store.fsForProjectRegistry(), store.projectDir)) return { removed };
  const held = await pathsJobsHold();
  if (!held) return { removed };

  const root = joinPath(store.projectDir);
  const list = (dir: string) => store.readDir(dir).catch(() => []);
  const drop = async (path: string): Promise<void> => {
    if (held.has(path)) return;
    const written = await store.writtenAt(path);
    if (written === null || !isStale(written, now())) return;
    // In use (Windows refuses) or no way to remove: it stays, and the next sweep looks again.
    await store.remove(path).catch(() => undefined);
    if (!(await store.exists(path))) removed.push(path.slice(root.length + 1));
  };

  const internals = joinPath(root, INTERNAL_DIR);
  for (const e of await list(internals))
    if (!e.isDirectory && isTempName(e.name)) await drop(joinPath(internals, e.name));
  // Only the app's own names: a file the user put in the library is never ours to judge.
  const library = joinPath(root, "library");
  for (const e of await list(library))
    if (!e.isDirectory && e.name.startsWith("media_") && isTempName(e.name))
      await drop(joinPath(library, e.name));
  const cache = joinPath(internals, "cache");
  for (const sub of await list(cache)) {
    // `exports` holds the user's deliverables when there is no Downloads folder.
    if (!sub.isDirectory || sub.name === "exports") continue;
    const dir = joinPath(cache, sub.name);
    for (const e of await list(dir))
      if (e.isDirectory ? isScratchDirName(e.name) : isTempName(e.name))
        await drop(joinPath(dir, e.name));
  }
  return { removed };
}
