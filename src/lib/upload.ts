import { desktopStore } from "./desktop";
import { platform } from "../platform";
import { registerLibraryClip, stageByPath, type StagedFile } from "../tools/import";
import { joinPath, type ProjectStoreAccess } from "../tools/store";
import { useProjectNotice } from "../store/projectNotice";
import { withImportJob } from "../store/importJobs";
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  SUBTITLE_EXTS,
  VIDEO_EXTS,
  kindOf as classify,
  type MediaKind,
} from "../media/formats";

// Media extensions we accept for drag-and-drop import (matches FileTree).
export const MEDIA_RE = new RegExp(
  `\\.(${[...VIDEO_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS, ...SUBTITLE_EXTS].join("|")})$`,
  "i",
);

/** MIME type → extension, for naming clipboard-pasted media (which often has no
 *  filename). Keeps audio/mpeg → .mp3 etc. so the library entry gets a real ext. */
export const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
};

/**
 * Media files carried by a paste or a web drop, named so the library gets a REAL extension.
 *
 * Two rules that each cost a silent misimport:
 *  - macOS puts a QuickLook PREVIEW of a copied video on the pasteboard NEXT TO it, so an
 *    `image/*` flavour is used only when nothing richer is offered — otherwise pasting a video
 *    imported a .jpeg still of its first frame, which then lands on a lane as a 1-frame sliver.
 *  - an extension is MAPPED, never invented from the MIME subtype: `video/quicktime` is `.mov`,
 *    and `.quicktime` is not a format anything downstream can read. A flavour that maps to no
 *    supported extension is dropped rather than imported under a name that only looks valid.
 */
export function filesFromItems(items: DataTransferItemList | null | undefined): File[] {
  // Array.from, not spread: it accepts an ARRAY-LIKE, so this never depends on the collection
  // carrying a Symbol.iterator. (Chromium and WebKit both iterate it today — measured in
  // e2e/ui/osdrop.spec.ts — so this is cheap insurance, not a fix for a known break.)
  const media = Array.from(items ?? []).filter(
    (it) => it.kind === "file" && /^(image|video|audio)\//.test(it.type),
  );
  const toFiles = (list: DataTransferItem[]): File[] =>
    list
      .map((it, i) => {
        const raw = it.getAsFile();
        if (!raw) return null;
        if (raw.name && MEDIA_RE.test(raw.name)) return raw;
        const ext = MIME_EXT[raw.type];
        return ext ? new File([raw], `paste-${Date.now()}-${i}${ext}`, { type: raw.type }) : null;
      })
      .filter((f): f is File => f !== null);
  // Fall back to the preview when the richer flavour cannot be materialised (a macOS file
  // promise often yields no bytes) — a still beats importing nothing at all.
  const rich = toFiles(media.filter((it) => !it.type.startsWith("image/")));
  return rich.length ? rich : toFiles(media);
}

/** Coarse media kind from a filename extension (library entries carry it). Falls back to video
 *  for an unrecognised name, which is only reached for clipboard pastes that MEDIA_RE let in. */
function kindOf(name: string): MediaKind {
  return classify(name) ?? "video";
}

/** Nudge the file tree to refetch after an import triggered from anywhere
 *  (the tree listens for this on `window`). Re-exported: `registerLibraryClip` owns the announcing
 *  now, so nothing here has to remember to call it. */
export { notifyLibraryChanged as notifyFilesChanged } from "../tools/import";

export interface Uploaded {
  /** Absolute path on disk (used for server-side chat attachments). */
  path: string;
  name: string;
  /** Project-relative path — the portable clip source that resolves against the
   *  client's project dir regardless of the server's sandboxed location. */
  rel: string;
  /** Library id, for callers that need to act on the entry they just created. */
  id: string;
}

/** Filename with any directory components stripped (mirrors the server's
 *  `Path(filename).name`), so a dropped path can't write outside uploads/. */
function baseName(name: string): string {
  return name.replace(/\\/g, "/").split("/").pop() || "upload.bin";
}

/** Spool size. Big enough that a 1 GB file is ~128 writes, small enough that the
 *  webview never holds a buffer worth crashing over. */
const CHUNK = 8 * 1024 * 1024;

/** Import one file into the project's library, returning its absolute path +
 *  the portable project-relative ref. On desktop (a `store` is available) the
 *  bytes are content-addressed straight into the co-located library — no HTTP
 *  round-trip; on web the server takes the multipart upload. `store` is
 *  injectable for tests. */
export async function importFile(
  projectId: string,
  file: File,
  store: ProjectStoreAccess | null = desktopStore(projectId),
): Promise<Uploaded> {
  if (!store) throw new Error("no project store: media import requires the desktop client");
  const name = baseName(file.name);
  // `await file.arrayBuffer()` materialises the WHOLE file in the webview's heap, and a
  // 1 GB import took the renderer down with it. Spool it to disk in chunks instead and
  // let the native side hash it; only the header is ever held in JS.
  const src = store.canStreamImport
    ? await stageLargeFile(store, file)
    : new Uint8Array(await file.arrayBuffer());
  const entry = await registerLibraryClip(store, src, name, kindOf(name));
  return { path: joinPath(store.projectDir, entry.path), name, rel: entry.path, id: entry.id };
}

