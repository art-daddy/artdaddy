// Scrub absolute filesystem paths out of a tool RESULT before the model sees it (Step 9).
//
// Linked local media (import_media `source.path`) records the user's ABSOLUTE source path in the
// catalog, and project-owned files resolve under the absolute project dir. Those paths are the user's
// PRIVATE directory structure (a privacy + path-injection concern), and the model addresses media only
// by `media_ref` / `clip_id` — it never needs a raw path. So every absolute path in a tool result is
// replaced by its BASENAME (which hides the directory yet stays a resolvable filename ref); `media_id`s
// and project-relative refs (`library/<id>`) are NOT absolute and pass through untouched.
//
// Cross-cutting: this runs at the ONE boundary every tool result crosses on its way to the model
// (agent/loop `runAndAdvance`), so no tool — present or future — can leak a path, and it catches paths
// whether they are a whole field value OR embedded in an error string.

// A Windows drive path (`C:\…` / `D:/…`, guarded by a lookbehind so the `s:/` in `https://` is NOT
// matched), a UNC path (`\\host\share\…`), or a POSIX absolute path under a KNOWN root (`/Users/…`,
// `/home/…`, …). Restricting POSIX to known roots avoids mangling URLs (`https://…/path`) and prose
// (`/a/b flag`), which a blanket `/x/y` pattern would wreck.
const ABS_PATH_G =
  /(?<![a-zA-Z:])[a-zA-Z]:[\\/][^\s"'<>|]*|\\\\[^\s"'<>|]+|\/(?:Users|home|root|var|tmp|private|Volumes|mnt|media|opt|srv|data|etc|Applications|Library)\/[^\s"'<>|]*/g;

/** Last path segment of `p` (directory components + any trailing separator dropped). */
function basename(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || p
  );
}

/** Replace every absolute path inside a string with its basename (whole-value OR embedded). Uses
 *  `String.replace` with the global regex, which scans from 0 and resets lastIndex — safe to reuse. */
function scrubString(s: string): string {
  return s.replace(ABS_PATH_G, (m) => basename(m));
}

function scrubValue(v: unknown, seen: WeakSet<object>): unknown {
  if (typeof v === "string") return scrubString(v);
  if (v && typeof v === "object") {
    if (seen.has(v)) return v; // guard a (defensive) cyclic result — leave it as-is
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => scrubValue(x, seen));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = scrubValue(val, seen);
    return out;
  }
  return v;
}

/** Deep copy of `result` with every absolute filesystem path replaced by its basename. Media refs +
 *  project-relative paths pass through. Applied at the model boundary so no tool result leaks a path. */
export function scrubAbsolutePaths<T>(result: T): T {
  return scrubValue(result, new WeakSet()) as T;
}
