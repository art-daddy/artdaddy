// import_media (client tool): bring external media into the project library and
// return a stable `media_ref` id — the portable handle other tools take, so the
// model never has to pass a filesystem path downstream. Three sources: an HTTPS
// `url` or base64 `bytes` are COPIED into the content-addressed library; a local
// `path` (a file, or a directory of media) is LINKED in place — read-only, never
// copied, deletion/GC never follow it (NLE-style referenced media). The id is
// `media_<sha256(bytes)[:12]>`, matching the backend library so the desktop client
// + server agree on ids (byte-identical media dedups to one entry/file).
import type { ClientToolContext } from "./context";
import type { ClientToolRegistry } from "./registry";
import { INTERNAL_DIR, joinPath, type DirEntry, type ProjectStoreAccess } from "./store";
import { isMutationRejected, runProjectMutation } from "./coordinator";
import { ProjectClosingError, type MutationOrigin } from "../project/MutationGate";
import { encodeVideoForGemini } from "./geminiEncode";
import { undecodableImageReason } from "./imageDims";
import { reportMediaImport } from "../api/appEvents";
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  SUBTITLE_EXTS,
  VIDEO_EXTS,
  type MediaKind,
} from "../media/formats";

type Result = Record<string, unknown>;
type Args = Record<string, unknown>;
const NOT_READY: Result = { ok: false, error: "client tool runtime not ready" };

const VIDEO_EXT = new Set(VIDEO_EXTS.map((e) => `.${e}`));
const IMAGE_EXT = new Set(IMAGE_EXTS.map((e) => `.${e}`));
const AUDIO_EXT = new Set(AUDIO_EXTS.map((e) => `.${e}`));
const SUBTITLE_EXT = new Set(SUBTITLE_EXTS.map((e) => `.${e}`));
const MIME_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/aac": ".aac",
  "audio/mp4": ".m4a",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
};

function extOf(name: string): string {
  const m = /\.[a-z0-9]+$/i.exec(name.replace(/\\/g, "/"));
  return m ? m[0].toLowerCase() : "";
}
function kindOf(ext: string): MediaKind | null {
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (SUBTITLE_EXT.has(ext)) return "subtitle";
  return null;
}
function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

