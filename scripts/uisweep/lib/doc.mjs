// The PERSISTED project document is the artifact every scenario asserts against.
//
// A component test can only see the DOM, which is exactly why 2592 of them stayed green
// while a hand-drag was writing clips that pointed past the end of their own media. What
// the user keeps is the file on disk; that is what a UI test must check.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const PROJECTS = path.join(
  process.env.APPDATA ?? path.join(process.env.HOME ?? "", ".config"),
  "ArtDaddy",
  "projects",
);

export function projectDir(id) {
  return path.join(PROJECTS, id);
}

/** The most recently modified project — how the harness finds the one it just created. */
export function newestProjectId() {
  const dirs = readdirSync(PROJECTS).filter((d) => statSync(path.join(PROJECTS, d)).isDirectory());
  if (!dirs.length) throw new Error(`no projects under ${PROJECTS}`);
  return dirs
    .map((d) => ({ d, t: statSync(path.join(PROJECTS, d)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].d;
}

export function timelinePath(id) {
  return path.join(projectDir(id), "internals", "timeline.json");
}

/** The saved timeline, or null before the first save. */
export function readDoc(id) {
  const p = timelinePath(id);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null; // mid-write; the caller polls
  }
}

/** The library manifest. The panel LABELS each item with its staged path basename
 *  (`media_<id>.<ext>`), not the file you imported, so a scenario has to map through this
 *  to find the row it means. */
export function readLibrary(id) {
  const p = path.join(projectDir(id), "internals", "library.json");
  if (!existsSync(p)) return { clips: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { clips: [] };
  }
}

/** Displayed label for the library row holding `filename`, or null. */
export function libraryLabel(id, filename) {
  const hit = (readLibrary(id).clips ?? []).find((c) => c.filename === filename);
  return hit ? String(hit.path).split("/").pop() : null;
}

/** Project-relative path the library hands to a drop (`application/x-artdaddy-source`). */
export function libraryPath(id, filename) {
  const hit = (readLibrary(id).clips ?? []).find((c) => c.filename === filename);
  return hit ? String(hit.path) : null;
}

/** Wait until the document CHANGES from `from`, or time out. Edits are debounced through
 *  the project lock, so a scenario that reads immediately reads the previous state. */
export async function waitForChange(id, from, ms = 6000) {
  const start = Date.now();
  const before = JSON.stringify(from ?? null);
  for (;;) {
    const now = readDoc(id);
    if (now && JSON.stringify(now) !== before) return now;
    if (Date.now() - start > ms) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Settle: the document has stopped changing for `quiet` ms. */
export async function settled(id, quiet = 500, ms = 8000) {
  const start = Date.now();
  let last = JSON.stringify(readDoc(id));
  let since = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    const now = JSON.stringify(readDoc(id));
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quiet) {
      return readDoc(id);
    }
    if (Date.now() - start > ms) return readDoc(id);
  }
}

// ---- comparable views -------------------------------------------------------

/** `[start, end)` spans per track id — the shape most structural assertions want. */
export function spans(doc) {
  const out = {};
  for (const t of doc?.tracks ?? []) {
    out[String(t.id)] = (t.clips ?? [])
      .map((c) => [Number(c.timeline_in) || 0, Number(c.timeline_out) || 0])
      .sort((a, b) => a[0] - b[0]);
  }
  return out;
}

/** Every clip keyed by id, with only the fields a structural assertion cares about. */
export function clips(doc) {
  const out = {};
  for (const t of doc?.tracks ?? []) {
    for (const c of t.clips ?? []) {
      out[String(c.id)] = {
        track: String(t.id),
        kind: c.kind,
        tin: Number(c.timeline_in) || 0,
        tout: Number(c.timeline_out) || 0,
        sin: typeof c.source_in === "number" ? c.source_in : null,
        sout: typeof c.source_out === "number" ? c.source_out : null,
        speed: c.speed ?? 1,
      };
    }
  }
  return out;
}

/** Stable string for exact before/after comparison (undo must restore EXACTLY). */
export function fingerprint(doc) {
  return JSON.stringify(doc);
}
