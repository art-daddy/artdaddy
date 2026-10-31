import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assetProblems,
  parseArgs,
  publicProblems,
  publish,
  removeScratch,
  verifyPublished,
} from "./publishReleaseAssets.mjs";

const REPO = "owner/app";
const TAG = "v0.22.0";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "publish-assets-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Files with deterministic, distinct contents, named as the release workflows name theirs. */
function makeFiles(specs) {
  return specs.map(([name, size], i) => {
    const file = join(dir, name);
    writeFileSync(file, Buffer.from(Array.from({ length: size }, (_, k) => (k * 31 + i * 7 + 1) % 251)));
    return file;
  });
}

/**
 * A GitHub release that can misbehave the ways a real one does. `fault(name, bytes)` returns how the
 * upload of one asset goes wrong: { stored } (different bytes kept), { state }, { noDigest }, { drop }.
 */
function fakeGithub({ draft = true, assets = [], fault = () => ({}), latest = TAG, listLag = false, oldGh = false } = {}) {
  const store = new Map();
  const release = { tag_name: TAG, draft, assets: [] };
  const add = ({ name, bytes, digest = `sha256:${sha(bytes)}`, state = "uploaded" }) => {
    store.set(name, bytes);
    release.assets.push({ name, size: bytes.length, digest, state });
  };
  for (const a of assets) add(a);
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "release" && args[1] === "view") {
      if (oldGh) throw new Error('Unknown JSON field: "databaseId"');
      if (release.tag_name !== args[2]) throw new Error("release not found");
      return JSON.stringify({ databaseId: 4242 });
    }
    if (args[0] === "api" && /\/releases\/4242$/.test(args[1])) return JSON.stringify(release);
    if (args[0] === "api" && args[1].includes("/releases/latest")) return JSON.stringify({ tag_name: latest });
    if (args[0] === "api") return JSON.stringify(listLag ? [] : [release]);
    if (args[0] === "release" && args[1] === "upload") {
      const end = args.indexOf("--repo");
      for (const file of args.slice(3, end)) {
        const name = basename(file);
        const bytes = readFileSync(file);
        release.assets = release.assets.filter((a) => a.name !== name);
        const f = fault(name, bytes);
        if (f.drop) continue;
        const kept = f.stored ?? bytes;
        add({ name, bytes: kept, digest: f.noDigest ? null : `sha256:${sha(kept)}`, state: f.state ?? "uploaded" });
        if (f.duplicate) release.assets.push({ ...release.assets.at(-1) });
      }
      return "";
    }
    if (args[0] === "release" && args[1] === "download") {
      const name = args[args.indexOf("--pattern") + 1];
      writeFileSync(join(args[args.indexOf("--dir") + 1], name), store.get(name));
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const uploads = () => calls.filter((c) => c[0] === "release" && c[1] === "upload");
  return { gh, release, calls, uploads };
}

const publicOk = (sizes) => async (url) => ({ status: 200, length: sizes[decodeURIComponent(url.split("/").pop())] });
const noPublicAccess = async (url) => {
  throw new Error(`asked the public URL of a draft: ${url}`);
};

