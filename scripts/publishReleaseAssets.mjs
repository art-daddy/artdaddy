// Attach build outputs to a GitHub release and prove they arrived intact, for a DRAFT release or a
// published one. The three release workflows used to prove it by asking the PUBLIC download URL, which
// does not exist for a draft: every draft run uploaded its files, got a 404 for them and ended red (the
// Windows one before it uploaded its signature). A draft is the safe way to build a release, so the
// check has to work on one.
//
//   node scripts/publishReleaseAssets.mjs --tag v0.22.0 <file>...     upload, then verify
//   node scripts/publishReleaseAssets.mjs --tag v0.22.0 --verify-only [--latest]
//                                                                     verify a PUBLISHED release as a user sees it
//
// What "verified" means:
//   - on the release as GitHub holds it (draft or not): each file is there once, state "uploaded", with
//     the size it was built with and the SHA-256 it was built with. A size alone passes a truncated-then-
//     padded or bit-flipped upload; the digest does not.
//   - on a published release, additionally: an anonymous HEAD of its public URL answers 200 with that size.
//
// A published asset is never replaced by different bytes: the live update manifest carries the signature
// of the bytes users are offered, so swapping them breaks every update until the manifest is fixed. It
// takes --replace-published, which no workflow passes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseArgs(argv, env = process.env) {
  const out = { tag: "", repo: env.GITHUB_REPOSITORY ?? "", files: [], replacePublished: false, verifyOnly: false, latest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tag") out.tag = argv[++i] ?? "";
    else if (a === "--repo") out.repo = argv[++i] ?? "";
    else if (a === "--replace-published") out.replacePublished = true;
    else if (a === "--verify-only") out.verifyOnly = true;
    else if (a === "--latest") out.latest = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out.files.push(a);
  }
  if (!/^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(out.tag)) throw new Error(`--tag must be a version tag like v0.22.0, got "${out.tag}"`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(out.repo)) throw new Error(`the repository must be owner/name (--repo or GITHUB_REPOSITORY), got "${out.repo}"`);
  if (out.verifyOnly && out.files.length) throw new Error("--verify-only takes no files");
  if (!out.verifyOnly && !out.files.length) throw new Error("name at least one file to attach");
  if (out.latest && !out.verifyOnly) throw new Error("--latest only applies to --verify-only");
  const names = out.files.map((f) => basename(f));
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) throw new Error(`two files would become the asset ${duplicate}`);
  return out;
}

/** What is wrong with `asset` as GitHub holds it, against the file that was meant to be uploaded. */
export function assetProblems(asset, local) {
  if (!asset) return [`${local.name} is not on the release`];
  const problems = [];
  if (asset.state !== "uploaded") problems.push(`${local.name} is in state "${asset.state}", not "uploaded"`);
  if (asset.size !== local.size) problems.push(`${local.name} is ${asset.size} bytes on the release but ${local.size} were built`);
  if (asset.digest != null && asset.digest !== `sha256:${local.sha256}`)
    problems.push(`${local.name} has digest ${asset.digest} on the release but sha256:${local.sha256} was built`);
  return problems;
}

/** What is wrong with the public download of `asset`, given the answer to an anonymous HEAD. */
export function publicProblems(asset, answer) {
  const problems = [];
  if (answer.status !== 200) problems.push(`the public URL of ${asset.name} answered ${answer.status}`);
  else if (!Number.isFinite(answer.length)) problems.push(`the public URL of ${asset.name} does not say how large it is`);
  else if (answer.length !== asset.size) problems.push(`the public URL of ${asset.name} serves ${answer.length} bytes, the release lists ${asset.size}`);
  return problems;
}

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve({ name: basename(file), size: statSync(file).size, sha256: hash.digest("hex") }))
      .on("error", reject);
  });
}

/** The release `tag` names, drafts included, as the REST API describes it (assets with their digests).
 *  `gh release view` finds a draft by tag the moment it exists; the list endpoint can lag a draft that
 *  was just created, which a run started right after creating one would read as "no such release". */
async function findRelease(gh, repo, tag) {
  let id = null;
  try {
    id = JSON.parse(gh(["release", "view", tag, "--repo", repo, "--json", "databaseId"])).databaseId ?? null;
  } catch {
    /* not found, or a gh too old to say: the list below decides */
  }
  if (id) return JSON.parse(gh(["api", `repos/${repo}/releases/${id}`]));
  for (let page = 1; page <= 20; page++) {
    const releases = JSON.parse(gh(["api", `repos/${repo}/releases?per_page=100&page=${page}`]));
    const hits = releases.filter((r) => r.tag_name === tag);
    if (hits.length > 1) throw new Error(`${hits.length} releases carry the tag ${tag}`);
    if (hits.length === 1) return hits[0];
    if (releases.length < 100) return null;
  }
  return null;
}

