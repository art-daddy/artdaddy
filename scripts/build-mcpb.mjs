#!/usr/bin/env node
// Package mcpb/ into src-tauri/resources/artdaddy.mcpb, the bundle Claude Desktop installs.
//
// An .mcpb is a zip with `manifest.json` at the ROOT and the entry point where the manifest says
// it is. We write the zip here rather than shelling out: Windows PowerShell 5.1's Compress-Archive
// (and the .NET Framework ZipFile beneath it) emits `server\index.js` with a BACKSLASH, which the
// ZIP spec forbids and readers resolve as a root-level file with a slash in its name — a bundle
// that installs as an unhelpful "invalid extension". Writing the entries ourselves also makes the
// Windows and macOS release paths produce the same bytes.
//
// The version is copied from tauri.conf.json so a release cannot ship a bundle claiming an older one.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "mcpb");
const outDir = join(root, "src-tauri", "resources");
const out = join(outDir, "artdaddy.mcpb");

const version = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;

const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
manifest.version = version;

// Entry names are literal forward-slash paths — never built with path.join.
const files = [
  { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") },
  { name: "server/index.js", data: readFileSync(join(src, "server", "index.js")) },
  { name: "icon.png", data: readFileSync(join(root, "public", "icon.png")) },
];

// A fixed DOS timestamp (2020-01-01) keeps the bundle byte-reproducible across machines.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const locals = [];
const central = [];
let offset = 0;
for (const f of files) {
  const comp = deflateRawSync(f.data, { level: 9 });
  const sum = crc32(f.data);
  const name = Buffer.from(f.name, "utf8");

  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(f.data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28); // extra
  name.copy(local, 30);
  locals.push(local, comp);

  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(sum, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(f.data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30); // extra
  cd.writeUInt16LE(0, 32); // comment
  cd.writeUInt16LE(0, 34); // disk
  cd.writeUInt16LE(0, 36); // internal attrs
  cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external attrs: regular file, rw-r--r-- (>>>0: the shift is signed)
  cd.writeUInt32LE(offset, 42);
  name.copy(cd, 46);
  central.push(cd);

  offset += local.length + comp.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

mkdirSync(outDir, { recursive: true });
rmSync(out, { force: true });
writeFileSync(out, Buffer.concat([...locals, cdBuf, eocd]));

// Read the artifact back and walk its central directory. A writer bug is invisible in the call
// that "succeeded"; the only evidence is what a reader finds inside.
const zip = readFileSync(out);
const eocdAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (eocdAt < 0) throw new Error("no end-of-central-directory in the bundle we just wrote");
const count = zip.readUInt16LE(eocdAt + 10);
let p = zip.readUInt32LE(eocdAt + 16);
const seen = [];
for (let i = 0; i < count; i++) {
  if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`corrupt central directory at entry ${i}`);
  const nameLen = zip.readUInt16LE(p + 28);
  const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
  const lho = zip.readUInt32LE(p + 42);
  const cSize = zip.readUInt32LE(p + 20);
  const uSize = zip.readUInt32LE(p + 24);
  const dataAt = lho + 30 + zip.readUInt16LE(lho + 26) + zip.readUInt16LE(lho + 28);
  const body = inflateRawSync(zip.subarray(dataAt, dataAt + cSize));
  const expected = files.find((f) => f.name === name);
  if (!expected) throw new Error(`unexpected entry '${name}'`);
  if (body.length !== uSize || !body.equals(expected.data))
    throw new Error(`entry '${name}' does not round-trip — the bundle is corrupt`);
  if (name.includes("\\")) throw new Error(`backslash in entry '${name}' — Claude Desktop will reject this`);
  seen.push(name);
  p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
}
if (!seen.includes("manifest.json")) throw new Error(`manifest.json is not at the archive root (saw: ${seen})`);
if (!seen.includes(manifest.server.entry_point))
  throw new Error(`entry point ${manifest.server.entry_point} missing (saw: ${seen})`);

console.log(
  `[mcpb] wrote ${out} (v${version}, ${(zip.length / 1024).toFixed(1)} KB) — verified entries: ${seen.join(", ")}`,
);
