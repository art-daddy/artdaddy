// Deferred media garbage collection (Phase 7.2): a cascade delete keeps a used item's OWNED bytes so
// an in-session Undo can restore it. Those bytes become collectable only once NO reference can bring
// them back. This runs at project CLOSE, when the in-memory undo/redo stacks are discarded — so the
// ONLY things that can still restore a reference are PERSISTED: the catalog, the current timeline, and
// any chat checkpoint. A file is kept if its content-hash id appears in ANY of those; everything else
// under `library/` is a safe orphan. Purely disk-based + conservative (it never removes a file whose id
// is referenced anywhere). EXTERNAL (referenced-in-place) media lives outside `library/` and is never
// touched here — ArtDaddy never deletes a user's own file (invariant 28/31).
import { INTERNAL_DIR, joinPath, type LibraryClip, type ProjectStoreAccess } from "./store";
import { proxyKey } from "../preview/proxyPaths";
import { captureError } from "../observability/sentry";

/** Add every clip `media_ref` string in a timeline-shaped value to `into`. Tolerant of `unknown`
 *  (chat checkpoints are typed loosely) + malformed shapes — a bad snapshot just contributes nothing. */
function collectRefs(tl: unknown, into: Set<string>): void {
  const tracks = (tl as { tracks?: unknown } | null | undefined)?.tracks;
  if (!Array.isArray(tracks)) return;
  for (const tr of tracks) {
    const clips = (tr as { clips?: unknown })?.clips;
    if (!Array.isArray(clips)) continue;
    for (const cl of clips) {
      const ref = (cl as { media_ref?: unknown })?.media_ref;
      if (typeof ref === "string" && ref) into.add(ref);
    }
  }
}

/** Collect every media_ref from the THREE authoritative reference sources — the catalog, the current
 *  on-disk timeline, and every chat checkpoint (before/after). Distinguishes a genuinely-ABSENT source
 *  (a fresh project has no timeline/transcript — proceed, it pins nothing) from a source that EXISTS
 *  but is corrupt/unreadable (THROW — the caller fails the sweep closed). This is the exact distinction
 *  the earlier `readJson`-with-fallback lost: it parsed corrupt to empty, so a torn catalog looked like
 *  "no references" and its media got deleted. Raw read + `exists()` classification, never a parse-to-empty. */
async function collectAuthoritativeRefs(
  store: ProjectStoreAccess,
  refs: Set<string>,
): Promise<void> {
  const catText = await readIfPresent(
    store,
    joinPath(store.projectDir, INTERNAL_DIR, "library.json"),
  );
  if (catText !== null) {
    const cat = JSON.parse(catText) as { clips?: LibraryClip[] };
    for (const c of cat.clips ?? []) if (typeof c.path === "string") refs.add(c.path);
  }
  const tlText = await readIfPresent(
    store,
    joinPath(store.projectDir, INTERNAL_DIR, "timeline.json"),
  );
  if (tlText !== null) collectRefs(JSON.parse(tlText), refs);
  const trText = await readIfPresent(
    store,
    joinPath(store.projectDir, INTERNAL_DIR, "transcript.json"),
  );
  if (trText !== null) {
    const session = JSON.parse(trText) as {
      requests?: Array<{ checkpoint?: { timeline?: unknown; timeline_after?: unknown } }>;
    };
    for (const req of session.requests ?? []) {
      collectRefs(req.checkpoint?.timeline, refs);
      collectRefs(req.checkpoint?.timeline_after, refs);
    }
  }
}

/** Read a file's text, or return null if it is genuinely ABSENT. Throws if the file EXISTS but cannot
 *  be read (permissions / IO / it's a directory) — a real read failure the GC must treat as fail-closed,
 *  NOT as "empty". The `exists()` re-check after a read error is what separates absent from corrupt. */
async function readIfPresent(store: ProjectStoreAccess, path: string): Promise<string | null> {
  try {
    return await store.readText(path);
  } catch (e) {
    if (await store.exists(path)) throw e; // exists but unreadable -> corrupt/unreadable -> fail closed
    return null; // truly absent -> a legitimate empty source
  }
}

/** Close-time GC of ORPHANED owned media. Removes `library/<id><ext>` files that no PERSISTED
 *  reference — the catalog, the current on-disk timeline, or any chat checkpoint (before/after) —
 *  can restore. Best-effort: individual removals swallow errors, and a missing library dir / fs
 *  without directory listing is a no-op. Returns the file names removed (for logging/tests). */
export async function sweepOwnedMedia(store: ProjectStoreAccess): Promise<{ removed: string[] }> {
  if (!store.canRescanLibrary) return { removed: [] }; // needs readDir + readBytes
  const libDir = joinPath(store.projectDir, "library");
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = await store.readDir(libDir);
  } catch {
    return { removed: [] }; // no library dir yet
  }
  if (!entries.length) return { removed: [] };

  // Every PERSISTED reference, joined into one blob so a content-hash id substring-match keeps its
  // file. Over-keeping (a coincidental id match) is harmless; under-keeping would delete live media.
  const refs = new Set<string>();
  try {
    await collectAuthoritativeRefs(store, refs);
  } catch (e) {
    // FAIL-CLOSED (blocker 2 / owner Q4): an authoritative reference source EXISTS but is corrupt or
    // unreadable, so we CANNOT prove any owned file is an orphan — remove NOTHING and surface it. A
    // silent "parsed to empty" fallback is exactly what let the earlier GC delete recoverable media.
    // Genuinely-absent sources (a fresh project with no timeline/transcript) are NOT errors and never
    // reach here — they simply contribute no refs.
    captureError(e, { scope: "project.gc.sweep", projectDir: store.projectDir });
    return { removed: [] };
  }
  const blob = [...refs].join("\n");

  const removed: string[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const id = e.name.replace(/\.[a-z0-9]+$/i, ""); // a library file is `<id><ext>`; the id is `media_<hash>`
    if (!id.startsWith("media_") || blob.includes(id)) continue; // non-owned, or still referenced -> keep
    await store.remove(joinPath(libDir, e.name)).catch(() => undefined);
    removed.push(e.name);
  }
  return { removed };
}