async function sha256Hex12(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

/** Ceilings on the two COPY sources. A referenced local file has no cap — we never read it.
 *  A download is stopped MID-TRANSFER rather than after the fact, so an oversized or
 *  mislabelled URL can't fill the user's disk before we notice. */
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_INLINE_B64_CHARS = 15 * 1024 * 1024; // ~11 MB binary

/** Spool a response body to a temp file a chunk at a time, abandoning it the moment it exceeds
 *  `max`. Content-Length is a claim, not a promise, so the running total is what decides.
 *
 *  Never assembled in the heap: `readCapped` held the chunks AND the reassembled copy, so a
 *  download peaked at twice its own size — 10 GB at the 5 GB ceiling. Returns null if oversized. */
async function downloadToDisk(
  store: ProjectStoreAccess,
  resp: Response,
  max: number,
): Promise<StagedFile | null> {
  const reader = resp.body?.getReader();
  if (!reader) return null;
  const tmp = await store.prepareArtifact(
    `tmp/dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        await store.remove(tmp).catch(() => {});
        return null;
      }
      await store.appendBytes(tmp, value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) {
    await store.remove(tmp).catch(() => {});
    return null;
  }
  return stageByPath(store, tmp, true);
}

/** Read a response body, abandoning it the moment it exceeds `max`. Returns null if it did.
 *  The web fallback, where there is no disk to spool to. */
async function readCapped(resp: Response, max: number): Promise<Uint8Array | null> {
  const reader = resp.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array -> base64, chunked so large media never blows the call stack. */
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

interface LibEntry {
  id: string;
  path: string;
  filename: string;
  kind: string;
  existed: boolean;
}

/** A file ALREADY ON DISK, described without loading it. `arrayBuffer()` on a 1 GB
 *  import killed the renderer, so the bytes never enter the webview at all: the id and
 *  size come from a native streaming hash and only the header is materialised. */
export interface StagedFile {
  id12: string;
  size: number;
  /** Leading bytes, enough for the image-header check. */
  head: Uint8Array;
  /** Put the content at `dest`. Not called for an external (referenced) import. */
  commit(dest: string): Promise<void>;
  /** Drop anything staged when the import is rejected. */
  discard(): Promise<void>;
}

function isStaged(v: Uint8Array | StagedFile): v is StagedFile {
  return !(v instanceof Uint8Array);
}

/** Leading bytes: enough for the image-header check, nothing like enough to hurt. */
const HEAD_BYTES = 64 * 1024;

/** Describe a file already on disk WITHOUT loading it: the id and size come from a native
 *  streaming hash and only the header is materialised. `owned` means WE staged it, so it is
 *  ours to move or delete; a referenced import is never copied, so its commit is never reached.
 *
 *  Lives here, beside the only consumer of StagedFile, so the import tool and the drop path
 *  describe a file the same way instead of keeping a copy each. */
export async function stageByPath(
  store: ProjectStoreAccess,
  path: string,
  owned: boolean,
): Promise<StagedFile> {
  const probe = await store.probeMedia(path, HEAD_BYTES);
  if (!probe) throw new Error("this platform cannot import without loading the file");
  return {
    id12: probe.id12,
    size: probe.size,
    head: probe.head,
    // Rename, not copy: the bytes are already in the project, so this is a metadata
    // operation rather than a second pass over a gigabyte.
    commit: (dest) => store.rename(path, dest),
    discard: async () => {
      if (owned) await store.remove(path);
    },
  };
}

/** Tell the UI the library changed. Lives HERE, beside the one door every asset enters by, so it
 *  is announced by the WRITE rather than by whoever remembered to call it: the two hand-written
 *  call sites in upload.ts were the UI import paths, so a library added by ANY agent tool --
 *  import_media, download_video, get_page_image, run_ffmpeg, clip_video, every generation -- stayed
 *  invisible in the panel until the project was reopened.
 *
 *  TRAILING debounce, because the listener re-lists the project directory and a folder import
 *  registers one asset per file. A microtask is not enough: callers await between assets, which
 *  flushes it, so a 200-file import would be 200 directory listings. No-op outside a DOM. */
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

/** Content-address media bytes into `<project>/library/<id><ext>` and register
 *  them in `internals/library.json`. Idempotent by content hash: identical bytes
 *  return the SAME id with no duplicate file or catalog entry. */
export async function registerLibraryClip(
  store: ProjectStoreAccess,
  bytes: Uint8Array | StagedFile,
  filename: string,
  kind: string,
  source?: Record<string, unknown>,
  externalPath?: string,
  opts?: { origin?: MutationOrigin; signal?: AbortSignal },
): Promise<LibEntry> {
  // Reported from the one door every asset enters by, because a refused import ends the
  // session before a prompt ever exists -- the trace just stops, and that is indistinguishable
  // from losing interest. Wrapped rather than placed at the call sites so a new producer
  // cannot forget to say whether its import worked.
  try {
    const entry = await registerLibraryClipInner(
      store,
      bytes,
      filename,
      kind,
      source,
      externalPath,
      opts,
    );
    reportMediaImport(true, store.projectDir);
    return entry;
  } catch (e) {
    // A project closing mid-import is a lifecycle event, not a rejection worth counting as one.
    if (!(e instanceof ProjectClosingError) && !isMutationRejected(e)) {
      reportMediaImport(false, store.projectDir, (e as Error)?.message ?? String(e));
    }
    throw e;
  }
}

async function registerLibraryClipInner(
  store: ProjectStoreAccess,
  bytes: Uint8Array | StagedFile,
  filename: string,
  kind: string,
  source?: Record<string, unknown>,
  externalPath?: string,
  opts?: { origin?: MutationOrigin; signal?: AbortSignal },
): Promise<LibEntry> {
  const staged = isStaged(bytes) ? bytes : null;
  const raw = staged ? null : (bytes as Uint8Array);
  const head = staged ? staged.head : raw!;
  const size = staged ? staged.size : raw!.length;
  // Every producer (import, drag-drop, download, generation, screenshot, ffmpeg output) publishes
  // its catalog row HERE, so this is where "a library asset is renderable" has to hold. An image
  // ffmpeg cannot decode is worse than a missing one: under `-loop 1` it yields no frames and no
  // error, so the render spins instead of failing. Rejected BEFORE any bytes are staged.
  if (kind === "image") {
    const reason = undecodableImageReason(head);
    if (reason) {
      await staged?.discard();
      throw new Error(`'${filename || "image"}' can't be used as media: ${reason}.`);
    }
  }
  const id = `media_${staged ? staged.id12 : await sha256Hex12(raw!)}`;
  const ext = extOf(filename) || defaultExt(kind);
  // EXTERNAL (referenced-in-place): record the absolute source path, copy nothing.
  const external = typeof externalPath === "string" && externalPath.trim().length > 0;
  const rel = external ? externalPath!.replace(/\\/g, "/") : `library/${id}${ext}`;
  const dest = external ? null : joinPath(store.projectDir, rel);
  // Stage the bytes FIRST (content-addressed, lock-free — no two writers contend on a hash path); the
  // authoritative catalog row is published through the gated commit below. `wroteBytes` tracks whether
  // THIS call created the file, so a rejected publish cleans up only its own staged bytes.
  let wroteBytes = false;
  if (dest && !(await store.exists(dest))) {
    // Atomic temp+rename so a crash mid-write never leaves a PARTIAL file (which exists() would treat
    // as a complete copy, making a re-import skip the corrupt file).
    if (staged) await staged.commit(dest);
    else await store.writeBytesAtomic(dest, raw!);
    wroteBytes = true;
  } else {
    // Duplicate content, or referenced in place: nothing to copy, so drop what was spooled.
    await staged?.discard();
  }

  const catPath = joinPath(store.projectDir, INTERNAL_DIR, "library.json");
  // The catalog row is authoritative document state, so its READ-MODIFY-WRITE commits through the
  // SHARED project-mutation executor (the AUTHORITY document's MutationGate) — the SAME boundary as
  // timeline + library_op edits — NOT a private lock. During close the gate REJECTS it (blocker 1: a
  // late import/download/generate job could otherwise publish a catalog row after close); the origin +
  // signal fence rejects a superseded/Stopped agent publish; and the write honors sessionLive so a
  // stale store (a zombie job whose session ended post-eviction, past the drain window) is abandoned
  // even on the no-document fallback. registerLibraryClip never nests inside a lease, so no self-deadlock.
  try {
    const entry = await runProjectMutation(
      store.projectDir,
      "library.import",
      async (_doc, gctx) => {
        const cat = await store.readJson<{
          version?: number;
          clips?: Record<string, unknown>[];
          folders?: unknown[];
        }>(catPath, { version: 1, clips: [], folders: [] });
        cat.clips ??= [];
        const already = cat.clips.find((c) => c && c.id === id);
        if (already)
          return {
            id,
            path: String(already.path ?? rel),
            filename: String(already.filename ?? filename),
            kind,
            existed: true,
          };

        cat.clips.push({
          id,
          filename: filename || `${id}${ext}`,
          path: rel,
          kind,
          ...(external ? { external: true } : {}),
          size_bytes: size,
          added_by: external ? "import_reference" : "import_media",
          added_at: Date.now() / 1000,
          ...(source ? { source } : {}),
        });
        // sessionLive guard: a write for a closed/superseded session is ABANDONED (returns false), not
        // torn — reject cleanly so the caller maps it + the staged bytes are cleaned below.
        const committed = await store.writeTextAtomic(catPath, JSON.stringify(cat, null, 2), () =>
          store.sessionLive(),
        );
        if (!committed)
          throw new ProjectClosingError("library.import abandoned — the project session ended");
        gctx?.markCommitted(); // a real catalog change advances the document revision
        return { id, path: rel, filename: filename || `${id}${ext}`, kind, existed: false };
      },
      { origin: opts?.origin, signal: opts?.signal },
    );
    notifyLibraryChanged(); // only after the catalog row is actually committed
    return entry;
  } catch (e) {
    // Rejected/abandoned late publish (closing / superseded / aborted / stale session): the catalog was
    // NOT written (the gate rejects before the commit; the sessionLive guard abandons the atomic write
    // before its rename), so clean the bytes THIS call staged rather than orphan them (owner Q3).
    // Re-check references first so a concurrent import of the SAME content-addressed bytes that DID
    // commit keeps its file; a residual commit landing in that gap is the deferred two-file-atomicity
    // class (IDEA-CLIENT-PERSIST-001), with the fail-closed close GC as the backstop. Best-effort — a
    // cleanup failure never masks the original rejection.
    if (wroteBytes && dest) {
      try {
        const cat = await store.readJson<{ clips?: Record<string, unknown>[] }>(catPath, {
          clips: [],
        });
        if (!(cat.clips ?? []).some((c) => c && c.id === id)) await store.remove(dest);
      } catch {
        /* best-effort cleanup */
      }
    }
    throw e;
  }
}

