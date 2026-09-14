// library_op (client tool): read/write the per-project asset library — the
// catalog of every clip/image/audio in the project (`internals/library.json`) plus
// the folders/tags/notes the agent assigns. A faithful TS port of the server
// `Library` (src/akaru/library.py): the catalog is canonical, folders are
// pure metadata path-strings, ids are content hashes (`media_<sha256[:12]>`), and
// `delete` refuses to remove a clip still referenced by the timeline unless
// forced. Runs entirely on the desktop client against the co-located project dir.
import type { ClientToolContext } from "./context";
import { isMutationRejected, runProjectMutation } from "./coordinator";
import type { ClientToolRegistry } from "./registry";
import {
  INTERNAL_DIR,
  clipAbs,
  joinPath,
  type LibraryClip,
  type ProjectStoreAccess,
} from "./store";
import {
  applyTaggedInGate,
  loadTimeline,
  overwriteTimeline,
  revertTaggedInGate,
  type Mutate,
} from "../timeline/engine";
import type { Timeline } from "../timeline/model";
import type { ProjectDocument } from "../project/ProjectDocument";
import { VIDEO_EXTS } from "../media/formats";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

const VIDEO_EXT = new Set(VIDEO_EXTS.map((e) => `.${e}`));

interface Catalog {
  version: number;
  clips: LibraryClip[];
  folders: string[];
}

// ── helpers ─────────────────────────────────────────────────────────

function extOf(name: string): string {
  const m = /\.[a-z0-9]+$/i.exec(name.replace(/\\/g, "/"));
  return m ? m[0].toLowerCase() : "";
}

/** Clean a folder path: trim, normalize backslashes, collapse repeated slashes,
 *  drop leading/trailing slash. Empty / undefined → "" (root). */
