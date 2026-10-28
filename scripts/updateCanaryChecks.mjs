// The checks the macOS update canary makes, taken out of scripts/qa/macUpdateCanary.mjs so they can be
// tested: that script only runs on a disposable GitHub macOS runner.
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

/** `a` is a newer x.y.z than `b`. */
export function newer(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * What the live manifest offers an installed app of `platform` at version `from`, or why it is not an
 * offer an app could take: a version that is not newer, no entry for the platform, a signature that is
 * not one, or a URL that is not an asset of that very version of this repository (the manifest and its
 * links drifting apart is how an update 404s for everyone).
 */
export function manifestOffer(manifest, platform, from, repository) {
  const problems = [];
  const version = manifest?.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) problems.push(`the manifest's version "${version}" is not x.y.z`);
  else if (!newer(version, from)) problems.push(`the manifest offers ${version}, which is not newer than the installed ${from}`);
  const entry = manifest?.platforms?.[platform];
  if (!entry) problems.push(`the manifest has no ${platform} entry`);
  else {
    if (typeof entry.signature !== "string" || entry.signature.trim().length < 100) problems.push(`the ${platform} signature is missing or too short to be one`);
    const assets = `https://github.com/${repository}/releases/download/v${version}/`;
    if (typeof entry.url !== "string" || !entry.url.startsWith(assets)) problems.push(`the ${platform} URL ${entry.url} is not an asset of v${version} of ${repository}`);
  }
  return { ok: problems.length === 0, problems, version, url: entry?.url, signature: entry?.signature };
}

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

/**
 * Every entry under `root`, keyed by its path relative to it: a file with its SHA-256 and whether it is
 * executable, a symlink with where it points, a directory. Links are recorded, never followed.
 */
export async function describeTree(root) {
  const tree = new Map();
  async function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const key = path.relative(root, full).split(path.sep).join("/");
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) tree.set(key, { type: "symlink", target: readlinkSync(full) });
      else if (stat.isDirectory()) {
        tree.set(key, { type: "dir" });
        await walk(full);
      } else if (stat.isFile()) tree.set(key, { type: "file", size: stat.size, executable: (stat.mode & 0o111) !== 0, sha256: await sha256(full) });
      else tree.set(key, { type: "other" });
    }
  }
  await walk(root);
  return tree;
}

/** What differs between the bundle that was published and the one that was installed; [] when none. */
export function diffTrees(published, installed, { limit = 20 } = {}) {
  const problems = [];
  for (const [key, want] of published) {
    const got = installed.get(key);
    if (!got) problems.push(`missing from the installed bundle: ${key}`);
    else if (got.type !== want.type) problems.push(`${key} is a ${got.type} where the published bundle has a ${want.type}`);
    else if (want.type === "file" && got.sha256 !== want.sha256) problems.push(`${key} differs: sha256 ${got.sha256} installed, ${want.sha256} published`);
    else if (want.type === "file" && got.executable !== want.executable) problems.push(`${key} is ${got.executable ? "executable" : "not executable"} where the published file is ${want.executable ? "executable" : "not executable"}`);
    else if (want.type === "symlink" && got.target !== want.target) problems.push(`${key} points to ${got.target}, the published link points to ${want.target}`);
  }
  for (const key of installed.keys()) if (!published.has(key)) problems.push(`not in the published bundle: ${key}`);
  return problems.length > limit ? [...problems.slice(0, limit), `...and ${problems.length - limit} more`] : problems;
}

/** What the Rust half printed: the CANARY-* lines of `cargo test -- --nocapture`, as data. The first one
 *  shares a line with libtest's own "test <name> ... ", so a tag is looked for anywhere on a line. */
export function parseCanaryOutput(text) {
  const line = (tag) => new RegExp(`${tag} (.*)$`, "m").exec(text)?.[1].trim() ?? null;
  const json = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const offered = line("CANARY-OFFERED");
  const installed = line("CANARY-INSTALLED");
  const downloaded = line("CANARY-DOWNLOADED");
  return {
    offered: offered === null ? null : json(offered),
    downloadedBytes: downloaded === null ? null : Number(downloaded),
    installed: installed === null ? null : json(installed),
  };
}