/** A clip whose bytes are still being produced. Absent `status` means ready, so every catalog
 *  row written before this existed reads correctly. */
export type ClipStatus = "generating" | "failed";

/** Placeholder ids are NOT content-addressed. The bytes do not exist yet, and the id has to
 *  survive unchanged from submit to completion — every clip the agent places meanwhile points at
 *  it, so a hash computed later would strand them. */
export function newPendingMediaId(): string {
  const c = globalThis.crypto;
  const rand =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID().replace(/-/g, "").slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 12);
  return `media_gen_${rand}`;
}

function defaultExt(kind: string): string {
  if (kind === "image") return ".png";
  if (kind === "audio") return ".mp3";
  if (kind === "subtitle") return ".srt";
  return ".mp4";
}

/** Publish a catalog row for media that is still generating, so the agent can reference (and
 *  place) it immediately. The row carries its FUTURE path: finalizing writes the bytes there and
 *  clears the status, so nothing that already points at the id has to change. */
export async function registerPendingClip(
  store: ProjectStoreAccess,
  spec: {
    id: string;
    filename: string;
    kind: string;
    duration_s?: number;
    source?: Record<string, unknown>;
  },
  opts?: { origin?: MutationOrigin; signal?: AbortSignal },
): Promise<{ id: string; path: string }> {
  const ext = extOf(spec.filename) || defaultExt(spec.kind);
  const rel = `library/${spec.id}${ext}`;
  return runProjectMutation(
    store.projectDir,
    "library.pending",
    async (_doc, gctx) => {
      const cat = await readCatalog(store);
      cat.clips ??= [];
      if (!cat.clips.some((c) => c && c.id === spec.id)) {
        cat.clips.push({
          id: spec.id,
          filename: spec.filename || `${spec.id}${ext}`,
          path: rel,
          kind: spec.kind,
          status: "generating" satisfies ClipStatus,
          added_by: "generation",
          added_at: Date.now() / 1000,
          ...(spec.duration_s != null ? { duration_s: spec.duration_s } : {}),
          ...(spec.source ? { source: spec.source } : {}),
        });
      }
      await commitCatalog(store, cat);
      gctx?.markCommitted();
      return { id: spec.id, path: rel };
    },
    { origin: opts?.origin, signal: opts?.signal },
  );
}

