// Client twin of the Python `data_root()` / `projects_root()` (project_store.py).
//
// The desktop client owns projects locally; to LIST them with nothing open (and
// to stay CO-LOCATED with the local-dev server's dirs), it resolves the SAME
// app-data root the server does. Tauri's `dataDir()` matches Python's base on
// every OS — Windows `%APPDATA%` (Roaming), macOS `~/Library/Application
// Support`, Linux `$XDG_DATA_HOME` | `~/.local/share` — so the root is just
// `<dataDir>/<identity.dataFolder>`. That folder name is the app's identity, not
// its brand: `src-tauri/src/lib.rs` moves the old one into place at startup, and
// the Python twin must be changed in the same commit or the two roots diverge.
// Honors the same `*_DATA_DIR` / `*_PROJECTS_DIR` dev overrides as the server
// (read via a Tauri command; absent -> default).
import { IDENTITY } from "../brand";
import { isAbsolutePath, joinPath } from "./store";

async function envOverride(name: string): Promise<string> {
  // Runtime env isn't visible to the webview JS; a tiny Rust `get_env` command
  // exposes the dev overrides. Best-effort: any failure -> no override.
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const v = await invoke<string | null>("get_env", { name });
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

/** `<appData>/<dataFolder>` (or the `*_DATA_DIR` override). The client's app-data root. */
export async function dataRoot(): Promise<string> {
  const override = await envOverride(`${IDENTITY.envPrefix}_DATA_DIR`);
  if (override) return override;
  const { dataDir } = await import("@tauri-apps/api/path");
  try {
    return joinPath(await dataDir(), IDENTITY.dataFolder);
  } catch (e) {
    // Reached an external agent once as the raw "Cannot read properties of undefined (reading
    // 'invoke')" — the Tauri bridge missing, said in a way that names neither the app nor the
    // cause. Not reproducible since; whatever the trigger, this is the one place every
    // project-registry path funnels through, so it is where the message has to be legible.
    throw new Error(
      `could not locate the app data folder (the desktop bridge is unavailable): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Directory holding all project dirs (or the `*_PROJECTS_DIR` override). */
export async function projectsRoot(): Promise<string> {
  const override = await envOverride(`${IDENTITY.envPrefix}_PROJECTS_DIR`);
  if (override) return override;
  return joinPath(await dataRoot(), "projects");
}

// Windows reserves these device names case-insensitively (con, prn, aux, nul,
// com0-9, lpt0-9) -- a file/dir named one of them doesn't name a real path.
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A project id must be a strict lowercase-ASCII slug: `[a-z0-9_]`, 1-64 chars,
 *  and not a Windows reserved DEVICE name. This is exactly the shape
 *  `newProjectId` generates (`slugify(name)_<hex6>`), so it accepts every real id
 *  while rejecting anything a crafted route param could smuggle in. The charset
 *  ALONE guarantees `joinPath(projectsRoot, id)` is a DIRECT child of the projects
 *  root (no separators / `.` / `..` can appear), and it closes the portability
 *  traps a laxer check let through (RF9): uppercase (collides on a case-insensitive
 *  filesystem), a trailing dot/space, Unicode, and the reserved device names.
 *  Single source of truth for the containment invariant, shared by the UI-side
 *  path builders (editor / host / desktop store) and the tools-side
 *  `ProjectRegistry`. Mirrors other NLEs' identity-decoupled-from-location id
 *  validation, where every id→path hop is guarded. */
export function isSafeProjectId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length <= 64 &&
    /^[a-z0-9_]+$/.test(id) &&
    !RESERVED_DEVICE.test(id)
  );
}

/** The one place UI-side code turns a project id into an on-disk path. Rejects
 *  any id that isn't a safe single segment, so a crafted route param
 *  (`/p/..%2F..%2Fevil`) can't traverse out of the projects root. Throws on an
 *  unsafe id; callers surface it (editor `load` error) or fall back (null store). */
export async function safeProjectDir(id: string): Promise<string> {
  if (!isSafeProjectId(id)) throw new Error(`unsafe project id: ${String(id)}`);
  return joinPath(await projectsRoot(), id);
}

/** The recents registry file: `<dataRoot>/projects.json`. */
export async function registryPath(): Promise<string> {
  return joinPath(await dataRoot(), "projects.json");
}

/** Dir -> id for projects whose folder is NOT named after their id, i.e. every project
 *  moved by Save As. Recorded as a side effect of {@link projectDirFor}, the one hop that
 *  resolves an id, so it cannot describe a project nobody has opened. Read only by
 *  `openDocumentByDir`, whose basename derivation is exact for the default layout. */
const idByDir = new Map<string, string>();

function normDir(d: string): string {
  return d.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The id bound to `dir`, or "" when the default layout already answers it. */
export function boundProjectId(dir: string): string {
  return idByDir.get(normDir(dir)) ?? "";
}

/** Where project `id` ACTUALLY lives — the UI-side twin of `ProjectRegistry.dirFor`.
 *  The recents entry's recorded path wins (Save As moves a project out of the app
 *  folder); a project that never moved falls back to the default location.
 *
 *  The id is validated FIRST via `safeProjectDir`, so a crafted route param is refused
 *  before the registry is consulted, and a recorded path is honoured only when absolute. */
export async function projectDirFor(id: string): Promise<string> {
  const fallback = await safeProjectDir(id);
  let dir = fallback;
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const reg = JSON.parse(await readTextFile(await registryPath())) as {
      projects?: { id?: unknown; path?: unknown }[];
    };
    const p = reg.projects?.find((e) => e.id === id)?.path;
    if (typeof p === "string" && isAbsolutePath(p)) dir = normDir(p);
  } catch {
    // No registry yet, unreadable, or no desktop fs: the default location is the answer.
  }
  if (dir !== fallback) idByDir.set(normDir(dir), id);
  else idByDir.delete(normDir(dir));
  return dir;
}
