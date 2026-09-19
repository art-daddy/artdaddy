// Shared-filesystem access to the co-located project store (desktop). The
// server stays authoritative; the desktop client resolves refs and reads/writes
// the SAME local files under `<project_dir>/`. `FsLike` is injectable: the Tauri
// fs plugin in production, a mock/Node fs in tests. Ports the Python
// `_resolve_media_ref` + `Library.resolve` logic (src/akaru).

import { currentProjectSession } from "./coordinator";

/** What the importer can learn about a file it must never load. */
export interface MediaProbe {
  /** First 12 hex chars of the sha256 of the whole file. */
  id12: string;
  size: number;
  head: Uint8Array;
}

export interface FsLike {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Read raw bytes (binary decode, e.g. an ffmpeg rawvideo dump). Optional:
   *  only the production (Tauri/Node) fs + binary-exercising tests implement it. */
  readBytes?(path: string): Promise<Uint8Array>;
  /** Write raw bytes (e.g. a downloaded whisper model). Optional. */
  writeBytes?(path: string, data: Uint8Array): Promise<void>;
  /** Append raw bytes, so a large file can be spooled a chunk at a time instead of
   *  existing in the webview's heap all at once. Optional. */
  appendBytes?(path: string, data: Uint8Array): Promise<void>;
  /** Content-hash id, size and leading bytes of a file on disk, computed WITHOUT
   *  reading it into the webview. Optional (desktop only). */
  probeMedia?(path: string, headBytes: number): Promise<MediaProbe>;
  /** Size and file-vs-directory WITHOUT opening the file. Optional (desktop only).
   *  The cheap answer to both "how big is this?" and "is this a folder?" — asking either
   *  question by reading the file is what took a 16 GB machine down. */
  stat?(path: string): Promise<{ isDirectory: boolean; size: number }>;
  /** List a directory's immediate children. Optional (project-lifecycle ops). */
  readDir?(path: string): Promise<DirEntry[]>;
  /** Recursively delete a file or directory. Optional (delete_project). */
  remove?(path: string): Promise<void>;
  /** Move a file/dir to the OS Recycle Bin / Trash (recoverable). Optional: only the
   *  production (Tauri) fs implements it; delete falls back to the app `.trash/` without it. */
  trash?(path: string): Promise<void>;
  /** Copy a single file. Optional (duplicate_project, via a recursive walk). */
  copyFile?(src: string, dst: string): Promise<void>;
  /** Rename/move a file (used for atomic temp -> final writes). Optional. */
  rename?(from: string, to: string): Promise<void>;
  /** Resolve the OS "Downloads" directory (absolute). Optional: only the
   *  production (Tauri) fs implements it. User-facing exports land here
   *  (other NLEs: deliverables go to ~/Downloads, never inside the project). */
  downloadDir?(): Promise<string>;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface LibraryClip {
  id: string;
  /** Where the media lives. For a COPIED clip this is project-relative (POSIX);
   *  for an EXTERNAL (referenced-in-place) clip it is the absolute source path. */
  path: string;
  filename?: string;
  kind?: string;
  aliases?: string[];
  /** True when `path` is an ABSOLUTE reference to a file OUTSIDE the project
   *  (imported by reference, not copied in). */
  external?: boolean;
  [k: string]: unknown;
}

function normSep(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Windows drive (`C:\` or `C:/`), POSIX (`/`), or UNC (`\\server`). The one absolute-path
 *  rule: the export destination validator and the project-location resolver both ask HERE. */
export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p);
}
const isAbsolute = isAbsolutePath;

/** Last path segment, separator-agnostic. */
function baseName(p: string): string {
  const parts = normSep(p).split("/");
  return parts[parts.length - 1] ?? "";
}

/** True when `ref` is a raw system path an AGENT must never supply — a bare absolute path or a
 *  `..` escape. Absolute paths are INTERNAL only; the agent deals in library refs (media id /
 *  filename) and contained project-relative paths. Single source of the agent-ref rule, shared by
 *  {@link ProjectStoreAccess.resolveMediaRef} (returns null on an unsafe ref) and add_clips /
 *  insert_clips placement (which rejects an unsafe ref but still lets a non-absolute UNRESOLVED ref
 *  fall through to ffprobe). */
export function isUnsafeAgentRef(ref: string): boolean {
  const s = (ref ?? "").trim();
  return isAbsolute(s) || s.split(/[\\/]+/).some((seg) => seg === "..");
}

/** Join path segments with POSIX separators (accepted by Tauri fs on Windows). */
export function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) =>
      i === 0 ? normSep(p).replace(/\/+$/, "") : normSep(p).replace(/^\/+|\/+$/g, ""),
    )
    .filter((p) => p.length > 0)
    .join("/");
}

/** The internal metadata folder inside each project dir (formerly ".akaru").
 *  Non-dot so it reads cleanly inside an exported bundle; the in-app file tree
 *  still shows only `library/`. Single source of truth for the folder name. */
export const INTERNAL_DIR = "internals";

/** The most this app will ever pull into the webview heap in one go. Sidecars (timeline JSON,
 *  subtitles, a poster) sit far below it; media never comes close. */
export const MAX_HEAP_READ_BYTES = 64 * 1024 * 1024;

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** Read + JSON-parse a file, PRESERVING the bytes on corruption instead of
 *  silently clobbering them on the next write. Missing (or unreadable) -> the
 *  `fallback` (missing != corrupt). Corrupt JSON -> the raw bytes are moved
 *  aside to a `<path>.corrupt-<ts>` sibling (best-effort) so a newer build or
 *  the user can recover them, then `fallback` is returned so the app still
 *  opens (graceful degrade). */
export async function readJsonOrRecover<T>(fs: FsLike, path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    if (!(await fs.exists(path))) return fallback;
    raw = await fs.readTextFile(path);
  } catch {
    return fallback; // unreadable I/O — treat like missing (nothing to preserve)
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      if (fs.rename) await fs.rename(path, backup);
      else await fs.writeTextFile(backup, raw);
    } catch {
      /* best-effort preservation; never block the caller */
    }
    return fallback;
  }
}

/** Write text ATOMICALLY on any {@link FsLike}: write a temp sibling then rename
 *  it onto `path` (rename is atomic on one volume), so a concurrent reader never
 *  observes a half-written file. Falls back to a direct write when the fs has no
 *  rename (tests / older platforms) or rename-over-existing is unsupported.
 *  Shared by {@link ProjectStoreAccess.writeTextAtomic} and the project registry. */
export async function atomicWriteText(
  fs: FsLike,
  path: string,
  contents: string,
  guard?: () => boolean,
): Promise<boolean> {
  if (!fs.rename) {
    // No atomic rename (tests / older platforms): the direct write IS the commit, so
    // check the liveness guard right before it.
    if (guard && !guard()) return false;
    await fs.writeTextFile(path, contents);
    return true;
  }
  const rand = Math.random().toString(36).slice(2, 8);
  const dot = path.lastIndexOf(".");
  const tmp =
    dot < 0 ? `${path}.tmp-${rand}` : `${path.slice(0, dot)}.tmp-${rand}${path.slice(dot)}`;
  await fs.writeTextFile(tmp, contents);
  // Re-check the guard at the DEEPEST boundary — right before the rename that atomically commits
  // the file — so a close/supersede that landed DURING the temp write abandons the commit
  // (nothing renamed into place) rather than persisting stale work (finding #2).
  if (guard && !guard()) {
    await fs.remove?.(tmp).catch(() => undefined);
    return false;
  }
  try {
    await fs.rename(tmp, path);
  } catch {
    // rename-over-existing isn't supported here: fall back to a direct write. Re-check the guard
    // first — a close that landed during the failed rename must abandon the fallback write too,
    // which is ALSO async (finding #3). Best-effort clean up the temp either way.
    if (guard && !guard()) {
      await fs.remove?.(tmp).catch(() => undefined);
      return false;
    }
    await fs.writeTextFile(path, contents);
    await fs.remove?.(tmp).catch(() => undefined);
  }
  return true;
}

/** Binary twin of {@link atomicWriteText}: stage a temp sibling then atomically rename it onto
 *  `path` (rename is atomic on one volume), so a crash mid-write never leaves a PARTIAL file at the
 *  destination — the "staged library commit" for content-addressed owned media. Falls back to a
 *  direct write when the fs can't rename; cleans up the temp on a rename failure. */
export async function atomicWriteBytes(fs: FsLike, path: string, data: Uint8Array): Promise<void> {
  if (!fs.writeBytes) throw new Error("this filesystem does not support binary writes");
  if (!fs.rename) {
    await fs.writeBytes(path, data); // no atomic rename -> the direct write IS the commit
    return;
  }
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${path}.tmp-${rand}`; // NOT a media ext -> a leftover temp is never picked up by rescan
  await fs.writeBytes(tmp, data);
  try {
    await fs.rename(tmp, path);
  } catch {
    // rename-over-existing unsupported here -> direct write; clean the temp either way.
    await fs.writeBytes(path, data);
    await fs.remove?.(tmp).catch(() => undefined);
  }
}

// ── Deleted-project tombstones (RF4) ───────────────────────────────────────────
// After a project folder is trashed/deleted, a background writer still bound to
// its (now-gone) dir can be mid-flight — an IndexCoordinator proxy/transcript job,
// the debounced preview-thumbnail write, or a coalesced session persist. If one
// lands AFTER the delete it recreates the folder as orphan litter (no zombie
// project — the registry entry is already gone — just disk clutter). Marking the
// dir dead here makes every ProjectStoreAccess write (and its dir-creating mkdir)
// a silent no-op, so a late writer can't resurrect the folder. Revived when a
// fresh project is (re)created at the same path (defensive; generated ids are
// unique in practice). A hard-kill DURING a write, or a subprocess (ffmpeg) that
// already opened its output before the delete, is out of scope — that's the
// deferred cancellable-jobs / closeProject barrier.
const deadProjectDirs = new Set<string>();

function dirKey(dir: string): string {
  return normSep(dir).replace(/\/+$/, "");
}

/** Drop writes to a project dir that has been trashed/deleted, so an in-flight
 *  background writer can't recreate the folder (RF4). */
export function markProjectDirDead(dir: string): void {
  deadProjectDirs.add(dirKey(dir));
}

/** Clear the dead mark — a fresh project (re)created at the same path is live. */
export function reviveProjectDir(dir: string): void {
  deadProjectDirs.delete(dirKey(dir));
}

/** True when the dir was deleted and its writes should be dropped. */
export function isProjectDirDead(dir: string): boolean {
  return deadProjectDirs.has(dirKey(dir));
}

/** Absolute on-disk path for a catalog clip. An EXTERNAL (referenced-in-place)
 *  clip carries an ABSOLUTE source `path`, so it is used as-is; a COPIED clip
 *  carries a project-relative one joined onto the project dir. Single source of
 *  truth for clip -> path, shared by {@link ProjectStoreAccess.resolveRef} and the
 *  library rescan/delete ops (naively joining an absolute external path onto the
 *  project dir yields nonsense that never exists -- see F12). */
export function clipAbs(projectDir: string, m: LibraryClip): string {
  return m.external ? normSep(m.path) : joinPath(projectDir, m.path);
}

export class ProjectStoreAccess {
  /** The project's session generation captured when THIS store was built. The editor
   *  (makeProjectStore) and the agent tool-host (makeTauriContext) each build their own store
   *  over the same dir; both capture the live generation, so a commit is abandoned once its
   *  store's session is superseded by a close. */
  private readonly sessionGen: number;

  constructor(
    readonly projectDir: string,
    private readonly fs: FsLike,
  ) {
    this.sessionGen = currentProjectSession(projectDir);
  }

  /** True while this store's editing session is still the CURRENT one for the project (not
   *  closed/superseded). saveTimeline passes this as the commit guard, so every timeline
   *  mutation, undo, and redo abandons its write once the user has left the project. */
  sessionLive(): boolean {
    return currentProjectSession(this.projectDir) === this.sessionGen;
  }

  /** True once this project's dir has been trashed/deleted (RF4): writes drop to
   *  no-ops so a late background writer can't resurrect the folder. */
  private get dead(): boolean {
    return isProjectDirDead(this.projectDir);
  }

  private catalogPath(): string {
    return joinPath(this.projectDir, INTERNAL_DIR, "library.json");
  }

  async listClips(): Promise<LibraryClip[]> {
    const p = this.catalogPath();
    try {
      if (!(await this.fs.exists(p))) return [];
      const data = JSON.parse(await this.fs.readTextFile(p)) as { clips?: LibraryClip[] };
      return Array.isArray(data.clips) ? data.clips : [];
    } catch {
      return [];
    }
  }

  /**
   * Resolve a library id (`media_…`) / filename / alias / project-relative /
   * absolute reference to an absolute path on the shared filesystem, or null
   * when nothing resolves to an existing file.
   *
   * Every strategy is tried in turn. An earlier version returned null as soon as a
   * `media_`-prefixed ref missed an EXACT id, so `media_abc.mp4` — the basename of
   * the `path` the catalog itself stores, and the form shown in the library panel —
   * was unresolvable even though the file was right there.
   */
  async resolveRef(ref: string): Promise<string | null> {
    const s = (ref ?? "").trim();
    if (!s) return null;

    if (isAbsolute(s)) {
      const p = normSep(s);
      return (await this.fs.exists(p)) ? p : null;
    }

    // A ref WITH a directory component is a PATH, and resolves as one. The stem match
    // below is for BARE names only: otherwise any artifact named after its media is
    // swallowed — `internals/cache/thumbnails/<id>.jpg` returned the library VIDEO, and
    // because that answer was non-null it also suppressed the caller's poster fallback.
    const bare = !/[\\/]/.test(s);
    if (!bare) {
      const direct = joinPath(this.projectDir, s);
      if (await this.fs.exists(direct)) return direct;
    }

    const clips = await this.listClips();
    const base = baseName(s);
    const stem = base.replace(/\.[^./\\]+$/, "");
    const match =
      clips.find((c) => c.id === s) ??
      clips.find((c) => c.filename === s || (c.aliases ?? []).includes(s)) ??
      // The stored path's basename, and (for a bare ref) that basename minus its
      // extension: the two shapes a caller derives from what the UI and catalog display.
      clips.find((c) => baseName(c.path) === base || (bare && c.id === stem)) ??
      null;
    if (match) {
      const p = clipAbs(this.projectDir, match);
      if (await this.fs.exists(p)) return p;
    }

    const rel = joinPath(this.projectDir, s);
    return (await this.fs.exists(rel)) ? rel : null;
  }

  /** A catalog row whose FILE is not on disk: generation is asynchronous, so a `media_ref` is real
   *  and unresolvable AT THE SAME TIME for as long as the job runs. Every resolver answers null for
   *  one, which reads as "your ref is wrong" — so this exists to let a caller tell the two apart.
   *  Lives here because {@link resolveRef} is the one door refs come through; a copy in one tool is
   *  how 21 `inspect_media` calls in a single session were told "media not found". */
  async pendingMedia(
    ref: string,
  ): Promise<{ id: string; path: string; kind: string; status: string; error?: string } | null> {
    const s = (ref ?? "").trim();
    if (!s) return null;
    let clips: LibraryClip[];
    try {
      clips = await this.listClips();
    } catch {
      return null;
    }
    const row = clips.find((c) => c.id === s || c.filename === s || (c.aliases ?? []).includes(s));
    const status = row ? String(row.status ?? "") : "";
    if (!row || (status !== "generating" && status !== "failed")) return null;
    return {
      id: String(row.id),
      path: String(row.path ?? ""),
      kind: String(row.kind ?? "video"),
      status,
      ...(row.error != null ? { error: String(row.error) } : {}),
    };
  }

  /**
   * Resolve an AGENT-SUPPLIED media reference (a `media_ref` tool argument the model typed) to an
   * absolute path, but ONLY when it names REGISTERED library media (id `media_…` / filename /
   * alias) or a CONTAINED project-relative path. A bare ABSOLUTE path, or a project-relative path
   * that escapes the project with `..`, is REJECTED (returns null).
   *
   * The read-side guard on an UNTRUSTED agent ref: without it a crafted `media_ref` (e.g. an OS
   * path like `/etc/passwd`) would let a read tool (`video_ask` / `inspect_media`) read an arbitrary
   * file and exfiltrate it to the model. `import_media` `source.path` is the ONE sanctioned way the
   * model links a local file (a WRITE that content-addresses + records it in the catalog); a linked
   * EXTERNAL clip then stays reachable ONLY by its `media_id`, which resolves through the catalog to
   * its registered absolute source — never by a raw absolute string this method would accept. So a
   * media file the model EXPLICITLY imported is inspectable (the accepted linked-media capability),
   * but a one-step "inspect `/etc/passwd`" via a raw absolute ref is still rejected here. Trusted
   * CLIP-DERIVED sources (which may themselves BE an external absolute ref) must keep using
   * {@link resolveRef}; this method is for the untrusted agent argument only.
   */
  async resolveMediaRef(ref: string): Promise<string | null> {
    const s = (ref ?? "").trim();
    if (!s || isUnsafeAgentRef(s)) return null; // reject empty + raw system paths (absolute / `..` escape)
    return this.resolveRef(s);
  }

  /** The LIBRARY ID for an absolute path, when the catalog knows it — the ref the
   *  timeline should store and the model should see. Falls back to the portable
   *  project-relative form for media that was never catalogued. */
  async toMediaRef(absOrRef: string): Promise<string> {
    const s = normSep((absOrRef ?? "").trim());
    if (!s) return s;
    for (const c of await this.listClips()) {
      if (normSep(clipAbs(this.projectDir, c)) === s) return c.id;
    }
    return this.toRef(s);
  }

  /** Where a tool writes a regeneratable output (mirrors ProjectStore.artifact_path -> <internal>/cache/). */
  artifactPath(rel: string): string {
    return joinPath(this.projectDir, INTERNAL_DIR, "cache", rel);
  }

  /**
   * Like {@link artifactPath}, but first creates the output's parent directory
   * (mirrors ProjectStore.artifact_path, which mkdirs the parent). Real
   * ffmpeg/yt-dlp will not create missing output directories themselves.
   */
  async prepareArtifact(rel: string): Promise<string> {
    const full = this.artifactPath(rel);
    // Deleted project: hand back the path but DON'T recreate its dir tree (RF4) —
    // a following ffmpeg/whisper write into the missing dir simply fails.
    if (this.dead) return full;
    await this.fs.mkdir(full.slice(0, full.lastIndexOf("/")));
    return full;
  }

  /**
   * Absolute destination for a user-facing EXPORT deliverable. Mirrors other NLEs:
   * finished exports land in the OS Downloads dir, never inside the project
   * package (nothing tracks them). Falls back to a cache artifact when the fs
   * can't resolve Downloads (web/tests).
   */
  async exportPath(filename: string): Promise<string> {
    if (this.fs.downloadDir) {
      const dir = await this.fs.downloadDir();
      return joinPath(dir, filename);
    }
    return this.prepareArtifact(`exports/${filename}`);
  }

  exists(path: string): Promise<boolean> {
    return this.fs.exists(path);
  }
  readText(path: string): Promise<string> {
    return this.fs.readTextFile(path);
  }
  writeText(path: string, contents: string): Promise<void> {
    if (this.dead) return Promise.resolve(); // deleted project: drop the write (RF4)
    return this.fs.writeTextFile(path, contents);
  }
  /** Write text ATOMICALLY: write a temp sibling then rename it onto `path`
   *  (rename is atomic on one volume), so a concurrent reader never observes a
   *  half-written file — the race that made timeline.json reads intermittently
   *  fail with "could not read timeline.json". Falls back to a direct write when
   *  the fs has no rename (tests / older platforms). */
  writeTextAtomic(path: string, contents: string, guard?: () => boolean): Promise<boolean> {
    if (this.dead) return Promise.resolve(false); // deleted project: drop the write (RF4)
    return atomicWriteText(this.fs, path, contents, guard);
  }
  /** Read raw bytes from an absolute path. Rejects if the fs has no binary read.
   *
   *  CEILING: whole-file reads are for small sidecars (JSON, subtitles, a poster), never media.
   *  Bytes cross the webview IPC boundary on the way in, which measured 8.3x the file's size in
   *  peak RSS — a 428 MB clip cost 3.5 GB, and a 1 GB one takes a 16 GB machine down. Anything
   *  media-sized must go through `probeMedia` (native, streaming) or be copied by path.
   *
   *  This is a REFUSAL, not a warning, and it lives here rather than in the callers: the last
   *  fix taught each caller to avoid the hazard, and the hazard simply moved to a caller that
   *  had not learned. A loud error names the file and the limit; an OOM names nothing. */
  async readBytes(path: string): Promise<Uint8Array> {
    if (!this.fs.readBytes)
      return Promise.reject(new Error("this filesystem does not support binary reads"));
    const size = await this.byteSize(path);
    if (size !== null && size > MAX_HEAP_READ_BYTES) {
      throw new Error(
        `refusing to read ${mb(size)} into memory (${path}). The ceiling is ${mb(MAX_HEAP_READ_BYTES)}: ` +
          `reading a file this size through the webview costs several times its own size in RAM. ` +
          `Reference it by path, or stream it with probeMedia.`,
      );
    }
    return this.fs.readBytes(path);
  }

  /** The ONE deliberate exception to the ceiling: building a `.artdaddy.zip`, which needs whole
   *  files because the zip writer takes buffers. Callers MUST enforce a total budget — without
   *  streaming zip, a big project cannot be packed at all, and failing with a number beats
   *  taking the machine down. */
  readBytesForArchive(path: string): Promise<Uint8Array> {
    if (!this.fs.readBytes)
      return Promise.reject(new Error("this filesystem does not support binary reads"));
    return this.fs.readBytes(path);
  }

  /** Size in bytes without reading the file, or null when the platform can't say cheaply. */
  async byteSize(path: string): Promise<number | null> {
    if (!this.fs.stat) return null;
    const st = await this.fs.stat(path).catch(() => null);
    return st && !st.isDirectory ? st.size : null;
  }

  /** Is this path a directory? A stat where the platform has one; otherwise the weaker
   *  "listing it yields children", which cannot tell an empty folder from a file. */
  async isDirectory(path: string): Promise<boolean> {
    if (this.fs.stat) {
      const st = await this.fs.stat(path).catch(() => null);
      if (st) return st.isDirectory;
    }
    if (!this.fs.readDir) return false;
    const entries = await this.fs.readDir(path).catch(() => null);
    return !!entries && entries.length > 0;
  }
  /** Write raw bytes to an absolute path (creating parents). Rejects if unsupported. */
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    if (this.dead) return; // deleted project: drop the write (RF4)
    if (!this.fs.writeBytes) throw new Error("this filesystem does not support binary writes");
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) await this.fs.mkdir(parent);
    await this.fs.writeBytes(path, data);
  }
  /** Write raw bytes ATOMICALLY (stage a temp sibling, then rename onto `path`), so a crash
   *  mid-write never leaves a PARTIAL file at the final content-addressed library path (which
   *  exists() would then treat as a complete copy, so a re-import would skip the corrupt file).
   *  The staged commit for owned media bytes. Falls back to a direct write without rename (tests/web). */
  async writeBytesAtomic(path: string, data: Uint8Array): Promise<void> {
    if (this.dead) return; // deleted project: drop the write (RF4)
    if (!this.fs.writeBytes) throw new Error("this filesystem does not support binary writes");
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) await this.fs.mkdir(parent);
    await atomicWriteBytes(this.fs, path, data);
  }

  /** Spool a large file to disk a chunk at a time. Returns false when the fs cannot
   *  append, so the caller keeps its whole-buffer path for tests/web. */
  async appendBytes(path: string, data: Uint8Array): Promise<boolean> {
    if (this.dead) return false;
    if (!this.fs.appendBytes) return false;
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) await this.fs.mkdir(parent);
    await this.fs.appendBytes(path, data);
    return true;
  }

  /** Hash + measure a file on disk without loading it. Null when unsupported. */
  async probeMedia(path: string, headBytes = 64 * 1024): Promise<MediaProbe | null> {
    if (!this.fs.probeMedia) return null;
    return this.fs.probeMedia(path, headBytes);
  }

  /** True when a file can be imported without its bytes passing through the webview. */
  get canStreamImport(): boolean {
    return typeof this.fs.appendBytes === "function" && typeof this.fs.probeMedia === "function";
  }

  // ── narrow typed fs capabilities (features go through these, never `fs` directly) ──
  /** True when the fs can rename (atomic same-volume move); features fall back to a
   *  direct write when it can't (web / older platforms). */
  get canRename(): boolean {
    return typeof this.fs.rename === "function";
  }
  /** True when the fs supports the directory listing + binary read a library rescan needs. */
  get canRescanLibrary(): boolean {
    return !!(this.fs.readDir && this.fs.readBytes);
  }
  /** True when the fs can write raw bytes (a tool skips an optional cache write without it). */
  get canWriteBytes(): boolean {
    return typeof this.fs.writeBytes === "function";
  }
  /** Delete a file, best-effort (no-op when the fs has no remove). NOT dead-guarded:
   *  the project/library DELETE paths must still be able to clean up. */
  async remove(path: string): Promise<void> {
    await this.fs.remove?.(path);
  }
  /** Atomically rename within one volume. Rejects if unsupported — guard with {@link canRename}. */
  async rename(from: string, to: string): Promise<void> {
    if (!this.fs.rename) throw new Error("this filesystem does not support rename");
    await this.fs.rename(from, to);
  }

  /** Copy a file, creating the destination's parent. Used to pull a referenced-in-place
   *  asset into the project so it stops depending on where the original lives. */
  async copyFile(src: string, dst: string): Promise<void> {
    if (this.dead) return;
    if (!this.fs.copyFile) throw new Error("this filesystem does not support copy");
    const parent = dst.slice(0, dst.lastIndexOf("/"));
    if (parent) await this.fs.mkdir(parent);
    await this.fs.copyFile(src, dst);
  }
  /** List a directory's immediate entries (empty when the fs can't list). */
  readDir(dir: string): Promise<DirEntry[]> {
    return this.fs.readDir ? this.fs.readDir(dir) : Promise.resolve([]);
  }
  /** OS Downloads dir, or null when the fs can't resolve it (web / tests). */
  downloadDir(): Promise<string | null> {
    return this.fs.downloadDir ? this.fs.downloadDir() : Promise.resolve(null);
  }
  /** Read + parse a JSON file under the project, recovering `fallback` on a missing/corrupt
   *  file (wraps {@link readJsonOrRecover} so callers never touch the raw fs). */
  readJson<T>(path: string, fallback: T): Promise<T> {
    return readJsonOrRecover<T>(this.fs, path, fallback);
  }
  /** The raw filesystem, exposed SOLELY for the ProjectRegistry bootstrap — a persistence class that
   *  needs a full FsLike for global-registry + project-dir ops and lives in a module this store can't
   *  import back without a cycle. Feature / tool code MUST use the typed methods above, never this.
   *  TODO: extract ProjectRegistry to its own module so the store can own it and this can go away. */
  fsForProjectRegistry(): FsLike {
    return this.fs;
  }

  /** Resolve a project-relative (or in-project absolute) path, constrained to
   *  the project dir. Returns null if it escapes (`..`, or outside the root). */
  resolveWritable(ref: string): string | null {
    const s = normSep((ref ?? "").trim());
    if (!s || s.split("/").includes("..")) return null;
    const full = isAbsolute(s) ? s : joinPath(this.projectDir, s);
    const root = normSep(this.projectDir).replace(/\/+$/, "");
    return full === root || full.startsWith(`${root}/`) ? full : null;
  }

  /** Portable reference for a clip/media source: strips the project dir from an
   *  in-project ABSOLUTE path so the stored source (and everything the model sees
   *  via get_timeline) is a project-relative ref (e.g. "library/<id>.<ext>") —
   *  never a full system path. Leaves refs/relative paths + out-of-project
   *  absolutes unchanged. Resolve back to absolute with resolveRef(). */
  toRef(absOrRef: string): string {
    const s = normSep((absOrRef ?? "").trim());
    if (!s || !isAbsolute(s)) return s;
    const root = normSep(this.projectDir).replace(/\/+$/, "");
    return s === root || s.startsWith(`${root}/`) ? s.slice(root.length + 1) : s;
  }

  /** Write a text file at an absolute in-project path, creating its parent.
   *  ATOMIC (temp + rename) so a crash mid-write can't corrupt/truncate the file
   *  — covers the session transcript, style.md, and text artifacts. An optional
   *  `guard` (re-checked right before the atomic rename) abandons the write if the
   *  owning session closed mid-write; returns whether the write committed. */
  async writeProjectText(full: string, contents: string, guard?: () => boolean): Promise<boolean> {
    if (this.dead) return false; // deleted project: drop the write (RF4)
    const parent = full.slice(0, full.lastIndexOf("/"));
    if (parent) await this.fs.mkdir(parent);
    return atomicWriteText(this.fs, full, contents, guard);
  }
}