describe("attaching to a DRAFT release", () => {
  const specs = [
    ["ArtDaddy-windows-x64-setup.exe", 3000],
    ["ArtDaddy-windows-x64-setup.exe.sig", 400],
  ];

  // The regression: every draft run uploaded its files and then went red because the public URL of a
  // draft answers 404. A draft has to be verified without the public URL, never by it.
  it("verifies through the releases API alone and never asks for the public URL", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({ draft: true });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.draft).toBe(true);
    expect(github.release.assets.map((a) => a.name).sort()).toEqual(specs.map((s) => s[0]).sort());
  });

  // Found on the real API: a draft created a moment earlier was missing from the releases list, so a run
  // started right after creating one reported "no such release". The tag lookup does not lag.
  it("finds a draft the releases list has not caught up with yet", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({ draft: true, listLag: true });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(result.problems).toEqual([]);
    expect(github.calls.some((c) => c[0] === "api" && c[1].includes("per_page"))).toBe(false);
  });

  it("falls back to reading the list when this gh cannot say a release's id", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({ draft: true, oldGh: true });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(result.problems).toEqual([]);
    expect(github.calls.some((c) => c[0] === "api" && c[1].includes("per_page"))).toBe(true);
  });

  it("uploads the signature in the same step as the installer, so one cannot be left without the other", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({ draft: true });
    await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(github.uploads()).toHaveLength(1);
    expect(github.uploads()[0].filter((a) => files.includes(a)).sort()).toEqual([...files].sort());
  });

  it("replaces a stale asset of the same name, since nobody is downloading a draft", async () => {
    const files = makeFiles([["ArtDaddy-linux-x86_64.deb", 500]]);
    const github = fakeGithub({ draft: true, assets: [{ name: "ArtDaddy-linux-x86_64.deb", bytes: Buffer.from("an older build") }] });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(result.ok).toBe(true);
    expect(github.release.assets).toHaveLength(1);
    expect(github.release.assets[0].size).toBe(500);
  });

  it("fails an upload GitHub kept truncated, naming the file and both sizes", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({ fault: (name, bytes) => (name.endsWith(".exe") ? { stored: bytes.subarray(0, bytes.length - 1) } : {}) });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/ArtDaddy-windows-x64-setup\.exe is 2999 bytes on the release but 3000 were built/);
  });

  // A size comparison passes this one: same length, one bit different. It is the case the public-URL
  // check never covered either, because it only compared Content-Length.
  it("fails an upload GitHub kept with the right size and the wrong bytes", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({
      fault: (name, bytes) => {
        const flipped = Buffer.from(bytes);
        flipped[10] ^= 1;
        return name.endsWith(".sig") ? { stored: flipped } : {};
      },
    });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/ArtDaddy-windows-x64-setup\.exe\.sig has digest sha256:[0-9a-f]{64} on the release but sha256:[0-9a-f]{64} was built/);
  });

  it("falls back to downloading the bytes when GitHub gives an asset no digest, and still catches a corrupt one", async () => {
    const files = makeFiles(specs);
    const faithful = fakeGithub({ fault: () => ({ noDigest: true }) });
    expect((await publish({ repo: REPO, tag: TAG, files, gh: faithful.gh, head: noPublicAccess })).ok).toBe(true);
    expect(faithful.calls.some((c) => c[1] === "download")).toBe(true);

    const corrupt = fakeGithub({
      fault: (name, bytes) => {
        const flipped = Buffer.from(bytes);
        flipped[0] ^= 1;
        return { stored: flipped, noDigest: true };
      },
    });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: corrupt.gh, head: noPublicAccess });
    expect(result.ok).toBe(false);
  });

  it("fails an asset that is not in the state 'uploaded'", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({ fault: () => ({ state: "starter" }) });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/state "starter", not "uploaded"/);
  });

  it("fails an asset that never arrived, and one that arrived twice", async () => {
    const files = makeFiles(specs);
    const dropped = fakeGithub({ fault: (name) => (name.endsWith(".sig") ? { drop: true } : {}) });
    const missing = await publish({ repo: REPO, tag: TAG, files, gh: dropped.gh, head: noPublicAccess });
    expect(missing.ok).toBe(false);
    expect(missing.problems.join("\n")).toMatch(/\.sig is not on the release/);

    const doubled = fakeGithub({ fault: (name) => (name.endsWith(".exe") ? { duplicate: true } : {}) });
    const twice = await publish({ repo: REPO, tag: TAG, files, gh: doubled.gh, head: noPublicAccess });
    expect(twice.ok).toBe(false);
    expect(twice.problems.join("\n")).toMatch(/is on the release 2 times/);
  });

  it("uploads nothing when the release does not exist", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub();
    github.release.tag_name = "v9.9.9";
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: noPublicAccess });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/release v0\.22\.0 does not exist/);
    expect(github.uploads()).toHaveLength(0);
  });

  it("refuses a file that is missing or empty before it touches the release", async () => {
    const github = fakeGithub();
    const missing = await publish({ repo: REPO, tag: TAG, files: [join(dir, "nope.exe")], gh: github.gh, head: noPublicAccess });
    expect(missing.problems[0]).toMatch(/does not exist/);
    const [empty] = makeFiles([["empty.bin", 0]]);
    const result = await publish({ repo: REPO, tag: TAG, files: [empty], gh: github.gh, head: noPublicAccess });
    expect(result.problems[0]).toMatch(/is empty/);
    expect(github.uploads()).toHaveLength(0);
  });
});

