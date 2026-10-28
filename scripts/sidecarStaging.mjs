// Decisions taken out of fetch-sidecars.mjs so they can be tested: that script calls
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

/** The yt-dlp each platform ships. It used to be whatever `releases/latest` served on the day of the
 *  build, so a release could carry a downloader nobody had looked at, and one commit built twice a day
 *  apart shipped two different ones. A pin is bumped on purpose with `npm run bump:yt-dlp`, which
 *  rewrites the block below from the upstream release's own SHA2-256SUMS; the release gate then tests
 *  the new build like any other change.
 *
 *  yt-dlp breaks when a site changes, so a pin nobody bumps is a download feature that quietly stops
 *  working. `npm run bump:yt-dlp -- --check` says how far behind it is; run it before every release.
 *  Assets: the Windows and Linux builds are x64, the macOS one is a universal binary. */
// <yt-dlp-pin>
export const YT_DLP_PIN = {
  version: "2026.10.26",
  assets: {
    win: { name: "yt-dlp.exe", sha256: "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d" },
    mac: { name: "yt-dlp_macos", sha256: "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa" },
    linux: { name: "yt-dlp_linux", sha256: "767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795" },
  },
};
// </yt-dlp-pin>

/** The pinned yt-dlp for a platform ("win" | "mac" | "linux"): its asset, its tag-addressed URL (a tag
 *  is not "latest", and it is what the SHA-256 is checked against) and the digest it must have. */
export function ytDlpPin(osName, pin = YT_DLP_PIN) {
  const asset = pin.assets[osName];
  if (!asset) throw new Error(`no pinned yt-dlp for ${osName}`);
  return {
    version: pin.version,
    name: asset.name,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${pin.version}/${asset.name}`,
    sha256: asset.sha256,
  };
}

/** Whether `bytes` are exactly the build a pin names (the staged file, not the download). */
export function matchesSha256(bytes, sha256) {
  return createHash("sha256").update(bytes).digest("hex") === sha256;
}

/** yt-dlp's `SHA2-256SUMS` ("<64 hex>  <asset>", one per line, `*` before the name for binary mode)
 *  as `{ asset: sha256 }`. Lines that are not a checksum are ignored, never guessed at. */
export function parseSha256Sums(text) {
  const sums = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line);
    if (m) sums[m[2]] = m[1].toLowerCase();
  }
  return sums;
}

/** `source` with its yt-dlp pin block replaced by the one for `version`, taking each platform's digest
 *  from `sums` (a `parseSha256Sums` result). Everything outside the markers is returned untouched,
 *  line endings included, and a release that does not list one of the three assets is refused. */
export function rewriteYtDlpPin(source, version, sums) {
  if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(version)) throw new Error(`not a yt-dlp release tag: ${version}`);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const entry = (os) => {
    const { name } = YT_DLP_PIN.assets[os];
    const sha256 = sums[name];
    if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw new Error(`the ${version} checksums do not list ${name}`);
    return `    ${os}: { name: "${name}", sha256: "${sha256}" },`;
  };
  const block = [
    "// <yt-dlp-pin>",
    "export const YT_DLP_PIN = {",
    `  version: "${version}",`,
    "  assets: {",
    entry("win"),
    entry("mac"),
    entry("linux"),
    "  },",
    "};",
    "// </yt-dlp-pin>",
  ].join(eol);
  const markers = /\/\/ <yt-dlp-pin>[\s\S]*?\/\/ <\/yt-dlp-pin>/;
  if (!markers.test(source)) throw new Error("the yt-dlp pin markers are missing");
  return source.replace(markers, () => block);
}

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

/** An HTTP answer that is not a success, as an error that carries its status: a retry has to tell a
 *  hiccup (503) from an answer that will not change (404). The message is the one the log always showed. */
export function httpFailure(status, url) {
  return Object.assign(new Error(`HTTP ${status} for ${url}`), { status });
}

/** Answers that mean "the server or something in front of it stumbled", not "this is wrong". A 404 or
 *  403 on a pinned URL is left out on purpose: asking again cannot fix it. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Socket and DNS failures Node reports when a connection dies or never forms. */
const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Reasons a rejected fetch gives that a second try cannot fix: a certificate that does not verify
 *  (retrying must never be how that gets through) and a URL that does not parse. */
const PERMANENT_CODE = /^(CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_CERT|ERR_INVALID_|ERR_UNESCAPED|UND_ERR_INVALID)/;

const isObject = (value) => typeof value === "object" && value !== null;

/** `error` and the chain of `.cause`s behind it. Node's fetch hides the real reason one level down. */
function causeChain(error) {
  const chain = [];
  for (let e = error; isObject(e) && chain.length < 5; e = e.cause) chain.push(e);
  return chain;
}

/** Whether a failed download is worth another try: a dropped connection, a stalled body or a 5xx.
 *  A wrong answer is not: a 404, a certificate that does not verify, bytes that do not match the pin. */
export function isTransientDownloadFailure(error) {
  if (!isObject(error)) return false;
  if (Number.isInteger(error.status)) return RETRYABLE_STATUS.has(error.status);
  const codes = causeChain(error)
    .map((e) => e.code)
    .filter((code) => typeof code === "string");
  if (codes.some((code) => PERMANENT_CODE.test(code))) return false;
  if (codes.some((code) => TRANSPORT_CODES.has(code))) return true;
  // Node's fetch rejects every network failure with TypeError("fetch failed"), and a body that dies
  // half-way with TypeError("terminated"); the reason, when it gives one, is on .cause.
  return error.name === "TypeError" && /^(fetch failed|terminated)$/.test(String(error.message));
}

/** A failed download in words that name the real reason: Node's own message is just "fetch failed". */
export function describeDownloadFailure(error) {
  const message = isObject(error) && typeof error.message === "string" ? error.message : String(error);
  const code = causeChain(error)
    .map((e) => e.code)
    .find((c) => typeof c === "string");
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/** Runs `attempt` and, when it fails in a way `isTransientDownloadFailure` calls a hiccup, tries it
 *  again after each of `delaysMs`. Anything else is thrown at once, untouched. When the tries run out
 *  the error says how many there were and why the last one failed. */
export async function withDownloadRetries(
  attempt,
  { delaysMs = [2_000, 6_000], sleep = (ms) => new Promise((done) => setTimeout(done, ms)), onRetry = () => {} } = {},
) {
  for (let failed = 0; ; failed++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransientDownloadFailure(error)) throw error;
      if (failed >= delaysMs.length)
        throw new Error(`${describeDownloadFailure(error)}; gave up after ${failed + 1} attempts`, { cause: error });
      onRetry({ failed: failed + 1, of: delaysMs.length + 1, error, waitMs: delaysMs[failed] });
      await sleep(delaysMs[failed]);
    }
  }
}

/** The pinned bytes of `pin.url`: fetched with a few tries for a hiccup, then checked ONCE, outside the
 *  tries. Bytes that do not match the pin are a different file, not a bad connection: fetching again
 *  must never be how they get accepted, and a retry must never make that failure look transient. */
export async function downloadVerified(pin, fetchBytes, options) {
  const bytes = await withDownloadRetries(() => fetchBytes(pin.url), options);
  verifySha256(bytes, pin.sha256, pin.url);
  return bytes;
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