// ── Artifact cache GC ────────────────────────────────────────────────────────
// `internals/cache/` had no sweep at all, so every derived byte a session ever wrote —
// gemini encodes, downloads, inspect frames, research screenshots, whisper scratch wavs —
// lived until the project was deleted. Only `library/` was ever collected.

/** Cache subdirectories that are NOT throwaway, keyed by the class of thing they hold. */
const CACHE_KEEP_ALWAYS = new Set([
  "exports", // a user DELIVERABLE (the Downloads fallback), not a cache — never ours to delete
  "transcripts", // small JSON, but each one costs a whisper run to rebuild
]);

/** Derived from ONE library asset and expensive to rebuild: kept while that asset is
 *  live, collected once it isn't. Their filenames embed the asset's id or source hash. */
const CACHE_ASSET_DERIVED = new Set(["proxies", "posters", "thumbnails"]);

/** Directories holding a bulk intermediate AND an expensive result, where the split is by
 *  extension. `transcribe/` is runWhisper's own cache: a 16 kHz WAV that ffmpeg rebuilds in
 *  seconds — and at 18-106 MB is most of what this GC exists to reclaim — sitting beside the
 *  whisper JSON, which costs a whisper RUN. That is the same reason `transcripts/` is kept
 *  outright; sweeping the whole directory kept the bytes that are cheap to make and threw
 *  away the ones that are not, and left runWhisper's "a full transcript answers every window"
 *  short-circuit with nothing to find after a close. */
const CACHE_KEEP_JSON = new Set(["transcribe"]);

/** Every key that identifies a LIVE asset in a derived artifact's filename: the media id
 *  (thumbnails) and the proxy/poster hash of its source (proxies, posters). */
function liveArtifactKeys(clips: LibraryClip[]): string[] {
  const keys: string[] = [];
  for (const c of clips) {
    if (typeof c.id === "string" && c.id) keys.push(c.id);
    if (typeof c.path === "string" && c.path) keys.push(proxyKey(c.path));
  }
  return keys;
}

/** Close-time GC of the derived-artifact cache. Removes regeneratable files under
 *  `internals/cache/` that nothing persisted points at, keeping user deliverables,
 *  transcripts, and the per-asset proxies/posters/thumbnails of media that is still live.
 *  Same fail-closed contract as {@link sweepOwnedMedia}: if an authoritative reference
 *  source exists but can't be read, remove NOTHING. Returns the relative paths removed. */
export async function sweepArtifactCache(
  store: ProjectStoreAccess,
): Promise<{ removed: string[] }> {
  if (!store.canRescanLibrary) return { removed: [] }; // needs readDir
  const cacheDir = joinPath(store.projectDir, INTERNAL_DIR, "cache");
  let subs: { name: string; isDirectory: boolean }[];
  try {
    subs = await store.readDir(cacheDir);
  } catch {
    return { removed: [] }; // no cache dir yet
  }
  if (!subs.length) return { removed: [] };

  const refs = new Set<string>();
  let clips: LibraryClip[] = [];
  try {
    await collectAuthoritativeRefs(store, refs);
    clips = await store.listClips();
  } catch (e) {
    // A reference source EXISTS but is corrupt/unreadable -> we cannot prove anything is an
    // orphan. Removing on a torn catalog is exactly how a GC eats live data.
    captureError(e, { scope: "project.gc.cache", projectDir: store.projectDir });
    return { removed: [] };
  }
  const refBlob = [...refs].join("\n");
  const liveKeys = liveArtifactKeys(clips);

  const removed: string[] = [];
  for (const sub of subs) {
    if (!sub.isDirectory) continue; // stray top-level file: leave it, we didn't put it there
    if (CACHE_KEEP_ALWAYS.has(sub.name)) continue;
    const assetDerived = CACHE_ASSET_DERIVED.has(sub.name);
    const keepJson = CACHE_KEEP_JSON.has(sub.name);
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = await store.readDir(joinPath(cacheDir, sub.name));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory) continue; // one level deep; nested trees are left alone
      const rel = `${sub.name}/${e.name}`;
      if (refBlob.includes(e.name)) continue; // a checkpoint/timeline/catalog can still reach it
      if (keepJson && e.name.toLowerCase().endsWith(".json")) continue; // costs a whisper run
      if (assetDerived && liveKeys.some((k) => e.name.includes(k))) continue; // still-live asset
      await store.remove(joinPath(cacheDir, rel)).catch(() => undefined);
      removed.push(rel);
    }
  }
  return { removed };
}
