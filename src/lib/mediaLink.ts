// Referenced media lives outside the project, so the user can move or delete it at any time.
// Premiere's model: the clip stays, shows as OFFLINE, and one "Link Media" pass relinks a whole
// moved folder — you locate ONE file and the rest are matched by name in the folder you picked.
import { INTERNAL_DIR, joinPath, type LibraryClip, type ProjectStoreAccess } from "../tools/store";

const CATALOG = `${INTERNAL_DIR}/library.json`;

interface Catalog {
  clips?: LibraryClip[];
  [k: string]: unknown;
}

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() || p;
}
function dirName(p: string): string {
  const n = p.replace(/\\/g, "/");
  return n.slice(0, n.lastIndexOf("/")) || n;
}

async function readCatalog(store: ProjectStoreAccess): Promise<Catalog> {
  return store.readJson<Catalog>(joinPath(store.projectDir, CATALOG), { clips: [] });
}

async function writeCatalog(store: ProjectStoreAccess, cat: Catalog): Promise<boolean> {
  return store.writeTextAtomic(
    joinPath(store.projectDir, CATALOG),
    JSON.stringify(cat, null, 2),
    () => store.sessionLive(),
  );
}

/** Referenced clips whose source file is gone. Copied clips live inside the project and
 *  cannot go offline, so they are never reported. */
export async function offlineClips(store: ProjectStoreAccess): Promise<LibraryClip[]> {
  const cat = await readCatalog(store);
  const out: LibraryClip[] = [];
  for (const c of cat.clips ?? []) {
    if (c.external && !(await store.exists(c.path))) out.push(c);
  }
  return out;
}

export interface RelinkResult {
  /** Ids that now point at a file that exists. */
  relinked: string[];
  /** Still offline after the pass. */
  remaining: number;
}

/** Point `mediaId` at `newPath`, then sweep every OTHER offline clip against the folder
 *  `newPath` came from, matching on filename. One dialog fixes a moved folder. */
export async function relinkMedia(
  store: ProjectStoreAccess,
  mediaId: string,
  newPath: string,
): Promise<RelinkResult> {
  const cat = await readCatalog(store);
  const clips = cat.clips ?? [];
  const folder = dirName(newPath);
  const relinked: string[] = [];

  for (const clip of clips) {
    if (!clip.external) continue;
    if (clip.id === mediaId) {
      clip.path = newPath.replace(/\\/g, "/");
      relinked.push(clip.id);
      continue;
    }
    if (await store.exists(clip.path)) continue; // still online, leave it
    // The name the file had when it was imported is the only handle we have on it.
    const candidate = `${folder}/${baseName(String(clip.filename || clip.path))}`;
    if (await store.exists(candidate)) {
      clip.path = candidate;
      relinked.push(clip.id);
    }
  }

  if (!(await writeCatalog(store, cat))) return { relinked: [], remaining: clips.length };

  let remaining = 0;
  for (const c of clips) {
    if (c.external && !(await store.exists(c.path))) remaining += 1;
  }
  return { relinked, remaining };
}

/** Copy a referenced file INTO the project, so the project stops depending on where the
 *  original lives. The id is content-addressed and does not change, so nothing that
 *  points at this media has to be rewritten. */
export async function copyIntoProject(
  store: ProjectStoreAccess,
  mediaId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const cat = await readCatalog(store);
  const clip = (cat.clips ?? []).find((c) => c.id === mediaId);
  if (!clip) return { ok: false, error: `unknown media ${mediaId}` };
  if (!clip.external) return { ok: true, path: clip.path }; // already inside the project
  const src = clip.path;
  if (!(await store.exists(src)))
    return { ok: false, error: `'${baseName(src)}' is offline — relink it before copying it in` };

  const ext = (/\.[a-z0-9]+$/i.exec(baseName(src)) ?? [""])[0].toLowerCase();
  const rel = `library/${clip.id}${ext}`;
  const dest = joinPath(store.projectDir, rel);
  if (!(await store.exists(dest))) await store.copyFile(src, dest);
  clip.path = rel;
  delete clip.external;
  if (!(await writeCatalog(store, cat)))
    return { ok: false, error: "the project closed before the copy was recorded" };
  return { ok: true, path: rel };
}
