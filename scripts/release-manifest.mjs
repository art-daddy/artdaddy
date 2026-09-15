#!/usr/bin/env node
// Writes the auto-update manifest that artdaddy.app/updates/latest.json serves.
//
//   node scripts/release-manifest.mjs <version> <path-to-.exe.sig> <out.json> ["notes"]
//
// Why this is a script and not a few lines of PowerShell in a runbook: the two ways this
// file silently breaks a release are both mechanical. `Set-Content -Encoding utf8` prepends
// a BOM that Rust's JSON parser rejects, so the app fetches 200 OK and then fails to read
// the manifest — every update no-ops with no error anywhere. And the download URL has to
// carry the TAG, not `latest`: a `latest` URL would start pointing at the next release the
// moment it is published, while this manifest still advertises the old version and its
// signature, so the updater would download bytes its signature does not cover.
//
// The signature covers the installer's BYTES, not its location, so the artifact can be
// rehosted anywhere without re-signing.
import { readFileSync, writeFileSync } from "node:fs";

const [, , version, sigPath, outPath, notes] = process.argv;
if (!version || !sigPath || !outPath) {
  console.error("usage: release-manifest.mjs <version> <sig> <out.json> [notes]");
  process.exit(1);
}

const REPO = "art-daddy/artdaddy";
const ASSET = "ArtDaddy-windows-x64-setup.exe";

const signature = readFileSync(sigPath, "utf8").trim();
if (!signature.startsWith("dW50cnVzdGVk")) {
  console.error(`${sigPath} does not look like a base64 minisign signature`);
  process.exit(1);
}

const manifest = {
  version,
  notes: notes ?? "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    // macOS is absent on purpose: that build is unsigned and un-notarized, so it cannot
    // self-update. Advertising it here would hand clients an artifact they must reject.
    "windows-x86_64": {
      signature,
      url: `https://github.com/${REPO}/releases/download/v${version}/${ASSET}`,
    },
  },
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8" });
const written = readFileSync(outPath);
if (written[0] === 0xef) {
  console.error("refusing to ship a manifest with a BOM");
  process.exit(1);
}
console.log(`[manifest] ${outPath}  v${version} -> ${manifest.platforms["windows-x86_64"].url}`);