/** Write `file` to a temp path a chunk at a time, then describe it from disk. */
async function stageLargeFile(store: ProjectStoreAccess, file: File): Promise<StagedFile> {
  const tmp = joinPath(store.projectDir, `library/.incoming-${crypto.randomUUID()}`);
  const reader = file.stream().getReader();
  try {
    let pending: Uint8Array[] = [];
    let held = 0;
    const flush = async () => {
      if (!held) return;
      const buf = new Uint8Array(held);
      let at = 0;
      for (const p of pending) {
        buf.set(p, at);
        at += p.length;
      }
      pending = [];
      held = 0;
      await store.appendBytes(tmp, buf);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      held += value.length;
      if (held >= CHUNK) await flush();
    }
    await flush();
  } finally {
    reader.releaseLock();
  }
  return stagedFromPath(store, tmp, true);
}

/** Describe a file already on disk. `owned` means WE spooled it, so it is ours to move
 *  or delete; a referenced import is never copied, so its commit is never reached. */
async function stagedFromPath(
  store: ProjectStoreAccess,
  path: string,
  owned: boolean,
): Promise<StagedFile> {
  return stageByPath(store, path, owned);
}

/** Media extensions offered by the OS picker (same set the drop filter accepts). */
export const MEDIA_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS];

/**
 * Pick media with the OS dialog and import it. Returns null on WEB, where the caller must fall
 * back to its hidden `<input type=file>`.
 *
 * Desktop must NOT use that input. The window runs with `dragDropEnabled: true` (the OS-drop
 * feature depends on it), and on macOS Tauri's native drag-drop handler stops a file input from
 * ever opening its dialog — the button does nothing at all, silently, while Windows is fine.
 * The menu's Import Media already went through the dialog; the chat attach button and the
 * library's + did not, which is exactly the pair that was reported dead.
 *
 * Files are LINKED in place, matching the menu: a desktop import is never copied.
 */
export async function importViaDialog(
  projectId: string,
  title: string,
): Promise<Uploaded[] | null> {
  if (platform.name !== "tauri") return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    title,
    filters: [{ name: "Media", extensions: MEDIA_EXTS }],
  });
  if (!picked) return []; // cancelled — not a failure, and nothing to report
  return importPaths(projectId, Array.isArray(picked) ? picked : [picked]);
}

/** Import several files BY REFERENCE, reporting whatever failed. The OS picker, the library
 *  drop and the chat drop all want exactly this, and each had grown its own loop — one of them
 *  swallowed every failure, which is the dead-button silence this module exists to prevent. */
export async function importPaths(projectId: string, paths: string[]): Promise<Uploaded[]> {
  const out: Uploaded[] = [];
  const failed: string[] = [];
  let reason = "";
  for (const p of paths) {
    try {
      out.push(await withImportJob(p, () => importFileByReference(projectId, p)));
    } catch (e) {
      failed.push(baseName(p));
      reason = e instanceof Error ? e.message : String(e);
    }
  }
  if (failed.length) notifyImportFailure(failed, reason);
  return out;
}

/** Import a file BY REFERENCE (desktop only): the media stays where it is on
 *  disk — the library records its ABSOLUTE path instead of copying the bytes in.
 *  Needs the real path (a browser `File` has none), so this is the Tauri
 *  file-dialog / path flow, not the drag-drop `File[]` flow. The source bytes are
 *  still hashed once for a stable `media_ref` (dedups against a copied twin).
 *  `store` is injectable for tests. */
export async function importFileByReference(
  projectId: string,
  absPath: string,
  store: ProjectStoreAccess | null = desktopStore(projectId),
): Promise<Uploaded> {
  if (!store) throw new Error("no project store: media import requires the desktop client");
  const name = baseName(absPath);
  // Referenced in place: the bytes are never copied, so reading the whole file just to
  // hash it was pure cost — and fatal at 1 GB. The native probe streams it.
  const src = store.canStreamImport
    ? await stagedFromPath(store, absPath, false)
    : await store.readBytes(absPath);
  const entry = await registerLibraryClip(store, src, name, kindOf(name), undefined, absPath);
  return { path: absPath, name, rel: entry.path, id: entry.id };
}

/** One message per batch, naming what failed. Silence here is indistinguishable from a dead
 *  button, which is how a broken import reached users as "nothing happens". */
function notifyImportFailure(failed: string[], reason: string): void {
  useProjectNotice
    .getState()
    .notify(
      failed.length === 1
        ? `Couldn't import ${failed[0]}: ${reason}`
        : `Couldn't import ${failed.length} files (${failed.join(", ")}): ${reason}`,
    );
}

/** Import files into the project and return the ones that landed. Sequential so a big
 *  multi-file drop doesn't hammer the backend.
 *
 *  A failure is REPORTED, never swallowed. This is the one boundary every picker, paste and
 *  drop goes through, so reporting here is the only version of the rule a future caller cannot
 *  forget — and silence here is indistinguishable from a dead button, which is exactly how a
 *  broken attach reached users as "nothing happens". The rest of the batch still imports. */
export async function uploadFiles(projectId: string, files: File[]): Promise<Uploaded[]> {
  const out: Uploaded[] = [];
  const failed: string[] = [];
  let reason = "";
  for (const f of files) {
    try {
      out.push(await importFile(projectId, f));
    } catch (e) {
      failed.push(baseName(f.name));
      reason = e instanceof Error ? e.message : String(e);
    }
  }
  if (failed.length) notifyImportFailure(failed, reason);
  return out;
}
