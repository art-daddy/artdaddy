// The library catalog's one write. Every writer (import, generation, library_op, relink, copy into
// project) commits here, so every committed change is announced: the editor's offline list, its
// indexer, the preview's resolved URLs and the library panel all re-read on the announcement. Relink
// wrote around it and told nobody, so a relinked file stayed "offline" until the project reopened.
import { INTERNAL_DIR, joinPath, type ProjectStoreAccess } from "./store";

export function libraryCatalogPath(store: ProjectStoreAccess): string {
  return joinPath(store.projectDir, INTERNAL_DIR, "library.json");
}

/** Write the catalog atomically, abandoned (false) once the project's session has ended, and
 *  announce it when it lands. Callers commit inside the project's mutation gate. */
export async function writeLibraryCatalog(
  store: ProjectStoreAccess,
  catalog: unknown,
): Promise<boolean> {
  const committed = await store.writeTextAtomic(
    libraryCatalogPath(store),
    JSON.stringify(catalog, null, 2),
    () => store.sessionLive(),
  );
  if (committed) notifyLibraryChanged();
  return committed;
}

/** Tell the UI the library changed. TRAILING debounce, because the listeners re-list the project
 *  and a folder import registers one asset per file: callers await between assets, so a microtask
 *  would still mean 200 listings for a 200-file import. No-op outside a DOM. */
const LIBRARY_CHANGE_QUIET_MS = 50;
let libraryChangeTimer: ReturnType<typeof setTimeout> | null = null;
export function notifyLibraryChanged(): void {
  if (typeof window === "undefined") return;
  if (libraryChangeTimer) clearTimeout(libraryChangeTimer);
  libraryChangeTimer = setTimeout(() => {
    libraryChangeTimer = null;
    try {
      window.dispatchEvent(new CustomEvent("artdaddy:files-changed"));
    } catch {
      /* non-DOM env (tests) */
    }
  }, LIBRARY_CHANGE_QUIET_MS);
}
