// Where the last export was saved, so the next Save As opens there instead of
// bouncing back to Downloads every time.
//
// macOS gives other NLEs this for free — NSSavePanel remembers the directory per app.
// Tauri's `save()` does not, so on Windows/Linux the preference has to be ours.
const KEY = "artdaddy.export_dir";

/** The directory the user last exported into, or null if they never have. */
export function lastExportDir(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null; // storage disabled/full — a missing preference is not an error
  }
}

/** Remember where an export landed. Takes the chosen FILE path and keeps only its
 *  directory, so a caller cannot accidentally store a filename as the folder. */
export function rememberExportDir(filePath: string): void {
  const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (cut <= 0) return; // no directory part — nothing worth remembering
  try {
    localStorage.setItem(KEY, filePath.slice(0, cut));
  } catch {
    /* preference is best-effort */
  }
}