describe("attaching to a PUBLISHED release", () => {
  const specs = [["ArtDaddy-linux-x86_64.AppImage", 2000]];

  it("also asks the public URL, and passes when it serves the built size", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({ draft: false });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: publicOk({ "ArtDaddy-linux-x86_64.AppImage": 2000 }) });
    expect(result.problems).toEqual([]);
    expect(result.draft).toBe(false);
  });

  it("fails when the public URL does not answer 200, or serves another size", async () => {
    const files = makeFiles(specs);
    const gone = await publish({ repo: REPO, tag: TAG, files, gh: fakeGithub({ draft: false }).gh, head: async () => ({ status: 404, length: NaN }) });
    expect(gone.ok).toBe(false);
    expect(gone.problems.join("\n")).toMatch(/answered 404/);
    const wrong = await publish({ repo: REPO, tag: TAG, files, gh: fakeGithub({ draft: false }).gh, head: async () => ({ status: 200, length: 1999 }) });
    expect(wrong.problems.join("\n")).toMatch(/serves 1999 bytes, the release lists 2000/);
    const silent = await publish({ repo: REPO, tag: TAG, files, gh: fakeGithub({ draft: false }).gh, head: async () => ({ status: 200, length: NaN }) });
    expect(silent.problems.join("\n")).toMatch(/does not say how large/);
  });

  // The live manifest carries the signature of the bytes users are offered. Rebuilding a release and
  // attaching the new bytes over the published ones would break every update until the manifest moved.
  it("never replaces a published asset with different bytes, and says why", async () => {
    const files = makeFiles(specs);
    const live = Buffer.from("the bytes users are offered");
    const github = fakeGithub({ draft: false, assets: [{ name: "ArtDaddy-linux-x86_64.AppImage", bytes: live }] });
    const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: publicOk({}) });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/already PUBLISHED with different bytes/);
    expect(github.uploads()).toHaveLength(0);
    expect(github.release.assets[0].size).toBe(live.length);
  });

  it("replaces one only when told to", async () => {
    const files = makeFiles(specs);
    const github = fakeGithub({ draft: false, assets: [{ name: "ArtDaddy-linux-x86_64.AppImage", bytes: Buffer.from("old") }] });
    const result = await publish({ repo: REPO, tag: TAG, files, replacePublished: true, gh: github.gh, head: publicOk({ "ArtDaddy-linux-x86_64.AppImage": 2000 }) });
    expect(result.ok).toBe(true);
    expect(github.uploads()).toHaveLength(1);
  });

  it("does not re-upload an identical published asset, since that would take it offline for a moment", async () => {
    const [file] = makeFiles(specs);
    const github = fakeGithub({ draft: false, assets: [{ name: "ArtDaddy-linux-x86_64.AppImage", bytes: readFileSync(file) }] });
    const result = await publish({ repo: REPO, tag: TAG, files: [file], gh: github.gh, head: publicOk({ "ArtDaddy-linux-x86_64.AppImage": 2000 }) });
    expect(result.ok).toBe(true);
    expect(github.uploads()).toHaveLength(0);
  });

  it("adds a new asset to a published release without touching the ones already there", async () => {
    const [file] = makeFiles([["ArtDaddy-linux-x86_64.deb", 700]]);
    const live = { name: "ArtDaddy-windows-x64-setup.exe", bytes: Buffer.from("live installer") };
    const github = fakeGithub({ draft: false, assets: [live] });
    const result = await publish({ repo: REPO, tag: TAG, files: [file], gh: github.gh, head: publicOk({ "ArtDaddy-linux-x86_64.deb": 700 }) });
    expect(result.ok).toBe(true);
    expect(github.release.assets.map((a) => a.name).sort()).toEqual(["ArtDaddy-linux-x86_64.deb", live.name]);
  });
});

describe("every way an upload can go wrong is caught", () => {
  const faults = {
    truncated: (bytes) => ({ stored: bytes.subarray(0, Math.max(1, bytes.length - 1)) }),
    flipped: (bytes) => ({ stored: Buffer.concat([Buffer.from([bytes[0] ^ 1]), bytes.subarray(1)]) }),
    "never finished": () => ({ state: "starter" }),
    dropped: () => ({ drop: true }),
    doubled: () => ({ duplicate: true }),
  };

  it("names exactly the asset that went wrong and passes the others, on a draft and on a published release", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 2, max: 300 }), { minLength: 1, maxLength: 4 }),
        fc.constantFrom(...Object.keys(faults)),
        fc.boolean(),
        fc.nat(),
        async (sizes, kind, draft, pick) => {
          const specs = sizes.map((size, i) => [`asset-${i}.bin`, size]);
          const files = makeFiles(specs);
          const target = `asset-${pick % sizes.length}.bin`;
          const github = fakeGithub({ draft, fault: (name, bytes) => (name === target ? faults[kind](bytes) : {}) });
          const sizesByName = Object.fromEntries(specs);
          const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: publicOk(sizesByName) });
          expect(result.ok, kind).toBe(false);
          const text = result.problems.join("\n");
          expect(text, kind).toContain(target);
          for (const [name] of specs) if (name !== target) expect(text, `${kind} blamed ${name}`).not.toContain(name);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("passes whatever the files are when nothing goes wrong", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 5 }), fc.boolean(), async (sizes, draft) => {
        const specs = sizes.map((size, i) => [`asset-${i}.bin`, size]);
        const files = makeFiles(specs);
        const github = fakeGithub({ draft });
        const result = await publish({ repo: REPO, tag: TAG, files, gh: github.gh, head: publicOk(Object.fromEntries(specs)) });
        expect(result.problems).toEqual([]);
        expect(result.ok).toBe(true);
      }),
      { numRuns: 25 },
    );
  });
});

