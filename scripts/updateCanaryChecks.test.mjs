import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeTree, diffTrees, manifestOffer, newer, normalizeProductVersion, parseCanaryOutput } from "./updateCanaryChecks.mjs";

const REPO = "art-daddy/artdaddy";
// The shape the live manifest really has: one entry per platform, each with a signature and an asset URL.
const manifest = (over = {}) => ({
  version: "0.21.9",
  notes: "notes",
  pub_date: "2026-10-27T21:34:44.203Z",
  platforms: {
    "darwin-aarch64": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK".repeat(6),
      url: `https://github.com/${REPO}/releases/download/v0.21.9/ArtDaddy-macos-arm64.app.tar.gz`,
    },
  },
  ...over,
});

describe("newer", () => {
  it("orders versions by number, not as text", () => {
    expect(newer("0.21.10", "0.21.9")).toBe(true);
    expect(newer("0.21.9", "0.21.10")).toBe(false);
    expect(newer("1.0.0", "0.99.99")).toBe(true);
    expect(newer("0.21.9", "0.21.9")).toBe(false);
  });
});

// The 0.22.0 Windows update worked (the new exe was installed and running) and was reported as a failure,
// because "0.22.0" lost its trailing ".0" and no longer equalled "0.22.0". No earlier release had a patch of 0.
describe("the version an installed exe reports", () => {
  it("keeps a real x.y.z, a zero patch included: the case that was reported as a failed update", () => {
    for (const version of ["0.22.0", "1.0.0", "0.21.9", "10.0.0", "0.0.0", "0.21.10"])
      expect(normalizeProductVersion(version), version).toBe(version);
  });

  it("drops the fourth component of a four-part version, and only a zero one", () => {
    expect(normalizeProductVersion("0.21.9.0")).toBe("0.21.9");
    expect(normalizeProductVersion("0.22.0.0")).toBe("0.22.0");
    expect(normalizeProductVersion("0.21.9.3")).toBe("0.21.9.3");
  });

  it("is the identity on every x.y.z and strips exactly the one zero of x.y.z.0", () => {
    const part = fc.nat({ max: 120 });
    fc.assert(
      fc.property(part, part, part, (a, b, c) => {
        const version = `${a}.${b}.${c}`;
        return normalizeProductVersion(version) === version && normalizeProductVersion(`${version}.0`) === version;
      }),
    );
  });

  it("ignores the line ending PowerShell adds", () => {
    expect(normalizeProductVersion("0.22.0\r\n")).toBe("0.22.0");
    expect(normalizeProductVersion(undefined)).toBe("");
  });

  it("is what the Windows canary uses, never a blanket strip of a trailing .0", () => {
    const harness = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "qa", "windowsUpdateCanary.mjs"),
      "utf8",
    );
    expect(harness).toMatch(/normalizeProductVersion\(\s*powershell\(/);
    expect(harness).not.toMatch(/\.replace\(\/\\\.0\$\//);
  });
});

describe("what the live manifest offers an installed app", () => {
  it("accepts a newer version with a signature and an asset of that version", () => {
    const offer = manifestOffer(manifest(), "darwin-aarch64", "0.21.8", REPO);
    expect(offer.problems).toEqual([]);
    expect(offer).toMatchObject({ ok: true, version: "0.21.9", url: expect.stringContaining("/v0.21.9/") });
  });

  it("refuses an offer that is not newer, since the app would never take it", () => {
    for (const from of ["0.21.9", "0.21.10", "1.0.0"]) {
      const offer = manifestOffer(manifest(), "darwin-aarch64", from, REPO);
      expect(offer.ok, from).toBe(false);
      expect(offer.problems.join(), from).toMatch(/not newer/);
    }
  });

  it("refuses a version that is not x.y.z", () => {
    for (const version of [undefined, "", "0.21", "v0.21.9", "0.21.9-rc.1", "latest"])
      expect(manifestOffer(manifest({ version }), "darwin-aarch64", "0.21.8", REPO).ok, String(version)).toBe(false);
  });

  it("refuses a manifest with no entry for the platform, whatever else it has", () => {
    const offer = manifestOffer(manifest(), "darwin-x86_64", "0.21.8", REPO);
    expect(offer.problems).toEqual(["the manifest has no darwin-x86_64 entry"]);
  });

  it("refuses a signature that is missing or too short to be one", () => {
    for (const signature of [undefined, "", "abc", 12345, "x".repeat(99)]) {
      const m = manifest();
      m.platforms["darwin-aarch64"].signature = signature;
      expect(manifestOffer(m, "darwin-aarch64", "0.21.8", REPO).ok, String(signature)).toBe(false);
    }
  });

  // The manifest and its links drifting apart is how an update 404s for everyone.
  it("refuses a URL that is not an asset of this version of this repository", () => {
    const urls = [
      `https://github.com/${REPO}/releases/download/v0.21.8/ArtDaddy-macos-arm64.app.tar.gz`,
      `https://github.com/someone-else/artdaddy/releases/download/v0.21.9/ArtDaddy-macos-arm64.app.tar.gz`,
      `https://example.com/v0.21.9/ArtDaddy-macos-arm64.app.tar.gz`,
      undefined,
    ];
    for (const url of urls) {
      const m = manifest();
      m.platforms["darwin-aarch64"].url = url;
      expect(manifestOffer(m, "darwin-aarch64", "0.21.8", REPO).ok, String(url)).toBe(false);
    }
  });

  it("offers exactly when the manifest is newer than the install, for any pair of versions", () => {
    const v = fc.tuple(fc.nat({ max: 3 }), fc.nat({ max: 60 }), fc.nat({ max: 60 })).map((p) => p.join("."));
    fc.assert(
      fc.property(v, v, (offered, installed) => {
        const m = manifest({ version: offered });
        m.platforms["darwin-aarch64"].url = `https://github.com/${REPO}/releases/download/v${offered}/a.tar.gz`;
        expect(manifestOffer(m, "darwin-aarch64", installed, REPO).ok).toBe(newer(offered, installed));
      }),
    );
  });
});

describe("comparing the installed bundle with the published one", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "canary-tree-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A small bundle shaped like a .app: nested directories, an empty one, executables and a link. */
  function bundle(name, files = {}) {
    const root = path.join(dir, name);
    const all = { "Contents/Info.plist": "plist", "Contents/MacOS/app": "binary", "Contents/Resources/a.txt": "a", ...files };
    for (const [rel, text] of Object.entries(all)) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    mkdirSync(path.join(root, "Contents/Empty"), { recursive: true });
    return root;
  }
  const same = async (a, b, options) => diffTrees(await describeTree(a), await describeTree(b), options);

  it("finds nothing between two copies of the same bundle", async () => {
    expect(await same(bundle("published"), bundle("installed"))).toEqual([]);
  });

  it("names a file whose bytes differ, even by one", async () => {
    const problems = await same(bundle("published"), bundle("installed", { "Contents/MacOS/app": "binarz" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Contents\/MacOS\/app differs: sha256 [0-9a-f]{64} installed, [0-9a-f]{64} published$/);
  });

  it("names what is missing from the installed bundle and what it has that was not published", async () => {
    const problems = await same(bundle("published", { "Contents/Resources/only-published.bin": "p" }), bundle("installed", { "Contents/Resources/only-installed.bin": "i" }));
    expect(problems.sort()).toEqual([
      "missing from the installed bundle: Contents/Resources/only-published.bin",
      "not in the published bundle: Contents/Resources/only-installed.bin",
    ]);
  });

  it("notices a directory where there should be a file, and an empty directory that went missing", async () => {
    const published = bundle("published");
    const installed = bundle("installed");
    rmSync(path.join(installed, "Contents/Resources/a.txt"));
    mkdirSync(path.join(installed, "Contents/Resources/a.txt"));
    rmSync(path.join(installed, "Contents/Empty"), { recursive: true });
    const problems = await same(published, installed);
    expect(problems).toContain("Contents/Resources/a.txt is a dir where the published bundle has a file");
    expect(problems).toContain("missing from the installed bundle: Contents/Empty");
  });

  it("says how many it left out rather than printing a thousand lines", async () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Contents/Resources/f${i}.bin`, `p${i}`]));
    const problems = await same(bundle("published", many), bundle("installed"), { limit: 5 });
    expect(problems).toHaveLength(6);
    expect(problems.at(-1)).toBe("...and 25 more");
  });

  // Unix semantics: a mode bit and a symlink mean nothing on a Windows checkout.
  describe.skipIf(process.platform === "win32")("what only a Unix filesystem has", () => {
    it("notices an executable that lost its mode, which is a launch failure with an intact hash", async () => {
      const published = bundle("published");
      const installed = bundle("installed");
      chmodSync(path.join(published, "Contents/MacOS/app"), 0o755);
      chmodSync(path.join(installed, "Contents/MacOS/app"), 0o644);
      expect(await same(published, installed)).toEqual(["Contents/MacOS/app is not executable where the published file is executable"]);
    });

    it("compares links by where they point and never follows them", async () => {
      const published = bundle("published");
      const installed = bundle("installed");
      symlinkSync("A", path.join(published, "Contents/Current"));
      symlinkSync("B", path.join(installed, "Contents/Current"));
      expect(await same(published, installed)).toEqual(["Contents/Current points to B, the published link points to A"]);
      const loop = bundle("loop");
      symlinkSync(".", path.join(loop, "Contents/Self"));
      expect((await describeTree(loop)).get("Contents/Self")).toEqual({ type: "symlink", target: "." });
    });
  });

  it("agrees with itself on any set of files, and names exactly the one that changed", async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 1, maxLength: 6 }),
        fc.nat(),
        async (names, pick) => {
          const files = Object.fromEntries(names.map((n, i) => [`Contents/Resources/${n}.dat`, `content-${i}`]));
          const a = bundle(`a${run}`, files);
          const b = bundle(`b${run++}`, files);
          expect(await same(a, b)).toEqual([]);
          const target = `Contents/Resources/${names[pick % names.length]}.dat`;
          writeFileSync(path.join(b, target), "changed");
          const problems = await same(a, b);
          expect(problems).toHaveLength(1);
          expect(problems[0]).toContain(target);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("reading what the Rust half printed", () => {
  // libtest prints "test <name> ... " and the test's own first line lands on that same line.
  const output = [
    "running 1 test",
    'test the_installed_app_is_updated_in_place_through_the_live_manifest ... CANARY-OFFERED {"version":"0.21.9","currentVersion":"0.21.8","target":"darwin-aarch64","url":"https://github.com/art-daddy/artdaddy/releases/download/v0.21.9/ArtDaddy-macos-arm64.app.tar.gz","signatureLength":408}',
    "CANARY-DOWNLOADED 244712267",
    'CANARY-INSTALLED {"version":"0.21.9"}',
    "ok",
  ].join("\n");

  it("reads the offer, the download and the install, including the one that shares libtest's line", () => {
    expect(parseCanaryOutput(output)).toEqual({
      offered: { version: "0.21.9", currentVersion: "0.21.8", target: "darwin-aarch64", url: expect.stringContaining("/v0.21.9/"), signatureLength: 408 },
      downloadedBytes: 244712267,
      installed: { version: "0.21.9" },
    });
  });

  it("says what is missing when the run stopped part-way", () => {
    const stopped = output.split("\n").slice(0, 2).join("\n");
    expect(parseCanaryOutput(stopped)).toMatchObject({ downloadedBytes: null, installed: null });
    expect(parseCanaryOutput("compile error: could not compile")).toEqual({ offered: null, downloadedBytes: null, installed: null });
  });

  it("does not mistake a malformed line for data", () => {
    expect(parseCanaryOutput("CANARY-OFFERED {not json\nCANARY-INSTALLED \nCANARY-DOWNLOADED lots").offered).toBeNull();
    expect(parseCanaryOutput("CANARY-DOWNLOADED lots").downloadedBytes).toBeNaN();
  });
});