/** Land the real bytes on a placeholder, under the SAME id. Runs the same renderability check
 *  registerLibraryClip does — a generated image ffmpeg cannot decode is exactly as fatal as an
 *  imported one, and this is the second way into the library. */
export async function finalizePendingClip(
  store: ProjectStoreAccess,
  id: string,
  bytes: Uint8Array,
  opts?: { origin?: MutationOrigin; signal?: AbortSignal; meta?: Record<string, unknown> },
): Promise<{ id: string; path: string }> {
  const cat = await readCatalog(store);
  const row = (cat.clips ?? []).find((c) => c && c.id === id);
  if (!row) throw new Error(`no pending media ${id}`);
  const kind = String(row.kind ?? "video");
  if (kind === "image") {
    const reason = undecodableImageReason(bytes);
    if (reason) throw new Error(`generated image can't be used as media: ${reason}.`);
  }
  const rel = String(row.path ?? `library/${id}${defaultExt(kind)}`);
  // Bytes first, catalog second: a crash between them leaves an unreferenced file (harmless,
  // swept by the media GC) rather than a row promising media that is not there.
  await store.writeBytesAtomic(joinPath(store.projectDir, rel), bytes);
  return runProjectMutation(
    store.projectDir,
    "library.finalize",
    async (_doc, gctx) => {
      const fresh = await readCatalog(store);
      const target = (fresh.clips ?? []).find((c) => c && c.id === id);
      if (!target) throw new Error(`no pending media ${id}`);
      delete target.status;
      delete target.error;
      target.size_bytes = bytes.length;
      // Facts that exist ONLY in the provider's response (generated lyrics, measured duration).
      // Going async would otherwise drop them, and nothing can recover them from the file.
      if (opts?.meta)
        target.source = { ...((target.source as Record<string, unknown>) ?? {}), ...opts.meta };
      await commitCatalog(store, fresh);
      gctx?.markCommitted();
      return { id, path: rel };
    },
    { origin: opts?.origin, signal: opts?.signal },
  );
}

