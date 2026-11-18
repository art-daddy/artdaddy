// HELD OFF, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags `estimate_v2`,
// `pc_check`, both in OFF_IN_THIS_BUILD in `api/exportFlags.ts`), kept for a later release, so do not remove it as unused;
// see docs/EXPORTER_ARCHITECTURE.md, "Deferred Export Speed And Settings Work".
//
// The PC check's files port over the app's own file functions (`TauriFs`, `appCacheRoot`): the speed probe makes one small reference clip in a folder of its own,
// reads its size, renames it into place and removes it. The port is the smallest adapter that gives it `rename` and `size` (the app's file layer reads sizes through `stat`).
import type { PcCheckFiles } from "./pcCheck";

/** What the port needs of a file system: the app's `TauriFs` is one. */
export interface CheckFs {
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean; size: number }>;
}

/** The files port over `fs`, in a folder called `pc-check` inside `root()` (the app's cache). A size is a file's own, or null for anything else (no such file, a folder, a read that failed). */
export function checkFiles(fs: CheckFs, root: () => Promise<string>): PcCheckFiles {
  return {
    dir: async () => `${await root()}/pc-check`,
    mkdir: (path) => fs.mkdir(path),
    remove: (path) => fs.remove(path),
    rename: (from, to) => fs.rename(from, to),
    size: async (path) => {
      try {
        const found = await fs.stat(path);
        return !found.isDirectory && Number.isFinite(found.size) && found.size >= 0
          ? found.size
          : null;
      } catch {
        return null;
      }
    },
  };
}
