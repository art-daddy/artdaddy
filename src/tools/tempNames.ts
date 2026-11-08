// What a file or folder is called while the app is still using it as scratch, and how long one may
// go unwritten before nothing is (4j). One rule for every sweep, the app cache's (appCache.ts) and a
// project's (projectTemps.ts), so a name one of them clears is never one the other keeps forever.

/** A temp nothing has written for this long was left by a writer that died: an atomic write takes
 *  milliseconds, and ffmpeg writes its output for as long as it runs. */
export const TEMP_STALE_MS = 10 * 60 * 1000;

/** Whether a temp last written at `writtenAt` has been quiet long enough that nothing is writing
 *  it any more. */
export function isStale(writtenAt: number, now: number): boolean {
  return now - writtenAt >= TEMP_STALE_MS;
}

/** A file still being written: `<name>.tmp-<random>[.<ext>]` (the atomic writes in store.ts, and
 *  `transcode`) or `<name>.<token>.tmp[.<ext>]` (look frames, whisper's scratch). Nothing finished
 *  is ever named like this. */
export function isTempName(name: string): boolean {
  return /\.tmp(?:-[a-z0-9]+)?(?:\.[a-z0-9]+)?$/i.test(name);
}

/** A scratch folder one run makes and removes when it ends: a caption run's
 *  (`caps-<time>-<random>`, assScratch.ts) and an overview sheet's (`ov_<key>_work`,
 *  storyboard.ts). */
export function isScratchDirName(name: string): boolean {
  return /^caps-[a-z0-9]+-[a-z0-9]+$/i.test(name) || /^ov_[0-9a-f]+_work$/i.test(name);
}

/** Whether the entry `name` directly inside a project's `internals` or `library` folder is the app's
 *  own scratch rather than part of the project. The one rule for it: the sweep that clears what a
 *  dead writer left (projectTemps.ts) and a copy of the project (Duplicate, Save As) both ask here, so
 *  a file the sweep would remove is never one a copy carries. `internals` holds only the app's own
 *  files; `library` holds the user's too, so only the app's own names (`media_…`) are judged there:
 *  dropping one of theirs from a copy would lose their footage. */
export function isProjectScratch(
  folder: "internals" | "library",
  name: string,
  isDirectory: boolean,
): boolean {
  if (isDirectory || !isTempName(name)) return false;
  return folder === "internals" || name.startsWith("media_");
}