/** Mark a placeholder as failed. The row is KEPT: clips the agent already placed still point at
 *  it, and deleting it would silently remove them from the timeline. */
export async function failPendingClip(
  store: ProjectStoreAccess,
  id: string,
  error: string,
  opts?: { origin?: MutationOrigin; signal?: AbortSignal },
): Promise<void> {
  await runProjectMutation(
    store.projectDir,
    "library.fail",
    async (_doc, gctx) => {
      const cat = await readCatalog(store);
      const row = (cat.clips ?? []).find((c) => c && c.id === id);
      if (!row) return;
      row.status = "failed" satisfies ClipStatus;
      row.error = error;
      await commitCatalog(store, cat);
      gctx?.markCommitted();
    },
    { origin: opts?.origin, signal: opts?.signal },
  );
}

/** Finish placeholders whose bytes reached disk but whose catalog flip never did — the job
 *  landed while the project was closed, so the mutation gate refused the row. Bytes are written
 *  before the flip precisely so this is recoverable. Returns the ids it completed. */
export async function reconcilePendingMedia(store: ProjectStoreAccess): Promise<string[]> {
  const cat = await readCatalog(store);
  const pending = (cat.clips ?? []).filter((c) => c && c.status === "generating");
  if (!pending.length) return [];
  const landed: Record<string, unknown>[] = [];
  for (const row of pending) {
    const rel = String(row.path ?? "");
    if (rel && (await store.exists(joinPath(store.projectDir, rel)))) landed.push(row);
  }
  if (!landed.length) return [];
  return runProjectMutation(store.projectDir, "library.reconcile", async (_doc, gctx) => {
    const fresh = await readCatalog(store);
    const done: string[] = [];
    for (const row of fresh.clips ?? []) {
      if (!row || row.status !== "generating") continue;
      if (!landed.some((l) => l.id === row.id)) continue;
      delete row.status;
      delete row.error;
      done.push(String(row.id));
    }
    if (!done.length) return done;
    await commitCatalog(store, fresh);
    gctx?.markCommitted();
    return done;
  });
}

interface Catalog {
  version?: number;
  clips?: Record<string, unknown>[];
  folders?: unknown[];
}
function catalogPath(store: ProjectStoreAccess): string {
  return joinPath(store.projectDir, INTERNAL_DIR, "library.json");
}

function readCatalog(store: ProjectStoreAccess): Promise<Catalog> {
  return store.readJson<Catalog>(catalogPath(store), { version: 1, clips: [], folders: [] });
}

async function commitCatalog(store: ProjectStoreAccess, cat: Catalog): Promise<void> {
  const committed = await store.writeTextAtomic(
    catalogPath(store),
    JSON.stringify(cat, null, 2),
    () => store.sessionLive(),
  );
  if (!committed)
    throw new ProjectClosingError("library write abandoned — the project session ended");
}

/** Join an EXTERNAL directory path with a child name (POSIX slashes — Tauri's fs
 *  accepts forward slashes on every platform, and registerLibraryClip normalizes
 *  the recorded path the same way). NOT project-constrained: import is the one
 *  sanctioned reader of paths outside the project. */