describe("verifying a published release as a user sees it", () => {
  const assets = [
    { name: "a.exe", bytes: Buffer.from("installer bytes") },
    { name: "a.exe.sig", bytes: Buffer.from("signature") },
  ];
  const sizes = { "a.exe": 15, "a.exe.sig": 9 };

  it("passes when every asset answers with its listed size, and the release is the latest one", async () => {
    const github = fakeGithub({ draft: false, assets });
    const result = await verifyPublished({ repo: REPO, tag: TAG, requireLatest: true, gh: github.gh, head: publicOk(sizes) });
    expect(result.problems).toEqual([]);
    expect(result.lines.join("\n")).toMatch(/is the release GitHub calls latest/);
  });

  it("fails on the one asset that does not answer, and says which", async () => {
    const github = fakeGithub({ draft: false, assets });
    const head = async (url) => (url.endsWith("a.exe.sig") ? { status: 404, length: NaN } : { status: 200, length: 15 });
    const result = await verifyPublished({ repo: REPO, tag: TAG, gh: github.gh, head });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["the public URL of a.exe.sig answered 404"]);
  });

  it("refuses a draft, which has no public downloads, and an empty release", async () => {
    const draft = await verifyPublished({ repo: REPO, tag: TAG, gh: fakeGithub({ draft: true, assets }).gh, head: noPublicAccess });
    expect(draft.problems[0]).toMatch(/still a draft/);
    const empty = await verifyPublished({ repo: REPO, tag: TAG, gh: fakeGithub({ draft: false }).gh, head: noPublicAccess });
    expect(empty.problems).toContain(`${TAG} has no assets`);
  });

  it("fails when the release is not the one GitHub serves as latest", async () => {
    const github = fakeGithub({ draft: false, assets, latest: "v0.21.9" });
    const result = await verifyPublished({ repo: REPO, tag: TAG, requireLatest: true, gh: github.gh, head: publicOk(sizes) });
    expect(result.problems).toEqual(["the latest release is v0.21.9, not v0.22.0"]);
  });
});

describe("the arguments", () => {
  const env = { GITHUB_REPOSITORY: REPO };

  it("takes the repository from the workflow's environment and the files after the tag", () => {
    const a = parseArgs(["--tag", TAG, "/tmp/a.exe", "/tmp/a.exe.sig"], env);
    expect(a).toMatchObject({ tag: TAG, repo: REPO, files: ["/tmp/a.exe", "/tmp/a.exe.sig"], replacePublished: false, verifyOnly: false });
  });

  it("refuses what would attach the wrong thing or nothing", () => {
    expect(() => parseArgs(["/tmp/a.exe"], env)).toThrow(/--tag/);
    expect(() => parseArgs(["--tag", "latest", "/tmp/a"], env)).toThrow(/--tag/);
    expect(() => parseArgs(["--tag", TAG], env)).toThrow(/at least one file/);
    expect(() => parseArgs(["--tag", TAG, "/tmp/a"], {})).toThrow(/owner\/name/);
    expect(() => parseArgs(["--tag", TAG, "--force", "/tmp/a"], env)).toThrow(/unknown option/);
    expect(() => parseArgs(["--tag", TAG, "/a/x.bin", "/b/x.bin"], env)).toThrow(/two files would become the asset x\.bin/);
    expect(() => parseArgs(["--tag", TAG, "--verify-only", "/tmp/a"], env)).toThrow(/takes no files/);
    expect(() => parseArgs(["--tag", TAG, "--latest", "/tmp/a"], env)).toThrow(/--verify-only/);
  });

  it("accepts a throwaway tag for a rehearsal on a draft", () => {
    expect(parseArgs(["--tag", "v0.0.0-ci-draft-check", "/tmp/a"], env).tag).toBe("v0.0.0-ci-draft-check");
  });
});

