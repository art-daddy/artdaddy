// Verifies a Tauri/minisign signature against the pubkey committed in tauri.conf.json.
// Run before publishing: a release whose signature does not verify installs for nobody,
// and the updater fails silently rather than reporting why.
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";

const [, , exePath, sigB64Path, confPath] = process.argv;

const conf = JSON.parse(readFileSync(confPath, "utf8"));
const pubBlock = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
const pubLine = pubBlock.split("\n").filter((l) => l && !l.startsWith("untrusted"))[0].trim();
const pubRaw = Buffer.from(pubLine, "base64");
const pubAlg = pubRaw.subarray(0, 2).toString();
const pubKeyId = pubRaw.subarray(2, 10);
const pubKey = pubRaw.subarray(10, 42);

const sigBlock = Buffer.from(readFileSync(sigB64Path, "utf8").trim(), "base64").toString("utf8");
const sigLines = sigBlock.split("\n");
const sigRaw = Buffer.from(sigLines[1].trim(), "base64");
const sigAlg = sigRaw.subarray(0, 2).toString();
const sigKeyId = sigRaw.subarray(2, 10);
const sigBytes = sigRaw.subarray(10, 74);

console.log(`  pubkey alg=${pubAlg} keyid=${pubKeyId.toString("hex")}`);
console.log(`  sig    alg=${sigAlg} keyid=${sigKeyId.toString("hex")}`);
console.log(`  trusted comment: ${sigLines[2]?.trim()}`);

if (!pubKeyId.equals(sigKeyId)) {
  console.log("  FAIL: signature was made by a DIFFERENT key than the one the app trusts");
  process.exit(1);
}

const content = readFileSync(exePath);
// "ED" is prehashed with blake2b-512; "Ed" signs the raw bytes.
const signed = sigAlg === "ED" ? createHash("blake2b512").update(content).digest() : content;

const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubKey]);
const key = createPublicKey({ key: spki, format: "der", type: "spki" });

const ok = verify(null, signed, key, sigBytes);
console.log(`  signature over ${exePath}: ${ok ? "VALID" : "INVALID"}`);
process.exit(ok ? 0 : 1);