function joinExternal(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

/** import_media `source.path`: LINK a local file — or every media file in a local
 *  directory — into the library IN PLACE (read-only reference, never copied). Bytes
 *  are read ONLY to compute the content-hash id; the recorded path stays the external
 *  source, so deletion/GC never follow it. import is the ONLY tool allowed to read a
 *  path OUTSIDE the project (store.readBytes/readDir pass straight to fs); resolveWritable
 *  is deliberately NOT used — it would reject an out-of-project path. */
async function importFromPath(
  store: ProjectStoreAccess,
  path: string,
  args: Args,
  mime: string,
  note: string | undefined,
  opts?: { origin?: MutationOrigin; signal?: AbortSignal },
): Promise<Result> {
  if (!(await store.exists(path))) return { ok: false, error: `no file or directory at '${path}'` };
  const provenance =
    args.provenance && typeof args.provenance === "object"
      ? (args.provenance as Record<string, unknown>)
      : undefined;

  // Is this a directory? Ask the filesystem, don't read the file to find out. Loading the bytes
  // and watching the binary read fail with EISDIR was a whole-file read used as a stat: a 428 MB
  // clip measured 3.5 GB of peak RSS on the way through the webview boundary, and >1 GB froze a
  // 16 GB machine. other NLEs answers the same question with fileExists(isDirectory:).
  const isDir = await store.isDirectory(path);
  if (!isDir) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    let filename = name || baseName(path);
    if (!extOf(filename) && mime && MIME_EXT[mime]) filename += MIME_EXT[mime];
    const explicitKind =
      args.kind === "video" || args.kind === "image" || args.kind === "audio" ? args.kind : null;
    const kind = explicitKind ?? kindOf(extOf(filename)) ?? kindOf(extOf(path));
    if (!kind) {
      return {
        ok: false,
        error: `couldn't infer a supported media type for '${filename}'. Set source.mimeType or a name with an extension.`,
      };
    }
    // Referenced in place, so the bytes are never copied — they only need hashing for a stable
    // media_ref, which the native probe does by streaming. `readBytes` is the fallback for
    // platforms with no probe, and its own ceiling refuses anything media-sized.
    let src: Uint8Array | StagedFile;
    try {
      src = store.canStreamImport
        ? await stageByPath(store, path, false)
        : await store.readBytes(path);
    } catch (e) {
      return { ok: false, error: `could not read '${path}': ${(e as Error)?.message ?? e}` };
    }
    if (src instanceof Uint8Array && !src.length)
      return { ok: false, error: `linked file '${path}' was empty` };
    let entry: LibEntry;
    try {
      entry = await registerLibraryClip(store, src, filename, kind, provenance, path, opts);
    } catch (e) {
      if (isMutationRejected(e))
        return { ok: false, error: "link: not written — the project is closing" };
      throw e;
    }
    return {
      ok: true,
      media_ref: entry.id,
      filename: entry.filename,
      kind: entry.kind,
      existed: entry.existed,
      external: true,
      ...(note ? { note } : {}),
    };
  }

  // DIRECTORY: link every immediate media file in place (non-recursive), skipping non-media.
  let entries: DirEntry[];
  try {
    entries = await store.readDir(path);
  } catch (e) {
    return { ok: false, error: `couldn't read '${path}' as a file or directory: ${String(e)}` };
  }
  const mediaFiles = entries.filter((e) => !e.isDirectory && kindOf(extOf(e.name)) !== null);
  if (!mediaFiles.length) {
    return {
      ok: false,
      error: `no supported media files in directory '${path}' (looked for video/image/audio by extension).`,
    };
  }
  const imported: Result[] = [];
  const failed: { filename: string; error: string }[] = [];
  for (const e of mediaFiles) {
    const child = joinExternal(path, e.name);
    try {
      const bytes = await store.readBytes(child);
      if (!bytes.length) {
        failed.push({ filename: e.name, error: "empty file" });
        continue;
      }
      const kind = kindOf(extOf(e.name))!;
      const entry = await registerLibraryClip(store, bytes, e.name, kind, provenance, child, opts);
      imported.push({
        media_ref: entry.id,
        filename: entry.filename,
        kind: entry.kind,
        existed: entry.existed,
      });
    } catch (err) {
      failed.push({ filename: e.name, error: String(err) });
    }
  }
  if (!imported.length) {
    return {
      ok: false,
      error: `failed to link any media from '${path}'`,
      ...(failed.length ? { failed } : {}),
    };
  }
  return {
    ok: true,
    imported,
    count: imported.length,
    external: true,
    ...(failed.length ? { failed } : {}),
    ...(note ? { note } : {}),
  };
}