describe("the release workflows publish through the script", () => {
  const workflows = ["windows-release.yml", "macos-release.yml", "linux-release.yml"];
  const read = (file) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", file), "utf8").replace(/\r\n/g, "\n");

  /** The lines of the step named "Publish ...", from its "- name:" to the next step or job. */
  function publishStep(yml) {
    const lines = yml.split("\n");
    const start = lines.findIndex((l) => /^\s+- name: Publish /.test(l));
    expect(start, "a step named 'Publish ...'").toBeGreaterThanOrEqual(0);
    let end = start + 1;
    while (end < lines.length && !/^ {6}- /.test(lines[end]) && !/^ {2}\S/.test(lines[end])) end++;
    return lines.slice(start, end).join("\n");
  }

  // The regression these three workflows shipped with: each uploaded to a draft release and then asked
  // the PUBLIC url for the file, got a 404 and ended red, however well the build had gone.
  it.each(workflows)("%s attaches and verifies its assets with the script, never by hand", (file) => {
    const yml = read(file);
    expect(yml).not.toMatch(/gh release upload/);
    expect(yml).not.toMatch(/%\{http_code\}/);
    expect(yml).not.toMatch(/Invoke-WebRequest[^\n]*-Method Head/i);
    expect(yml).not.toMatch(/releases\/download\/\$/);
    expect(publishStep(yml)).toMatch(/node scripts\/publishReleaseAssets\.mjs --tag /);
  });

  it.each(workflows)("%s gives the script the token it needs, only when asked to publish", (file) => {
    const step = publishStep(read(file));
    expect(step).toMatch(/^\s+if: (\$\{\{ )?inputs\.publish( \}\})?\s*$/m);
    expect(step).toMatch(/^\s+GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}\s*$/m);
  });

  it.each(workflows)("%s can rehearse on a throwaway draft, and the tag reaches the shell only as an environment variable", (file) => {
    const yml = read(file);
    expect(yml).toMatch(/^ {6}release_tag:\n {8}description: [^\n]*\n {8}type: string\n {8}default: ""\n/m);
    const uses = yml.split("\n").filter((l) => l.includes("inputs.release_tag"));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/^\s+RELEASE_TAG: \$\{\{ inputs\.release_tag \}\}$/);
    expect(publishStep(yml)).toMatch(/RELEASE_TAG/);
  });

  it("publishes every asset under the version-less names the manifest and the landing page point at", () => {
    const all = workflows.map(read).join("\n");
    for (const name of [
      "ArtDaddy-windows-x64-setup.exe",
      "ArtDaddy-windows-x64-setup.exe.sig",
      "ArtDaddy-linux-x86_64.AppImage",
      "ArtDaddy-linux-x86_64.deb",
      "ArtDaddy-macos-arm64.dmg",
      "ArtDaddy-macos-arm64.app.tar.gz",
      "ArtDaddy-macos-arm64.app.tar.gz.sig",
    ])
      expect(all, name).toContain(name);
  });
});

describe("the verdict helpers", () => {
  const local = { name: "a.bin", size: 4, sha256: sha(Buffer.from("abcd")) };
  it("accepts an asset that matches what was built, with or without a digest", () => {
    expect(assetProblems({ state: "uploaded", size: 4, digest: `sha256:${local.sha256}` }, local)).toEqual([]);
    expect(assetProblems({ state: "uploaded", size: 4, digest: null }, local)).toEqual([]);
  });
  it("accepts a public answer that is 200 with the listed size and nothing else", () => {
    expect(publicProblems({ name: "a.bin", size: 4 }, { status: 200, length: 4 })).toEqual([]);
    for (const status of [301, 403, 404, 500]) expect(publicProblems({ name: "a.bin", size: 4 }, { status, length: 4 })).toHaveLength(1);
  });
});

describe("clearing the scratch folder of a downloaded asset", () => {
  it("removes a folder with a file in it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "scratch-test-"));
    writeFileSync(join(scratch, "a.bin"), "x");
    expect(removeScratch(scratch)).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });
  it("never turns a folder Windows will not release into a failure of the publish", () => {
    const heldByTheScanner = () => {
      throw Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir"), { code: "ENOTEMPTY" });
    };
    expect(() => removeScratch("C:/tmp/held", heldByTheScanner)).not.toThrow();
    expect(removeScratch("C:/tmp/held", heldByTheScanner)).toBe(false);
  });
});
