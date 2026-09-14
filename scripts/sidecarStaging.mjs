// Two decisions taken out of fetch-sidecars.mjs so they can be tested: that script calls
// main() at import, so nothing in it can be imported without downloading sidecars.

/** Staged files that the incoming set does not contain, i.e. leftovers from an earlier fetch.
 *
 *  This matters more than the disk space. resources/whisper is a LOAD PATH, not an archive:
 *  ggml scans it for ggml-*.dll and loads what it finds, so a backend left behind by a
 *  previous build is a candidate for loading beside the new set, not merely dead weight. The
 *  Vulkan switch replaced a 14-file dynamic set with a different 14, and SDL2.dll survived
 *  from the older zip purely because copying never deletes.
 *
 *  Compared case-insensitively: this names files on Windows, where GGML.dll and ggml.dll are
 *  the same file, and a case-sensitive answer would "prune" a file that is still in the set. */
export function stalePaths(existing, incoming) {
  const keep = new Set(incoming.map((n) => n.toLowerCase()));
  return existing.filter((n) => !keep.has(n.toLowerCase()));
}

/** Why the Vulkan release could not be fetched, in words a developer can act on.
 *
 *  The fallback is CPU-only whisper, which transcribes correctly and merely takes minutes
 *  instead of seconds — so the message is the ONLY signal that anything is wrong, and
 *  "install gh, or log in, or re-run the workflow" makes the reader check three things when
 *  exactly one of them is true. */
export function describeGhFailure({ ghInstalled, stderr = "" }) {
  if (!ghInstalled) return "the GitHub CLI (gh) is not installed — install it, then `gh auth login`";
  const s = String(stderr);
  if (/gh auth login|not logged in|authentication|Bad credentials|HTTP 401/i.test(s))
    return "the GitHub CLI is not authenticated — run `gh auth login`";
  // A private repo answers 404 rather than 403 to an unauthorised caller, so "not found" can
  // mean either. Say both rather than sending someone to re-run a workflow that already ran.
  if (/release not found|no releases|HTTP 404|not found/i.test(s))
    return "that release or asset does not exist, or this account cannot see it — re-run the 'whisper-cli (Windows, Vulkan)' workflow with publish=true";
  if (/rate limit/i.test(s)) return "the GitHub API rate limit is exhausted — retry later";
  const first = s.split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : "gh failed without saying why";
}
