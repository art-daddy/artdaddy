import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// A clip's `media_ref` is a BARE LIBRARY ID — no extension. Any module that classifies
// media by matching a file-extension regex therefore CANNOT be fed a clip ref: it will
// silently take the "not media" branch and do nothing. That failure is invisible, and it
// has now shipped three times from the same blind spot:
//   previewWorker  -> built no decoder      -> black frame
//   audioEngine    -> skipped every clip    -> silence
//   SourceMonitor  -> classified as "other"
// Each was found by hand AFTER a user hit it, because searching for the helper
// (`clipKind(`) can never find a consumer that rolled its own regex.
//
// So this pins the regexes themselves. A module may own a media-extension regex ONLY if
// it is fed a real FILENAME or a RESOLVED PATH. Adding one to a module that sees clip
// refs fails here, and the fix is `clipKind(clip)` — not an entry in this list.
const SRC = join(__dirname, "..");

// The extension lists themselves now live in ONE place, media/formats.ts, and
// media/formats.test.ts fails if any module grows a rival list in any syntax. Every module
// that used to carry its own regex now calls kindOf(), so this list is empty — and that is
// the point: the next one to appear has to justify itself here, with a note saying it is fed
// a real filename or resolved path rather than a clip's bare `media_ref`.
const ALLOWED = new Map<string, string>([]);

const MEDIA_EXT_RE = /\/\\\.\((?=[^)]*\b(?:mp4|mov|webm|m4v|png|jpe\?g|mp3|wav|m4a)\b)[^)]*\)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|\.e2e\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("media-kind classification", () => {
  it("only allow-listed modules classify media by file extension", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      if (!MEDIA_EXT_RE.test(readFileSync(file, "utf8"))) continue;
      if (!ALLOWED.has(rel)) offenders.push(rel);
    }
    expect(
      offenders,
      `These modules classify media by file EXTENSION. If any of them is handed a clip's ` +
        `media_ref (a bare library id) it will silently do nothing. Use clipKind(clip), or ` +
        `resolve the ref to a path first — only then add it to ALLOWED with the reason.`,
    ).toEqual([]);
  });

  it("the allow-list has no stale entries", () => {
    const stale = [...ALLOWED.keys()].filter((rel) => {
      try {
        return !MEDIA_EXT_RE.test(readFileSync(join(SRC, rel), "utf8"));
      } catch {
        return true; // file gone
      }
    });
    expect(stale, "allow-listed files that no longer classify by extension").toEqual([]);
  });
});