/** The bytes GitHub serves for an asset, hashed, for the assets it has no digest for. */
async function downloadedHash({ gh, repo, tag, name, hashOf }) {
  const dir = mkdtempSync(join(tmpdir(), "release-asset-"));
  try {
    gh(["release", "download", tag, "--repo", repo, "--pattern", name, "--dir", dir, "--clobber"]);
    return await hashOf(join(dir, name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Attach `files` to the release `tag` and verify them. Everything that touches GitHub or the network
 * is passed in, so the verdicts can be tested against a release that misbehaves in each way.
 * Resolves to { ok, problems, draft, lines }.
 */
export async function publish({ repo, tag, files, replacePublished = false, gh, head, hashOf = hashFile }) {
  const problems = [];
  const lines = [];
  const release = await findRelease(gh, repo, tag);
  if (!release) return { ok: false, draft: null, lines, problems: [`release ${tag} does not exist: create the draft first`] };
  const draft = release.draft === true;
  const locals = [];
  for (const file of files) {
    if (!existsSync(file)) return { ok: false, draft, lines, problems: [`${file} does not exist`] };
    const local = { ...(await hashOf(file)), file };
    if (local.size === 0) return { ok: false, draft, lines, problems: [`${local.name} is empty`] };
    locals.push(local);
  }

  const onRelease = (current, name) => current.assets.filter((a) => a.name === name);
  const toUpload = [];
  for (const local of locals) {
    const existing = onRelease(release, local.name);
    if (existing.length > 1) return { ok: false, draft, lines, problems: [`${local.name} is on the release ${existing.length} times`] };
    const [asset] = existing;
    if (!asset) toUpload.push(local);
    else if (draft) toUpload.push(local);
    else if (assetProblems(asset, local).length === 0) lines.push(`${local.name}: already on the published release, identical; not uploaded again`);
    else if (replacePublished) toUpload.push(local);
    else
      return {
        ok: false,
        draft,
        lines,
        problems: [`${local.name} is already PUBLISHED with different bytes; replacing it would break the updates that verify the bytes users are offered (--replace-published to do it on purpose)`],
      };
  }

  if (toUpload.length) gh(["release", "upload", tag, ...toUpload.map((l) => l.file), "--repo", repo, "--clobber"]);

  const after = toUpload.length ? await findRelease(gh, repo, tag) : release;
  if (!after) return { ok: false, draft, lines, problems: [`release ${tag} disappeared after the upload`] };
  for (const local of locals) {
    const found = onRelease(after, local.name);
    if (found.length > 1) {
      problems.push(`${local.name} is on the release ${found.length} times`);
      continue;
    }
    let asset = found[0];
    if (asset && asset.digest == null) {
      // Older uploads carry no digest: the only proof left is the bytes themselves.
      const got = await downloadedHash({ gh, repo, tag, name: local.name, hashOf });
      asset = { ...asset, digest: `sha256:${got.sha256}`, size: asset.size };
    }
    const mine = assetProblems(asset, local);
    if (!mine.length && !draft) mine.push(...publicProblems(asset, await head(publicUrl(repo, tag, local.name))));
    problems.push(...mine);
    if (!mine.length) lines.push(`${local.name}: ${local.size} bytes, sha256 ${local.sha256}`);
  }
  lines.push(
    draft
      ? "the release is a DRAFT: verified through the releases API (size and SHA-256); there is no public download to check until it is published"
      : "the release is published: verified through the releases API and by an anonymous download request",
  );
  return { ok: problems.length === 0, draft, lines, problems };
}

/** A published release as a user meets it: every asset answers, with the size the release lists. */
export async function verifyPublished({ repo, tag, requireLatest = false, gh, head }) {
  const problems = [];
  const lines = [];
  const release = await findRelease(gh, repo, tag);
  if (!release) return { ok: false, lines, problems: [`release ${tag} does not exist`] };
  if (release.draft) return { ok: false, lines, problems: [`${tag} is still a draft: it has no public downloads to verify`] };
  if (!release.assets.length) problems.push(`${tag} has no assets`);
  for (const asset of release.assets) {
    const mine = [];
    if (asset.state !== "uploaded") mine.push(`${asset.name} is in state "${asset.state}", not "uploaded"`);
    if (!(asset.size > 0)) mine.push(`${asset.name} is empty`);
    if (!mine.length) mine.push(...publicProblems(asset, await head(publicUrl(repo, tag, asset.name))));
    problems.push(...mine);
    if (!mine.length) lines.push(`${asset.name}: ${asset.size} bytes, served publicly`);
  }
  if (requireLatest) {
    const latest = JSON.parse(gh(["api", `repos/${repo}/releases/latest`]));
    if (latest.tag_name !== tag) problems.push(`the latest release is ${latest.tag_name}, not ${tag}`);
    else lines.push(`${tag} is the release GitHub calls latest`);
  }
  return { ok: problems.length === 0, lines, problems };
}

const publicUrl = (repo, tag, name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

function realGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout;
}

async function realHead(url) {
  const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(60_000) });
  return { status: response.status, length: Number(response.headers.get("content-length")) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.verifyOnly
    ? await verifyPublished({ repo: args.repo, tag: args.tag, requireLatest: args.latest, gh: realGh, head: realHead })
    : await publish({ repo: args.repo, tag: args.tag, files: args.files, replacePublished: args.replacePublished, gh: realGh, head: realHead });
  for (const line of result.lines) console.log(line);
  for (const problem of result.problems) console.log(`${process.env.GITHUB_ACTIONS ? "::error::" : "ERROR: "}${problem}`);
  if (!result.ok) process.exit(1);
  console.log(args.verifyOnly ? `${args.tag}: verified.` : `${args.tag}: attached and verified.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`${process.env.GITHUB_ACTIONS ? "::error::" : "ERROR: "}${error.message}`);
    process.exit(1);
  });
}
