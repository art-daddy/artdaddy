// The update feed's two sides, held to one file. An installed app learns about an update only from
// https://artdaddy.app/updates/latest.json (tauri.conf.json). That file is written in the landing site's
// repository: `landing/updates/latest.json` gets its version, notes and date by hand, each platform's entry
// from that repository's `scripts/add-platform-update.mjs`, and it goes live when that repository's `main` is
// deployed. src-tauri/tests/fixtures/updater/latest-0.29.1.json is the live file of 26 Nov 2026, byte for byte
// (equal to the landing repository's file at d5688d7).
//
// src-tauri/tests/update_feed.rs checks that the app reads that file as written. This file checks the writing
// side: the format a release writes, that the key the app ships is the key that signed it, and, where a checkout
// of the landing repository sits beside this one, that its writer produces exactly these bytes.
// Runs under vitest (CI's `npm test`) and under `node --test` (the pre-push quick check): assertions are
// node:assert.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as updateFeed from "./updateFeed.mjs";

const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = readFileSync(
  path.join(ROOT, "src-tauri", "tests", "fixtures", "updater", "latest-0.29.1.json"),
);
const FEED = JSON.parse(GOLDEN.toString("utf8"));
const CONF = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const REPOSITORY = "art-daddy/artdaddy";
// The platform keys an installed app looks itself up by, in the order the 0.29.1 switch added them, and the
// version-less asset name each release uploads.
const PLATFORMS = {
  "windows-x86_64": "ArtDaddy-windows-x64-setup.exe",
  "darwin-aarch64": "ArtDaddy-macos-arm64.app.tar.gz",
  "linux-x86_64": "ArtDaddy-linux-x86_64.AppImage",
};

/** The lines of a minisign file (the configured public key, or a .sig), each carried as base64 of the file. */
const lines = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8").split(/\r?\n/);
function publicKey(b64) {
  const raw = Buffer.from(lines(b64)[1], "base64");
  return {
    algorithm: raw.subarray(0, 2).toString(),
    id: raw.subarray(2, 10).toString("hex"),
    key: raw.subarray(10),
  };
}
function signatureParts(b64) {
  const [, line, trusted, global] = lines(b64);
  const raw = Buffer.from(line, "base64");
  return {
    algorithm: raw.subarray(0, 2).toString(),
    id: raw.subarray(2, 10).toString("hex"),
    signature: raw.subarray(10),
    trusted,
    global: Buffer.from(global, "base64"),
  };
}
const ed25519 = (raw) =>
  createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });

describe("the live feed's format, which is what a release writes", () => {
  it("is plain JSON as the writer prints it: no byte-order mark, LF lines, two-space indent, a final newline", () => {
    // A byte-order mark makes every app fail to read the feed (src-tauri/tests/update_feed.rs).
    assert.notDeepEqual([...GOLDEN.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(GOLDEN.includes("\r"), false);
    assert.equal(GOLDEN.toString("utf8"), `${JSON.stringify(FEED, null, 2)}\n`);
    assert.deepEqual(Object.keys(FEED), ["version", "notes", "pub_date", "platforms"]);
  });

  it("names its version as x.y.z and its date with a time and a zone, or no app can read it", () => {
    assert.match(FEED.version, /^\d+\.\d+\.\d+$/);
    assert.match(FEED.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    assert.equal(typeof FEED.notes, "string");
  });

  it("offers every platform the asset of that very version, by the name the release uploads", () => {
    assert.deepEqual(Object.keys(FEED.platforms), Object.keys(PLATFORMS));
    for (const [platform, asset] of Object.entries(PLATFORMS)) {
      assert.deepEqual(Object.keys(FEED.platforms[platform]), ["signature", "url"], platform);
      assert.equal(
        FEED.platforms[platform].url,
        `https://github.com/${REPOSITORY}/releases/download/v${FEED.version}/${asset}`,
        platform,
      );
    }
  });
});

// The one-way door. Every installed app trusts only the public key it was built with; a key in tauri.conf.json
// that is not the release key would build apps that refuse every later release. Each signature in the live feed
// carries a second signature over its own trusted comment, made by the same key: it verifies without the
// 250 MB installer, so this needs no download.
describe("the key the app ships is the key that signed the live feed", () => {
  const shipped = publicKey(CONF.plugins.updater.pubkey);

  it("ships an Ed25519 minisign key", () => {
    assert.equal(shipped.algorithm, "Ed");
    assert.equal(shipped.key.length, 32);
  });

  for (const platform of Object.keys(PLATFORMS)) {
    it(`${platform}: made by the shipped key, and its trusted comment verifies against it`, () => {
      const parts = signatureParts(FEED.platforms[platform].signature);
      assert.equal(parts.algorithm, "ED");
      assert.equal(parts.id, shipped.id);
      assert.equal(parts.signature.length, 64);
      assert.ok(parts.trusted.startsWith("trusted comment: "), parts.trusted);
      const comment = Buffer.from(parts.trusted.slice("trusted comment: ".length));
      const message = Buffer.concat([parts.signature, comment]);
      assert.equal(verify(null, message, ed25519(shipped.key), parts.global), true);
      // and by no other key
      assert.equal(
        verify(null, message, generateKeyPairSync("ed25519").publicKey, parts.global),
        false,
      );
    });
  }
});

// The landing repository is private and not checked out in CI, so this runs where a checkout sits beside the
// client (a worker's worktree, the owner's PC), as the tool-contract check does with the server.
const LANDING = process.env.ARTDADDY_LANDING_DIR || path.resolve(ROOT, "..", "akaru-landing");
const WRITER = path.join(LANDING, "scripts", "add-platform-update.mjs");
const NO_WRITER = existsSync(WRITER) ? false : `no landing checkout at ${LANDING}`;
const itWithWriter = (name, fn) =>
  process.env.VITEST ? it.skipIf(NO_WRITER)(name, fn) : it(name, { skip: NO_WRITER }, fn);

describe("the landing site's writer", () => {
  itWithWriter(
    "writes exactly the live feed from its version, notes, date and three signatures",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "feed-writer-"));
      try {
        mkdirSync(path.join(dir, "scripts"));
        mkdirSync(path.join(dir, "landing", "updates"), { recursive: true });
        copyFileSync(WRITER, path.join(dir, "scripts", "add-platform-update.mjs"));
        // What the release checklist has a person write before the platforms are added.
        const start = {
          version: FEED.version,
          notes: FEED.notes,
          pub_date: FEED.pub_date,
          platforms: {},
        };
        writeFileSync(
          path.join(dir, "landing", "updates", "latest.json"),
          `${JSON.stringify(start, null, 2)}\n`,
        );
        // The writer asks GitHub whether each asset exists; here every asset does, and nothing leaves this machine.
        const noNetwork = path.join(dir, "no-network.mjs");
        writeFileSync(noNetwork, "globalThis.fetch = async () => ({ ok: true, status: 200 });\n");
        for (const platform of Object.keys(PLATFORMS)) {
          const sig = path.join(dir, `${platform}.sig`);
          writeFileSync(sig, `${FEED.platforms[platform].signature}\n`);
          const args = [
            "--import",
            pathToFileURL(noNetwork).href,
            path.join(dir, "scripts", "add-platform-update.mjs"),
          ];
          const run = spawnSync(process.execPath, [...args, platform, FEED.version, sig], {
            cwd: dir,
            encoding: "utf8",
            timeout: 30_000,
          });
          assert.equal(run.status, 0, `${platform}: ${run.stdout}${run.stderr}`);
        }
        const written = readFileSync(path.join(dir, "landing", "updates", "latest.json"));
        assert.equal(written.toString("utf8"), GOLDEN.toString("utf8"));
        assert.ok(written.equals(GOLDEN));
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );
});

// The staged feed the update canary serves for a candidate (scripts/qa/stagedFeed.mjs) is written by
// scripts/updateFeed.mjs. It must be the live feed's format to the byte, or the canary would prove an update path
// no installed app ever takes.
describe("the canary's staged feed is written exactly as the live one", () => {
  const inputs = {
    repository: REPOSITORY,
    version: FEED.version,
    notes: FEED.notes,
    pubDate: FEED.pub_date,
    signatures: Object.fromEntries(
      Object.entries(FEED.platforms).map(([platform, entry]) => [platform, `${entry.signature}\n`]),
    ),
  };

  it("writes the live feed's bytes from the live feed's version, notes, date and signatures", () => {
    const written = Buffer.from(updateFeed.feedText(inputs));
    assert.equal(written.toString("utf8"), GOLDEN.toString("utf8"));
    assert.ok(written.equals(GOLDEN));
  });

  it("offers the platforms and assets the live feed offers", () => {
    const fromLive = Object.fromEntries(
      Object.entries(FEED.platforms).map(([platform, entry]) => [
        platform,
        entry.url.split("/").pop(),
      ]),
    );
    assert.deepEqual({ ...updateFeed.PLATFORMS }, fromLive);
    assert.equal(updateFeed.FEED_URL, CONF.plugins.updater.endpoints[0]);
  });

  it("refuses to write a feed no app could read, or one that leaves a system without its update", () => {
    const refusals = [
      ["a version that is not x.y.z", { version: "0.30" }],
      ["a date without a time", { pubDate: "2026-11-21" }],
      ["a date that is not one", { pubDate: "soon" }],
      [
        "a platform without its signature",
        { signatures: { ...inputs.signatures, "linux-x86_64": undefined } },
      ],
      [
        "a signature that is not one",
        { signatures: { ...inputs.signatures, "darwin-aarch64": "abc" } },
      ],
    ];
    for (const [label, change] of refusals) {
      assert.throws(() => updateFeed.feedText({ ...inputs, ...change }), Error, label);
    }
  });
});

describe("the release an installed app updates from", () => {
  const release = (version, more = {}) => ({
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    ...more,
  });

  it("is the latest shipped release older than the candidate", () => {
    const releases = [
      release("0.29.1", { prerelease: true }),
      release("0.29.0"),
      release("0.27.0"),
      release("0.28.0", { draft: true }),
    ];
    assert.equal(updateFeed.previousRelease(releases, "0.29.1"), "0.29.0");
    assert.equal(updateFeed.previousRelease(releases, "0.29.0"), "0.27.0");
    assert.equal(updateFeed.previousRelease(releases, "0.27.0"), null);
    assert.equal(
      updateFeed.previousRelease([release("0.9.0"), release("0.10.0")], "0.11.0"),
      "0.10.0",
    );
    assert.equal(
      updateFeed.previousRelease([{ tag_name: "nightly" }, release("1.0.0")], "2.0.0"),
      "1.0.0",
    );
  });

  it("is never the candidate, a later release, a draft or a pre-release, and no shipped release lies between", () => {
    let state = 0x1d872b41;
    const next = (n) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % n;
    };
    for (let run = 0; run < 300; run++) {
      const releases = Array.from({ length: next(12) }, () =>
        release(`${next(2)}.${next(15)}.${next(4)}`, {
          draft: next(5) === 0,
          prerelease: next(5) === 0,
        }),
      );
      const before = `${next(2)}.${next(15)}.${next(4)}`;
      const chosen = updateFeed.previousRelease(releases, before);
      const shipped = releases
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => r.tag_name.slice(1));
      const older = shipped.filter((v) => updateFeed.newer(before, v));
      if (chosen === null) {
        assert.deepEqual(older, [], `run ${run}`);
        continue;
      }
      assert.ok(shipped.includes(chosen), `run ${run}: ${chosen} was not shipped`);
      assert.ok(
        updateFeed.newer(before, chosen),
        `run ${run}: ${chosen} is not older than ${before}`,
      );
      assert.ok(
        !older.some((v) => updateFeed.newer(v, chosen)),
        `run ${run}: a later release than ${chosen} was skipped`,
      );
    }
  });
});
