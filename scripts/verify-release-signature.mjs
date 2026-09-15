// Verify a Tauri updater signature the way the installed app will: against the pubkey that is
// COMMITTED in tauri.conf.json, not against the key that happened to sign it. A .sig file
// existing proves only that the signer ran.
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";

const [exePath, sigPath] = process.argv.slice(2);
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

// Both the .sig and the configured pubkey are base64 wrappers around a minisign text file.
const untar = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8");
const line2 = (text) => Buffer.from(text.split("\n")[1].trim(), "base64");

const sig = line2(untar(readFileSync(sigPath, "utf8")));
const pub = line2(untar(conf.plugins.updater.pubkey));

const alg = sig.subarray(0, 2).toString();
const sigKeyId = sig.subarray(2, 10).toString("hex");
const pubKeyId = pub.subarray(2, 10).toString("hex");
const signature = sig.subarray(10, 74);
const rawPub = pub.subarray(10, 42);

// "ED" signs a BLAKE2b-512 digest of the file; legacy "Ed" signs the bytes themselves.
const payload = alg === "ED" ? createHash("blake2b512").update(readFileSync(exePath)).digest() : readFileSync(exePath);

const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPub]),
  format: "der",
  type: "spki",
});

const ok = verify(null, payload, key, signature);
console.log(`  algorithm   : ${alg}`);
console.log(`  sig  key id : ${sigKeyId}`);
console.log(`  conf key id : ${pubKeyId}  ${sigKeyId === pubKeyId ? "MATCH" : "MISMATCH"}`);
console.log(`  signature   : ${ok ? "VALID" : "INVALID"}`);
process.exit(ok && sigKeyId === pubKeyId ? 0 : 1);