function normalizeFolder(folder: unknown): string {
  if (folder === null || folder === undefined) return "";
  let s = String(folder)
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  while (s.includes("//")) s = s.replace(/\/\//g, "/");
  return s;
}

/** "a/b/c" → ["a", "a/b", "a/b/c"]. Empty → []. */
function folderAncestors(folder: string): string[] {
  const f = normalizeFolder(folder);
  if (!f) return [];
  const parts = f.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

function catalogPath(store: ProjectStoreAccess): string {
  return joinPath(store.projectDir, INTERNAL_DIR, "library.json");
}

async function readCatalog(store: ProjectStoreAccess): Promise<Catalog> {
  const data = await store.readJson<Partial<Catalog>>(catalogPath(store), {});
  return {
    version: data.version ?? 1,
    clips: Array.isArray(data.clips) ? data.clips : [],
    folders: Array.isArray(data.folders) ? data.folders : [],
  };
}

async function writeCatalog(store: ProjectStoreAccess, cat: Catalog): Promise<void> {
  // Honor session liveness (the post-eviction belt): a catalog write for a closed/superseded session is
  // ABANDONED, never torn, so a stale store (a zombie op past the close drain window) can't publish into
  // a project the user left. Inside a gate lease sessionLive is always true, so this only bites the
  // no-document fallback + bare-store cascade paths — the SAME guard saveTimeline uses for timeline.json.
  await store.writeTextAtomic(catalogPath(store), JSON.stringify(cat, null, 2), () =>
    store.sessionLive(),
  );
}

/** Cascade delete (Phase 7): removing a library item ALSO removes every clip that uses it, across the
 *  timeline, as ONE undo entry (parity with established NLEs — no force gate). When a project is OPEN the clip
 *  removal + the catalog-item removal are coupled through a composite undo slot: undo restores BOTH,
 *  redo re-removes BOTH. Owned bytes are KEPT (deferred GC) so the undo has something to restore — the
 *  close sweep collects them only once no undo/redo/checkpoint can reference them. A bare store (no
 *  open document) cascades on disk without undo. EXTERNAL (referenced-in-place) media is NEVER
 *  physically deleted — only unlinked. */
async function cascadeDelete(
  store: ProjectStoreAccess,
  doc: ProjectDocument | null,
  args: Args,
): Promise<Result> {
  const cat = await readCatalog(store);
  const id = String(args.id ?? "").trim();
  const row = cat.clips.find((c) => c.id === id);
  if (!row) return { ok: false, error: `delete: unknown clip id ${id}` };
  const external = row.external === true;

  // The current timeline (loadTimeline = the open document's in-memory authority when open+edited,
  // else disk) + every media_ref that resolves to this item (its raw path + any ref resolving to the
  // same absolute file, so both stored forms match).
  let timeline: Timeline | null = null;
  try {
    timeline = await loadTimeline(store);
  } catch {
    timeline = null;
  }
  const matchRefs = new Set<string>([row.path]);
  const targetAbs = await store.resolveRef(row.path);
  if (timeline) {
    for (const tr of timeline.tracks ?? []) {
      for (const cl of tr.clips ?? []) {
        const src = cl.media_ref;
        if (typeof src !== "string" || !src || matchRefs.has(src)) continue;
        const abs = await store.resolveRef(src);
        if (abs && targetAbs && abs === targetAbs) matchRefs.add(src);
      }
    }
  }
  const isUsing = (c: { media_ref?: unknown }): boolean =>
    typeof c.media_ref === "string" && matchRefs.has(c.media_ref);
  let usingClips = 0;
  if (timeline)
    for (const tr of timeline.tracks ?? [])
      for (const cl of tr.clips ?? []) if (isUsing(cl)) usingClips++;

  const removeUsing: Mutate = (t) => {
    for (const tr of t.tracks ?? []) if (tr.clips) tr.clips = tr.clips.filter((c) => !isUsing(c));
  };
  const thumb = joinPath(store.projectDir, INTERNAL_DIR, "cache", "thumbnails", `${id}.jpg`);
  const dropRow = (): void => {
    cat.clips = cat.clips.filter((c) => c.id !== id);
  };

  if (usingClips > 0 && doc) {
    // COMPOSITE cascade: remove using clips (a tagged undo slot) + the catalog item as ONE undo entry.
    // Owned bytes are KEPT so undo can restore; external is never touched.
    const tag = `libdel:${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const applied = await applyTaggedInGate(store, doc, "library.delete", removeUsing, tag);
    if (!applied.ok)
      return { ok: false, error: `delete: could not remove using clips — ${applied.error}` };
    // The timeline half is applied (a tagged undo slot). Publish the catalog half; if it FAILS, cleanly
    // REVERT the timeline (discard the tagged slot, no phantom redo entry) so the tool's {ok:false} is
    // truthful — neither half changed (blocker 3). Crash-level two-file atomicity (a process death
    // BETWEEN the timeline persist and the catalog write) stays deferred (IDEA-CLIENT-PERSIST-001).
    try {
      dropRow();
      await writeCatalog(store, cat);
    } catch (e) {
      revertTaggedInGate(store, doc, tag);
      return {
        ok: false,
        error: `delete: could not update the library catalog (${String(e)}) — no changes were made`,
      };
    }
    await store.remove(thumb).catch(() => undefined);
    const restoreRow: LibraryClip = { ...row };
    doc.registerComposite(tag, {
      onUndo: async () => {
        const c = await readCatalog(store);
        if (!c.clips.some((x) => x.id === id)) {
          c.clips.push(restoreRow);
          await writeCatalog(store, c);
        }
      },
      onRedo: async () => {
        const c = await readCatalog(store);
        c.clips = c.clips.filter((x) => x.id !== id);
        await writeCatalog(store, c);
      },
    });
    return {
      ok: true,
      id,
      removed_clips: usingClips,
      removed_file: null,
      unlinked_external: external,
      undoable: true,
    };
  }

  // Bare store WITH references (no session/undo): cascade on disk so no dangling ref survives.
  if (usingClips > 0 && timeline) {
    removeUsing(timeline);
    await overwriteTimeline(store, timeline);
  }

  // Unused item (or the bare-store cascade above): remove the catalog row + owned bytes eagerly —
  // nothing is left to restore. External unlinks only (its source file is the user's, never deleted).
  const removedFile = external ? null : joinPath(store.projectDir, row.path);
  if (removedFile) await store.remove(removedFile).catch(() => undefined);
  await store.remove(thumb).catch(() => undefined);
  dropRow();
  await writeCatalog(store, cat);
  return {
    ok: true,
    id,
    removed_clips: usingClips,
    removed_file: removedFile,
    unlinked_external: external,
  };
}

function sha256Hex12(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes as BufferSource).then((digest) =>
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 12),
  );
}

function listClips(cat: Catalog, folderArg: unknown, recursive: boolean): LibraryClip[] {
  if (folderArg === null || folderArg === undefined) return cat.clips;
  const folder = normalizeFolder(folderArg);
  if (!recursive) return cat.clips.filter((c) => normalizeFolder(c.folder) === folder);
  if (!folder) return cat.clips;
  const prefix = `${folder}/`;
  return cat.clips.filter((c) => {
    const f = normalizeFolder(c.folder);
    return f === folder || f.startsWith(prefix);
  });
}

// ── op dispatch ─────────────────────────────────────────────────────

async function libraryOp(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const store = ctx.store;
  const action = String(args.action ?? "").trim();
  if (!action) return { ok: false, error: "an 'action' is required" };

  // `add` was REMOVED from the contract (CONTRACT_VERSION 1.2.0): importing media is now the sole
  // job of import_media (source.url / source.bytes / source.path — a local file or directory linked
  // in place). A stale server that still emits `add` (mixed-version skew) is REJECTED here with a
  // redirect rather than silently mutating, so the single-import-door invariant holds client-side too.
  if (action === "add") {
    return {
      ok: false,
      error:
        "library_op 'add' was removed — use import_media to bring media into the library (source.url, source.bytes, or source.path for a local file/directory linked in place).",
    };
  }

  // Read-only actions never write the catalog, so keep them lock-free (an agent
  // `list` shouldn't wait behind a background write).
  const readOnly = action === "list" || action === "get" || action === "resolve";
  if (readOnly) return runLibraryOp(store, args, action);
  // Every catalog WRITE commits through the shared project-mutation executor (runProjectMutation) —
  // the open document's MutationGate, the SAME boundary as timeline edits, so a library change
  // serializes in ONE domain, is rejected when the project is closing / the agent origin was
  // superseded, and advances the revision only on a real change. runLibraryOp does not self-lock, so
  // it nests safely; the lock fallback covers a bare store / the pre-publish window.
  try {
    return await runProjectMutation(
      store.projectDir,
      `library.${action}`,
      async (doc, gctx) => {
        const r = await runLibraryOp(store, args, action, doc);
        if (r.ok) gctx?.markCommitted(); // a real catalog change advances the document revision
        return r;
      },
      { origin: ctx.origin, signal: ctx.signal },
    );
  } catch (e) {
    if (isMutationRejected(e))
      return { ok: false, error: `${action}: not written — the project is closing` };
    throw e;
  }
}

async function runLibraryOp(
  store: ProjectStoreAccess,
  args: Args,
  action: string,
  doc: ProjectDocument | null = null,
): Promise<Result> {
  const cat = await readCatalog(store);
  const findRow = (id: string) => cat.clips.find((c) => c.id === id);
  const addFolders = (folder: string) => {
    if (!folder) return;
    const set = new Set(cat.folders);
    for (const anc of folderAncestors(folder)) set.add(anc);
    cat.folders = [...set].sort();
  };

  switch (action) {
    case "list": {
      const recursive = args.recursive !== false;
      const clips = listClips(cat, args.folder, recursive);
      // Flag EXTERNAL (referenced-in-place) clips whose source file has gone
      // missing, so the UI / model can surface "media offline" instead of a
      // silent failure. Copied clips live in the project and are never offline.
      const annotated = await Promise.all(
        clips.map(async (c) => (c.external ? { ...c, offline: !(await store.exists(c.path)) } : c)),
      );
      return { ok: true, clips: annotated };
    }

    case "get": {
      const id = String(args.id ?? "").trim();
      const clip = findRow(id);
      return clip ? { ok: true, clip } : { ok: false, error: `unknown clip id ${id}` };
    }

    case "update":
    case "move": {
      const id = String(args.id ?? "").trim();
      const row = findRow(id);
      if (!row) return { ok: false, error: `update: unknown clip id ${id}` };
      const filename = action === "move" ? undefined : args.filename;
      const folder = args.folder;
      if (filename !== undefined && filename !== null)
        row.filename = String(filename).trim() || row.filename;
      if (folder !== undefined) {
        row.folder = normalizeFolder(folder);
        addFolders(String(row.folder));
      }
      if (action === "update") {
        if (Array.isArray(args.tags))
          row.tags = args.tags.map((t) => String(t).trim()).filter(Boolean);
        if (args.notes !== undefined && args.notes !== null) row.notes = String(args.notes);
      }
      await writeCatalog(store, cat);
      return { ok: true, clip: row };
    }

    case "delete":
      // Cascade delete (Phase 7): remove the item AND every clip using it as ONE undo entry (other NLEs
      // parity — no force gate). Self-contained (its own catalog read/write + composite undo), so it
      // returns before the shared `cat` above is used for this action.
      return cascadeDelete(store, doc, args);

    case "create_folder": {
      const folder = normalizeFolder(args.folder);
      if (!folder) return { ok: false, error: "create_folder: name is empty" };
      addFolders(folder);
      await writeCatalog(store, cat);
      return { ok: true, folders: cat.folders };
    }

    case "rename_folder": {
      const oldF = normalizeFolder(args.old);
      const newF = normalizeFolder(args.new);
      if (!oldF) return { ok: false, error: "rename_folder: old name is empty" };
      if (!newF) return { ok: false, error: "rename_folder: new name is empty" };
      let moved = 0;
      for (const row of cat.clips) {
        const f = normalizeFolder(row.folder);
        if (f === oldF) {
          row.folder = newF;
          moved++;
        } else if (f.startsWith(`${oldF}/`)) {
          row.folder = newF + f.slice(oldF.length);
          moved++;
        }
      }
      const folders = new Set(cat.folders.filter((f) => f !== oldF && !f.startsWith(`${oldF}/`)));
      for (const anc of folderAncestors(newF)) folders.add(anc);
      for (const row of cat.clips) {
        const f = normalizeFolder(row.folder);
        for (const anc of folderAncestors(f)) folders.add(anc);
      }
      cat.folders = [...folders].sort();
      await writeCatalog(store, cat);
      return { ok: true, old: oldF, new: newF, clips_moved: moved };
    }

    case "delete_folder": {
      const folder = normalizeFolder(args.folder);
      if (!folder) return { ok: false, error: "delete_folder: name is empty" };
      const prefix = `${folder}/`;
      const members = cat.clips.filter((c) => {
        const f = normalizeFolder(c.folder);
        return f === folder || f.startsWith(prefix);
      });
      const force = args.force === true;
      if (members.length && !force) {
        return {
          ok: false,
          error: `delete_folder: ${folder} contains ${members.length} clip(s); move them out first or pass force=true.`,
        };
      }
      const removedIds: string[] = [];
      for (const m of members) {
        // External members unlink only; never touch the user's original file.
        if (!m.external) {
          await store.remove(joinPath(store.projectDir, m.path)).catch(() => undefined);
        }
        await store
          .remove(joinPath(store.projectDir, INTERNAL_DIR, "cache", "thumbnails", `${m.id}.jpg`))
          .catch(() => undefined);
        removedIds.push(m.id);
      }
      const removed = new Set(removedIds);
      cat.clips = cat.clips.filter((c) => !removed.has(c.id));
      cat.folders = cat.folders.filter((f) => f !== folder && !f.startsWith(prefix));
      await writeCatalog(store, cat);
      return { ok: true, folder, removed_clip_ids: removedIds };
    }

    case "rescan": {
      const dir = joinPath(store.projectDir, "library");
      const added: string[] = [];
      const removedDups: string[] = [];
      const existing = new Set(cat.clips.map((c) => c.id));
      if (store.canRescanLibrary) {
        let entries: { name: string; isDirectory: boolean }[] = [];
        try {
          entries = await store.readDir(dir);
        } catch {
          entries = [];
        }
        for (const e of entries) {
          if (e.isDirectory) continue;
          const ext = extOf(e.name);
          if (!VIDEO_EXT.has(ext)) continue;
          let abs = joinPath(dir, e.name);
          let bytes: Uint8Array;
          try {
            bytes = await store.readBytes(abs);
          } catch {
            continue;
          }
          const cid = `media_${await sha256Hex12(bytes)}`;
          const canonical = `${cid}${ext}`;
          if (e.name !== canonical) {
            const canonAbs = joinPath(dir, canonical);
            if (await store.exists(canonAbs)) {
              await store.remove(abs).catch(() => undefined);
              removedDups.push(e.name);
              continue;
            } else if (store.canRename) {
              try {
                await store.rename(abs, canonAbs);
                abs = canonAbs;
              } catch {
                continue;
              }
            } else {
              continue;
            }
          }
          if (existing.has(cid)) continue;
          cat.clips.push({
            id: cid,
            filename: canonical,
            path: `library/${canonical}`,
            kind: "video",
            size_bytes: bytes.length,
            added_by: "rescan",
          });
          existing.add(cid);
          added.push(cid);
        }
      }
      const keep: LibraryClip[] = [];
      const removedRows: string[] = [];
      const offlineExternal: string[] = [];
      for (const row of cat.clips) {
        // Resolve through the external-aware helper: a COPY joins onto the project
        // dir, an EXTERNAL clip keeps its absolute source path.
        const present = !!row.path && (await store.exists(clipAbs(store.projectDir, row)));
        if (row.external) {
          // A referenced-in-place clip is a link, not bytes we own: a missing source
          // means "offline" (drive unplugged), NOT gone. Keep the row + flag it.
          keep.push(row);
          if (!present) offlineExternal.push(row.id);
        } else if (present) {
          keep.push(row);
        } else {
          removedRows.push(row.id); // a genuinely-orphaned copy
        }
      }
      cat.clips = keep;
      await writeCatalog(store, cat);
      return {
        ok: true,
        added,
        removed_catalog_rows: removedRows,
        removed_dup_files: removedDups,
        offline_external: offlineExternal,
      };
    }

    case "resolve": {
      const ref = String(args.id ?? args.id_or_path ?? args.path ?? "").trim();
      if (!ref) return { ok: false, error: "resolve: an id or path is required" };
      if (ref.startsWith("media_")) {
        const row = findRow(ref);
        return row
          ? { ok: true, path: row.path }
          : { ok: false, error: `resolve: unknown library id ${ref}` };
      }
      const abs = await store.resolveRef(ref);
      if (!abs) return { ok: false, error: `resolve: nothing matches ${ref}` };
      return { ok: true, path: store.toRef(abs) };
    }

    default:
      return { ok: false, error: `library_op: unknown action ${action}` };
  }
}

export function registerLibraryTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("library_op", (a) => libraryOp(a, getCtx()));
}
