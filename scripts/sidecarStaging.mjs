// Two decisions taken out of fetch-sidecars.mjs so they can be tested: that script calls
// main() at import, so nothing in it can be imported without downloading sidecars.

import { createHash } from "node:crypto";

/** The ffmpeg each platform ships. It used to be whatever "latest" served on the day of the build,
 *  so two releases a day apart shipped different encoders. A pin is bumped on purpose: change the
 *  URL, its SHA-256 and the version, and the release gate tests the new build like any change.
 *
 *  Windows and Linux: BtbN's month-end build of master, which BtbN keeps for two years (daily
 *  builds are gone after 14 days). macOS: martin-riedl's release build, which every mac release
 *  has shipped; its builds are kept back to 2022. The two are not the same version today. */
export const FFMPEG_PINS = {
  win: {
    version: "N-127021-ge0c94b2d1c",
    archives: [
      {
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-N-127021-ge0c94b2d1c-win64-gpl.zip",
        sha256: "85c4a4636b93d681a07588ffa6f1d8f5c064d9c3fb0622066662906b6fd718a1",
      },
    ],
  },
  linux: {
    version: "N-127021-ge0c94b2d1c",
    archives: [
      {
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-N-127021-ge0c94b2d1c-linux64-gpl.tar.xz",
        sha256: "3a2a94e704752287833604501a79505c2319ad1d8b2f5577c63f2b1b7a6f2b66",
      },
    ],
  },
  "mac-arm64": {
    version: "9.0.2",
    archives: [
      {
        name: "ffmpeg",
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
        sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
      },
      {
        name: "ffprobe",
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
        sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
      },
    ],
  },
  "mac-amd64": {
    version: "9.0.2",
    archives: [
      {
        name: "ffmpeg",
        url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip",
        sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
      },
      {
        name: "ffprobe",
        url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffprobe.zip",
        sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd",
      },
    ],
  },
};

/** The pinned ffmpeg for a Rust target triple. */
export function ffmpegPin(triple) {
  const key = triple.includes("windows")
    ? triple.startsWith("x86_64")
      ? "win"
      : null
    : triple.includes("darwin")
      ? triple.startsWith("aarch64")
        ? "mac-arm64"
        : triple.startsWith("x86_64")
          ? "mac-amd64"
          : null
      : triple.startsWith("x86_64") && triple.includes("linux")
        ? "linux"
        : null;
  if (!key) throw new Error(`no pinned ffmpeg for ${triple}`);
  return FFMPEG_PINS[key];
}

/** Whether `-version` output comes from the pinned build: its version, or its version plus the
 *  builder's suffix ("N-127021-ge0c94b2d1c-20260930", "9.0.2-https://www.martin-riedl.de"). */
export function isPinnedBuild(versionOutput, pin) {
  const m = /^ff(?:mpeg|probe) version (\S+)/m.exec(String(versionOutput));
  return !!m && (m[1] === pin.version || m[1].startsWith(`${pin.version}-`));
}

/** Throws unless `bytes` are exactly what the pin names. */
export function verifySha256(bytes, sha256, url) {
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256)
    throw new Error(`${url} is not the pinned build: expected sha256 ${sha256}, got ${got}`);
}

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
