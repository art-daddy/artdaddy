// Where the last export was saved, so the next Save As opens there instead of
// bouncing back to Downloads every time.
//
// macOS gives other NLEs this for free — NSSavePanel remembers the directory per app.
// Tauri's `save()` does not, so on Windows/Linux the preference has to be ours.
import { displayFolder, folderOf, sameFolder } from "../timeline/exportQuestions";

const KEY = "artdaddy.export_dir";

/** The file name at the end of a path. */
const leafOf = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/** Whether a path is on a system that does not tell names apart by case (a drive or a share). */
const caseBlind = (path: string): boolean => /^([A-Za-z]:|[\\/]{2}[^\\/])/.test(path.trim());

/** The path to tell the person a finished export was saved to. What they chose in Save As, the way their system
 *  wrote it, when the export went there. Where it really went when it did not (the question about the room for the
 *  file lets them choose another folder, and a file already in the folder they chose makes the name numbered): the
 *  queue's own record of it, written the way their system writes a path. With nothing chosen (the web build has no
 *  Save As) the place as it was given. Null when neither is known. */
export function savedToPath(
  chosen: string | null | undefined,
  actual: string | null | undefined,
): string | null {
  const picked = chosen?.trim() ? chosen : null;
  const real = actual?.trim() ? actual : null;
  if (!real) return picked;
  if (!picked) return real;
  const lower = caseBlind(picked) || caseBlind(real);
  const sameName = lower
    ? leafOf(picked).toLowerCase() === leafOf(real).toLowerCase()
    : leafOf(picked) === leafOf(real);
  return sameName && sameFolder(folderOf(picked), folderOf(real)) ? picked : displayFolder(real);
}

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
