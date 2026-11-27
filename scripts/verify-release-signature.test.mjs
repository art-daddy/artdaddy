// scripts/verify-release-signature.mjs is the check that a release's updater signature (.sig) verifies against
// the public key the app ships (tauri.conf.json), not merely that a .sig exists: a release signed with any
// other key installs for nobody, and every installed app silently stays where it is.
//
// Every key here is a throwaway Ed25519 pair made by the test, never the release key. The script is run as a
// release runs it, from a folder whose src-tauri/tauri.conf.json carries the throwaway public key.
// Runs under vitest (CI's `npm test`) and under `node --test` (the pre-push quick check), so it imports no test
// library beyond the runner: assertions are node:assert, and the random cases come from a seeded generator.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { afterEach, beforeEach, describe, it } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

/** A test of a KNOWN BUG. Its body asserts the right behaviour, so it fails until the bug is fixed. Vitest (CI)
 *  inverts it, so a fix turns it red and it must become a normal test; node --test reports it as a todo. */
const knownBug = (name, fn) =>
  process.env.VITEST ? it.fails(name, fn) : it(name, { todo: "known bug" }, fn);

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "verify-release-signature.mjs",
);

/** A minisign key pair in the format of the release key. `id` is the 8-byte key id a signature names. */
function minisignKey(id = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const line = Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64");
  const file = `untrusted comment: minisign public key: ${id.toString("hex").toUpperCase()}\n${line}\n`;
  // tauri.conf.json carries the public key file base64-encoded once more.
  return { id, privateKey, pubkey: Buffer.from(file).toString("base64") };
}

/**
 * A .sig as `tauri signer` writes one: base64 of a minisign signature file. Prehashed ("ED", BLAKE2b-512 of the
 * file) unless `legacy`. `comment` is the trusted comment the second ("global") signature covers, `shown` the one
 * written into the file.
 */
function signature(
  key,
  bytes,
  { legacy = false, comment = "timestamp:1795258631\tfile:test-setup.exe", shown = comment } = {},
) {
  const message = legacy ? bytes : createHash("blake2b512").update(bytes).digest();
  const signed = sign(null, message, key.privateKey);
  const line = Buffer.concat([Buffer.from(legacy ? "Ed" : "ED"), key.id, signed]).toString(
    "base64",
  );
  const global = sign(null, Buffer.concat([signed, Buffer.from(comment)]), key.privateKey).toString(
    "base64",
  );
  const file = `untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${shown}\n${global}\n`;
  return Buffer.from(file).toString("base64");
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "release-sig-"));
  mkdirSync(path.join(dir, "src-tauri"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** Run the check the way a release does: `node scripts/verify-release-signature.mjs <installer> <installer.sig>`. */
function check({ trusted, installer, sig }) {
  writeFileSync(
    path.join(dir, "src-tauri", "tauri.conf.json"),
    JSON.stringify({ plugins: { updater: { pubkey: trusted.pubkey } } }),
  );
  writeFileSync(path.join(dir, "setup.exe"), installer);
  writeFileSync(path.join(dir, "setup.exe.sig"), sig);
  const run = spawnSync(process.execPath, [SCRIPT, "setup.exe", "setup.exe.sig"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  });
  return {
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    timedOut: run.error?.code === "ETIMEDOUT",
  };
}

const INSTALLER = Buffer.concat([Buffer.from("MZ"), randomBytes(4096)]);

describe("a release signature is checked against the key the app ships", () => {
  it("passes a .sig made by that key over these very bytes", () => {
    const key = minisignKey();
    const result = check({ trusted: key, installer: INSTALLER, sig: signature(key, INSTALLER) });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /MATCH/);
    assert.match(result.output, /VALID/);
  });

  it("passes the legacy signature mode, which the updater also accepts", () => {
    const key = minisignKey();
    const result = check({
      trusted: key,
      installer: INSTALLER,
      sig: signature(key, INSTALLER, { legacy: true }),
    });
    assert.equal(result.status, 0, result.output);
  });

  it("fails a .sig made by any other key: the release would install for nobody", () => {
    const result = check({
      trusted: minisignKey(),
      installer: INSTALLER,
      sig: signature(minisignKey(), INSTALLER),
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /MISMATCH/);
  });

  it("fails a key that claims the shipped key's id: the id alone proves nothing", () => {
    const shipped = minisignKey();
    const impostor = minisignKey(shipped.id);
    const result = check({
      trusted: shipped,
      installer: INSTALLER,
      sig: signature(impostor, INSTALLER),
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /INVALID/);
  });

  it("fails the right key's signature of other bytes: a changed installer or the wrong file", () => {
    const key = minisignKey();
    const changed = Buffer.from(INSTALLER);
    changed[changed.length - 1] ^= 1;
    assert.equal(
      check({ trusted: key, installer: changed, sig: signature(key, INSTALLER) }).status,
      1,
    );
    const other = signature(key, Buffer.from("another file"));
    assert.equal(check({ trusted: key, installer: INSTALLER, sig: other }).status, 1);
  });

  it("fails an empty, cut-off or garbage .sig, and never hangs on one", () => {
    const key = minisignKey();
    const good = signature(key, INSTALLER);
    for (const [label, sig] of [
      ["empty", ""],
      ["only whitespace", "\n\n"],
      ["cut inside the signature", good.slice(0, Math.floor(good.length / 4))],
      ["random bytes", randomBytes(300)],
      ["not base64", "%%% not a signature %%%"],
      ["the public key instead of a signature", key.pubkey],
    ]) {
      const result = check({ trusted: key, installer: INSTALLER, sig });
      assert.equal(result.timedOut, false, label);
      assert.notEqual(result.status, 0, `${label}: ${result.output}`);
    }
  });

  it("passes exactly the shipped key's signatures of the exact bytes, for any installer", () => {
    const shipped = minisignKey();
    const other = minisignKey();
    let state = 0x2f6e2b1;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>>= 0);
    };
    for (let run = 0; run < 12; run++) {
      const file = Buffer.from(Array.from({ length: 1 + (next() % 2048) }, () => next() % 256));
      const byShipped = next() % 2 === 0;
      const legacy = next() % 2 === 0;
      const sig = signature(byShipped ? shipped : other, file, { legacy });
      const result = check({ trusted: shipped, installer: file, sig });
      assert.equal(result.status, byShipped ? 0 : 1, `run ${run}: ${result.output}`);
    }
  });

  // KNOWN BUG. A .sig has four lines: a comment, the signature, a trusted comment, and a second ("global")
  // signature over the signature and that trusted comment. The app (minisign-verify, through the updater
  // plugin) requires and checks all four; this script reads only the first two, so it says VALID for a .sig
  // that every installed app refuses. Steps: sign an installer with the shipped key, then change the trusted
  // comment line, or cut the .sig after its signature line. Expected: exit 1. Actual: exit 0, "signature: VALID".
  knownBug("fails a .sig whose trusted comment was changed after signing, as the app does", () => {
    const key = minisignKey();
    const sig = signature(key, INSTALLER, { shown: "timestamp:1\tfile:test-setup.exe" });
    const result = check({ trusted: key, installer: INSTALLER, sig });
    assert.equal(result.status, 1, result.output);
  });

  knownBug("fails a .sig cut off after its signature line, as the app does", () => {
    const key = minisignKey();
    const [comment, line] = Buffer.from(signature(key, INSTALLER), "base64")
      .toString("utf8")
      .split("\n");
    const sig = Buffer.from(`${comment}\n${line}\n`).toString("base64");
    const result = check({ trusted: key, installer: INSTALLER, sig });
    assert.equal(result.status, 1, result.output);
  });
});
