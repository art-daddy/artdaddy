// The update feed (https://artdaddy.app/updates/latest.json, the endpoint compiled into every app) as a release
// writes it. The live file is written by the landing site's repository (its scripts/add-platform-update.mjs); the
// update canary writes a staged copy of the same format for a candidate release (scripts/qa/stagedFeed.mjs), so a
// candidate can be installed on every system before the live feed offers it to anyone. scripts/updateFeed.test.mjs
// holds both to the bytes of the live feed of 26 Nov 2026, and src-tauri/tests/update_feed.rs holds the app's
// reader to the same bytes.

export const FEED_URL = "https://artdaddy.app/updates/latest.json";

/** Each platform key an installed app looks itself up by, and the version-less asset each release uploads. The order
 *  is the order the live feed lists them in. */
export const PLATFORMS = Object.freeze({
  "windows-x86_64": "ArtDaddy-windows-x64-setup.exe",
  "darwin-aarch64": "ArtDaddy-macos-arm64.app.tar.gz",
  "linux-x86_64": "ArtDaddy-linux-x86_64.AppImage",
});

export const isVersion = (version) =>
  typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);

/** `a` is a later x.y.z than `b`. */
export function newer(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export const assetUrl = (repository, version, asset) =>
  `https://github.com/${repository}/releases/download/v${version}/${asset}`;

/**
 * The feed's text, byte for byte as the landing site's writer leaves it: two-space JSON with a final newline and no
 * byte-order mark (with one, no app can read the feed), the keys in the live feed's order, and for every platform the
 * signature of its asset and that asset's address in this very version's release.
 */
export function feedText({ repository, version, notes, pubDate, signatures }) {
  if (!isVersion(version))
    throw new Error(`the feed's version must be x.y.z, not ${JSON.stringify(version)}`);
  if (Number.isNaN(Date.parse(pubDate)) || !/T\d{2}:\d{2}:\d{2}/.test(pubDate)) {
    throw new Error(
      `the feed's date must carry a time, or no app can read the feed: ${JSON.stringify(pubDate)}`,
    );
  }
  const platforms = {};
  for (const [platform, asset] of Object.entries(PLATFORMS)) {
    const signature = typeof signatures?.[platform] === "string" ? signatures[platform].trim() : "";
    if (!signature.startsWith("dW50cnVzdGVk")) {
      throw new Error(
        `no minisign signature for ${platform} (its .sig, as tauri signer writes it)`,
      );
    }
    platforms[platform] = { signature, url: assetUrl(repository, version, asset) };
  }
  return `${JSON.stringify({ version, notes, pub_date: pubDate, platforms }, null, 2)}\n`;
}

/**
 * The release an installed app most likely runs before it updates to `before`: the latest published release older than
 * it. A draft or a pre-release never reached anyone (a candidate is a pre-release until the switch). Null when none.
 */
export function previousRelease(releases, before) {
  const shipped = releases
    .filter(
      (release) =>
        !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name ?? ""),
    )
    .map((release) => release.tag_name.slice(1))
    .filter((version) => newer(before, version));
  return shipped.reduce(
    (best, version) => (best === null || newer(version, best) ? version : best),
    null,
  );
}