/** import_media: bring an external asset — an HTTPS `url` or base64 `bytes` (COPIED into
 *  the library) or a local file/directory `path` (LINKED in place) — into the library,
 *  returning a `media_ref` id (a directory returns one per media file). */
export async function importMediaTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const source = args.source && typeof args.source === "object" ? (args.source as Args) : null;
  if (!source) return { ok: false, error: "a 'source' object is required" };
  const pathIn = typeof source.path === "string" ? source.path.trim() : "";
  let url = typeof source.url === "string" ? source.url.trim() : "";
  let bytesB64 = typeof source.bytes === "string" ? source.bytes : "";
  const mime = typeof source.mimeType === "string" ? source.mimeType : "";
  const provided = [
    ["path", Boolean(pathIn)],
    ["url", Boolean(url)],
    ["bytes", Boolean(bytesB64)],
  ]
    .filter(([, v]) => v)
    .map(([k]) => k as string);
  if (provided.length === 0) {
    return {
      ok: false,
      error:
        "source must set url, bytes, or path — url downloads an HTTPS link; bytes is inline base64 data; path LINKS a local file or directory of media in place (read-only, never copied).",
    };
  }

  // `path` is the most concrete source: a local link-in-place (no download, no copy). If set, it
  // wins over url/bytes — note the drop rather than rejecting a multi-source call.
  if (pathIn) {
    const dropped = provided.filter((k) => k !== "path");
    const linkNote = dropped.length
      ? `used path (linked in place); ignored ${dropped.join(" and ")} — set just one source.`
      : undefined;
    return importFromPath(ctx.store, pathIn, args, mime, linkNote, {
      origin: ctx.origin,
      signal: ctx.signal,
    });
  }
  // url/bytes are alternative COPY sources (path was handled above). Keep the most concrete USABLE
  // one (url > bytes) — bytes is decode-checked, so garbage bytes falls back to url; url is trusted
  // (no network pre-flight). Note the drop rather than rejecting a multi-source call.
  let importNote: string | undefined;
  if (provided.length > 1) {
    let bytesOk = false;
    if (bytesB64) {
      try {
        bytesOk = b64ToBytes(bytesB64).length > 0;
      } catch {
        bytesOk = false;
      }
    }
    const usable: Record<string, boolean> = { url: Boolean(url), bytes: bytesOk };
    const kept = ["url", "bytes"].find((k) => provided.includes(k) && usable[k]) ?? "";
    if (!kept) {
      return {
        ok: false,
        error:
          "the provided source wasn't usable — bytes wasn't valid base64 (url, if given, would have been used).",
      };
    }
    if (kept !== "url") url = "";
    if (kept !== "bytes") bytesB64 = "";
    const dropped = provided.filter((k) => k !== kept);
    importNote =
      provided[0] !== kept
        ? `${provided[0]} was unusable (not decodable), so I imported from ${kept} instead.`
        : `used ${kept}; ignored ${dropped.join(" and ")} — set just one source (url downloads, bytes is inline base64).`;
  }
  const name = typeof args.name === "string" ? args.name.trim() : "";

  // A desktop download spools to a StagedFile on disk; only the web fallback yields a buffer.
  let bytes: Uint8Array | StagedFile;
  let filename: string;
  try {
    if (url) {
      const resp = await fetch(url);
      if (!resp.ok) return { ok: false, error: `download failed: HTTP ${resp.status}` };
      const declared = Number(resp.headers.get("content-length") ?? 0);
      if (declared > MAX_DOWNLOAD_BYTES)
        return {
          ok: false,
          error: `that download is ${(declared / 1e9).toFixed(1)} GB; the limit is 5 GB. Download it yourself and import the file.`,
        };
      // Desktop spools to disk; only the web fallback, which has none, builds a buffer.
      const capped = ctx.store.canStreamImport
        ? await downloadToDisk(ctx.store, resp, MAX_DOWNLOAD_BYTES)
        : await readCapped(resp, MAX_DOWNLOAD_BYTES);
      if (!capped)
        return {
          ok: false,
          error:
            "download stopped: the file is over the 5 GB limit. Download it yourself and import the file.",
        };
      bytes = capped;
      filename = name || baseName(new URL(url).pathname);
    } else {
      if (bytesB64.length > MAX_INLINE_B64_CHARS)
        return {
          ok: false,
          error: `source.bytes is too large (${bytesB64.length} chars; max ${MAX_INLINE_B64_CHARS}). Use url or path for anything larger.`,
        };
      bytes = b64ToBytes(bytesB64);
      filename = name || "";
    }
  } catch (e) {
    return { ok: false, error: `import failed: ${String(e)}` };
  }
  // A staged download reports its size without a buffer to measure.
  if (!(isStaged(bytes) ? bytes.size : bytes.length))
    return { ok: false, error: "imported media was empty" };
  if (!extOf(filename) && mime && MIME_EXT[mime]) filename += MIME_EXT[mime];
  if (!filename) filename = `import${MIME_EXT[mime] ?? ""}`;

  // An explicit kind (generated media persisted via the gateway) is
  // authoritative; otherwise infer from the filename extension (user imports).
  const explicitKind =
    args.kind === "video" || args.kind === "image" || args.kind === "audio" ? args.kind : null;
  const kind = explicitKind ?? kindOf(extOf(filename));
  if (!kind) {
    return {
      ok: false,
      error: `couldn't infer a supported media type for '${filename}'. Set source.mimeType or a name with an extension.`,
    };
  }
  const provenance =
    args.provenance && typeof args.provenance === "object"
      ? (args.provenance as Record<string, unknown>)
      : undefined;

  let entry: LibEntry;
  try {
    entry = await registerLibraryClip(ctx.store, bytes, filename, kind, provenance, undefined, {
      origin: ctx.origin,
      signal: ctx.signal,
    });
  } catch (e) {
    if (isMutationRejected(e))
      return { ok: false, error: "import_media: not written — the project is closing" };
    throw e;
  }
  return {
    ok: true,
    media_ref: entry.id,
    filename: entry.filename,
    kind: entry.kind,
    existed: entry.existed,
    ...(importNote ? { note: importNote } : {}),
  };
}

