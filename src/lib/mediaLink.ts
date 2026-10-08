// Referenced media lives outside the project, so the user can move or delete it at any time.
// Premiere's model: the clip stays, shows as OFFLINE, and one "Link Media" pass relinks a whole
// moved folder — you locate ONE file and the rest are matched by name in the folder you picked.
// Both writes here commit through the project's mutation gate like every other catalog change.
import { kindOf } from "../media/formats";
import { isMutationRejected, runProjectMutation } from "../tools/coordinator";
import { libraryCatalogPath, writeLibraryCatalog } from "../tools/libraryCatalog";
import type { LibraryClip, ProjectStoreAccess } from "../tools/store";
import { joinPath } from "../tools/store";

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
  return store.readJson<Catalog>(libraryCatalogPath(store), { clips: [] });
}

const CLOSING = "the project is closing, so nothing was changed";

/** The offline media under the playhead, so the stage can say WHY it is black.
 *  Without this a clip whose source walked away is pixel-identical to a gap, and the
 *  only place that says otherwise is a panel the user has to think to open. */
export function offlineUnderPlayhead(
  timeline: {
    tracks?: { clips?: { media_ref?: string; timeline_in: number; timeline_out: number }[] }[];
  } | null,
  frame: number,
  offline: readonly string[] | undefined,
): string[] {
  if (!timeline?.tracks?.length || !offline?.length) return [];
  const gone = new Set(offline);
  const hit: string[] = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips ?? []) {
      const ref = clip.media_ref;
      // Half-open, matching every other span check here: a clip ending at F does not cover F.
      if (!ref || !gone.has(ref) || frame < clip.timeline_in || frame >= clip.timeline_out)
        continue;
      if (!hit.includes(ref)) hit.push(ref);
    }
  }
  return hit;
}

export type RelinkResult =
  | {
      ok: true;
      /** Ids that now point at a file that exists. */
      relinked: string[];
      /** Still offline after the pass. */
      remaining: number;
    }
  | { ok: false; error: string };

/** Point `mediaId` at `newPath`, then sweep every OTHER offline clip against the folder
 *  `newPath` came from, matching on filename. One dialog fixes a moved folder. The picked file must
 *  be there and of the same kind: an audio track pointed at a photo would fail every render. */
export async function relinkMedia(
  store: ProjectStoreAccess,
  mediaId: string,
  newPath: string,
): Promise<RelinkResult> {
  const picked = newPath.replace(/\\/g, "/");
  try {
    return await runProjectMutation(store.projectDir, "library.relink", async (_doc, gctx) => {
      const cat = await readCatalog(store);
      const clips = cat.clips ?? [];
      const target = clips.find((c) => c.id === mediaId && c.external);
      if (!target) return { ok: false, error: `${mediaId} is not linked media` } as const;
      const name = String(target.filename || baseName(target.path));
      if (!(await store.exists(picked)))
        return { ok: false, error: `'${baseName(picked)}' is not there any more` } as const;
      const want = kindOf(name);
      if (want && kindOf(picked) !== want)
        return {
          ok: false,
          error: `'${baseName(picked)}' is not ${want === "audio" || want === "image" ? "an" : "a"} ${want} file, so it cannot stand in for '${name}'.`,
        } as const;

      const relinked: string[] = [];
      const folder = dirName(picked);
      for (const clip of clips) {
        if (clip === target) {
          clip.path = picked;
          relinked.push(clip.id);
          continue;
        }
        if (!(await store.isOffline(clip))) continue; // online, copied in, or not made yet
        // The name the file had when it was imported is the only handle we have on it.
        const candidate = `${folder}/${baseName(String(clip.filename || clip.path))}`;
        if (await store.exists(candidate)) {
          clip.path = candidate;
          relinked.push(clip.id);
        }
      }
      if (!(await writeLibraryCatalog(store, cat))) return { ok: false, error: CLOSING } as const;
      gctx?.markCommitted();
      return { ok: true, relinked, remaining: (await store.libraryOffline()).length } as const;
    });
  } catch (e) {
    if (isMutationRejected(e)) return { ok: false, error: CLOSING };
    throw e;
  }
}

/** Copy a referenced file INTO the project, so the project stops depending on where the
 *  original lives. The id is content-addressed and does not change, so nothing that
 *  points at this media has to be rewritten. The bytes are copied before the catalog's turn at
 *  the gate; refused there, the copy is an unreferenced file the media GC collects. */
export async function copyIntoProject(
  store: ProjectStoreAccess,
  mediaId: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const clip = ((await readCatalog(store)).clips ?? []).find((c) => c.id === mediaId);
  if (!clip) return { ok: false, error: `unknown media ${mediaId}` };
  if (!clip.external) return { ok: true, path: clip.path }; // already inside the project
  const src = clip.path;
  if (await store.isOffline(clip))
    return { ok: false, error: `'${baseName(src)}' is offline — relink it before copying it in` };

  const ext = (/\.[a-z0-9]+$/i.exec(baseName(src)) ?? [""])[0].toLowerCase();
  const rel = `library/${clip.id}${ext}`;
  const dest = joinPath(store.projectDir, rel);
  if (!(await store.exists(dest))) await store.copyFile(src, dest);
  try {
    return await runProjectMutation(store.projectDir, "library.copy_in", async (_doc, gctx) => {
      const cat = await readCatalog(store);
      const row = (cat.clips ?? []).find((c) => c.id === mediaId);
      if (!row) return { ok: false, error: `unknown media ${mediaId}` } as const;
      if (!row.external) return { ok: true, path: row.path } as const;
      if (row.path !== src)
        return {
          ok: false,
          error: `'${baseName(src)}' was relinked meanwhile; copy it again`,
        } as const;
      row.path = rel;
      delete row.external;
      if (!(await writeLibraryCatalog(store, cat))) return { ok: false, error: CLOSING } as const;
      gctx?.markCommitted();
      return { ok: true, path: rel } as const;
    });
  } catch (e) {
    if (isMutationRejected(e)) return { ok: false, error: CLOSING };
    throw e;
  }
}
