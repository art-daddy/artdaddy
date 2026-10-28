#!/usr/bin/env node
// Move the pinned yt-dlp (scripts/sidecarStaging.mjs) to a release of upstream, or say how far behind
// the pin is. The pin exists so a release ships a yt-dlp somebody chose; this is how it is chosen.
//
//   node scripts/bumpYtDlp.mjs --check      the pin against upstream's latest stable (exit 2 when behind)
//   node scripts/bumpYtDlp.mjs [<tag>]      pin <tag>, default the latest stable release
//
// The digests come from the release's own SHA2-256SUMS, and every asset is then downloaded and hashed
// before anything is written: a checksum file that disagrees with the bytes it describes is refused.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { matchesSha256, parseSha256Sums, rewriteYtDlpPin, YT_DLP_PIN } from "./sidecarStaging.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const stagingFile = join(here, "sidecarStaging.mjs");
const API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

async function get(url, as) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "artdaddy-bump-yt-dlp",
      ...(token && url.startsWith("https://api.github.com/") ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return as === "bytes" ? Buffer.from(await response.arrayBuffer()) : as === "text" ? response.text() : response.json();
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const requested = args.find((a) => !a.startsWith("--"));

const release = await get(requested ? `${API}/tags/${requested}` : `${API}/latest`);
if (release.draft || release.prerelease) throw new Error(`${release.tag_name} is not a stable release`);
const latest = release.tag_name;
console.log(`pinned ${YT_DLP_PIN.version}; ${requested ? "requested" : "latest stable"} ${latest} (${release.published_at})`);

if (check) {
  if (latest === YT_DLP_PIN.version) console.log("the pin is current.");
  else console.log("the pin is behind: run `npm run bump:yt-dlp`, then the release gate, before shipping.");
  process.exit(latest === YT_DLP_PIN.version ? 0 : 2);
}
if (latest === YT_DLP_PIN.version) {
  console.log("nothing to do.");
  process.exit(0);
}

const sumsAsset = release.assets.find((a) => a.name === "SHA2-256SUMS");
if (!sumsAsset) throw new Error(`${latest} publishes no SHA2-256SUMS`);
const sums = parseSha256Sums(await get(sumsAsset.browser_download_url, "text"));

const source = readFileSync(stagingFile, "utf8");
const updated = rewriteYtDlpPin(source, latest, sums);

for (const { name } of Object.values(YT_DLP_PIN.assets)) {
  const sha256 = sums[name];
  const bytes = await get(`https://github.com/yt-dlp/yt-dlp/releases/download/${latest}/${name}`, "bytes");
  if (!matchesSha256(bytes, sha256)) throw new Error(`${name} does not hash to the ${latest} checksum ${sha256}`);
  console.log(`  ${name}: ${bytes.length} bytes, sha256 ${sha256} (matches the bytes)`);
}

writeFileSync(stagingFile, updated);
console.log(`pinned yt-dlp ${latest} in scripts/sidecarStaging.mjs. Commit it, and run the release gate.`);