/** read_media (INTERNAL — gateway<->client only, NOT in the model contract):
 *  resolve a library ref / project-relative path to its raw bytes (base64) so a
 *  server-side call can receive the media OVER THE WIRE instead of reading the
 *  client's disk. The inverse of import_media; keeps the server from ever
 *  touching client-owned files (remote-backend safe). When `encode` is
 *  "gemini_video" and the ref is a video, pre-encode it into a compact
 *  downscaled/fps-sampled/muted MP4 first (the client twin of the server's
 *  _encode_for_gemini_cached) so we ship a small clip instead of the full
 *  source; the response is flagged `encoded: "gemini_video"`. */
export async function readMediaTool(args: Args, ctx: ClientToolContext | null): Promise<Result> {
  if (!ctx) return NOT_READY;
  const ref = typeof args.ref === "string" ? args.ref.trim() : "";
  if (!ref) return { ok: false, error: "ref is required" };
  const abs = await ctx.store.resolveRef(ref);
  if (!abs) return { ok: false, error: `not found: ${ref}` };
  try {
    const encode = typeof args.encode === "string" ? args.encode : "";
    if (encode === "gemini_video" && kindOf(extOf(abs)) === "video") {
      const enc = await encodeVideoForGemini(ctx, abs, { fps: 4, maxDim: 720, keepAudio: false });
      const bytes = await ctx.store.readBytes(enc);
      return {
        ok: true,
        bytes: bytesToB64(bytes),
        ext: ".mp4",
        size_bytes: bytes.length,
        encoded: "gemini_video",
      };
    }
    const bytes = await ctx.store.readBytes(abs);
    return { ok: true, bytes: bytesToB64(bytes), ext: extOf(abs), size_bytes: bytes.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function registerImportTools(
  registry: ClientToolRegistry,
  getCtx: () => ClientToolContext | null,
): void {
  registry.register("import_media", (a) => importMediaTool(a, getCtx()));
  // NB: read_media is an INTERNAL bytes-bridge helper (readMediaTool), never a
  // model tool — deliberately NOT registered. Call readMediaTool() directly.
}
