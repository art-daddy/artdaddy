// The oldest macOS each Mach-O file in a macOS bundle will run on, and the gate that fails a build when
// any of them needs a newer macOS than the one we say the app supports.
//
// WHY THIS EXISTS. What a user's Mac accepts is decided by two numbers: the `LSMinimumSystemVersion`
// the app declares (from `bundle.macOS.minimumSystemVersion` in tauri.conf.json) and the minimum OS
// each binary inside it carries in its own header (`LC_BUILD_VERSION`, or `LC_VERSION_MIN_MACOSX` in
// older files). The first is a promise; the second is what dyld enforces. Nothing made them agree.
// Moving the build to a newer runner image can silently raise the second (a toolchain that defaults the
// deployment target to the runner's own OS), and one downloaded sidecar can already be above the first:
// ffmpeg and ffprobe need macOS 12 while the site said 11. So the gate reads the real headers of EVERY
// Mach-O in the bundle, the browser engine and its libraries included, and compares each with the one
// number the app advertises.
//
// The parser reads only the header and load commands of each file (and each slice of a universal
// binary), so a 170 MB browser costs a few kilobytes of reading. It is pure over a `reader`, so a test
// can feed it bytes it built itself, or the real header bytes of a shipped binary.
//
//   node scripts/ci/macosMinOs.mjs <bundle-or-folder> --config src-tauri/tauri.conf.json --expect-config src-tauri/tauri.conf.json
//
// Exit 0: every scanned file runs on the advertised minimum or older (or on its baseline ceiling). 1: a
// problem (printed). 2: usage.
//
// THE BASELINE (`macosMinOs.baseline.json`). On 2026-11-01 the guard measured the shipped 0.22.1 bundle:
// the app advertises macOS 11.0, and four groups of files already need more (ffmpeg and ffprobe 12.0, the
// browser engine and its libraries 13.0, an unused Playwright ffmpeg 15.0). The owner decided to leave the
// advertised version as it is for now. So the baseline gives each of those files a CEILING: the build fails
// when a file needs more than its ceiling (or, unlisted, more than the advertised minimum), so no floor can
// rise unnoticed, and the known gap is written down instead of hidden. Delete the file when the advertised
// version is raised to cover it.

import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIN_64 = 0xfeedfacf;
const THIN_32 = 0xfeedface;
const FAT = 0xcafebabe;
const FAT_64 = 0xcafebabf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
export const PLATFORM_MACOS = 1;
// A Java class file starts with the same four bytes as a universal binary; what follows is its version
// (45 to 70). A real universal binary has a handful of slices.
const MAX_FAT_SLICES = 16;
const MAX_COMMANDS_BYTES = 16 * 1024 * 1024;

/** X.Y.Z as the loader packs it: major in the high 16 bits, then minor, then patch. */
export function packVersion(major, minor = 0, patch = 0) {
  return (((major & 0xffff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)) >>> 0;
}

/** "12", "12.0" or "12.0.1" to the packed form; null for anything else. */
export function parseVersion(text) {
  const m = /^(\d{1,5})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  if (minor > 255 || patch > 255) return null;
  return packVersion(major, minor, patch);
}

export function formatVersion(packed) {
  if (packed === null || packed === undefined) return "none";
  const patch = packed & 0xff;
  return `${packed >>> 16}.${(packed >>> 8) & 0xff}${patch ? `.${patch}` : ""}`;
}

/** A reader over bytes already in memory. */
export function bufferReader(buffer) {
  return {
    size: buffer.length,
    read: (position, length) =>
      buffer.subarray(position, Math.min(buffer.length, position + length)),
  };
}

function fileReader(fd, size) {
  return {
    size,
    read(position, length) {
      const wanted = Math.max(0, Math.min(length, size - position));
      const out = Buffer.alloc(wanted);
      let got = 0;
      while (got < wanted) {
        const n = readSync(fd, out, got, wanted - got, position + got);
        if (n === 0) break;
        got += n;
      }
      return got === wanted ? out : out.subarray(0, got);
    },
  };
}

function cpuName(cpuType, cpuSubtype) {
  switch (cpuType) {
    case 0x0100000c:
      return (cpuSubtype & 0xff) === 2 ? "arm64e" : "arm64";
    case 0x01000007:
      return "x86_64";
    case 7:
      return "i386";
    case 12:
      return "arm";
    case 0x0200000c:
      return "arm64_32";
    default:
      return `cpu-0x${cpuType.toString(16)}`;
  }
}

/** One thin Mach-O (a whole file, or one slice of a universal one) starting at `offset`. */
function parseThin(reader, offset) {
  const head = reader.read(offset, 32);
  if (head.length < 28) return null;
  const magic = head.readUInt32LE(0);
  if (magic !== THIN_64 && magic !== THIN_32) return null;
  const headerSize = magic === THIN_64 ? 32 : 28;
  if (head.length < headerSize) return null;
  const cpuType = head.readUInt32LE(4);
  const cpuSubtype = head.readUInt32LE(8);
  const fileType = head.readUInt32LE(12);
  const commandCount = head.readUInt32LE(16);
  const commandBytes = head.readUInt32LE(20);
  const commands = reader.read(offset + headerSize, Math.min(commandBytes, MAX_COMMANDS_BYTES));

  let minos = null;
  let sdk = null;
  let via = null;
  const platforms = [];
  let truncated = commands.length < commandBytes;
  let at = 0;
  for (let i = 0; i < commandCount; i++) {
    if (at + 8 > commands.length) {
      truncated = true;
      break;
    }
    // The top bit (LC_REQ_DYLD) only says the loader must understand the command.
    const cmd = commands.readUInt32LE(at) & 0x7fffffff;
    const size = commands.readUInt32LE(at + 4);
    if (size < 8 || at + size > commands.length) {
      truncated = true;
      break;
    }
    if (cmd === LC_BUILD_VERSION && size >= 20) {
      const platform = commands.readUInt32LE(at + 8);
      platforms.push(platform);
      if (platform === PLATFORM_MACOS && minos === null) {
        minos = commands.readUInt32LE(at + 12);
        sdk = commands.readUInt32LE(at + 16);
        via = "LC_BUILD_VERSION";
      }
    } else if (cmd === LC_VERSION_MIN_MACOSX && size >= 16) {
      platforms.push(PLATFORM_MACOS);
      if (minos === null) {
        minos = commands.readUInt32LE(at + 8);
        sdk = commands.readUInt32LE(at + 12);
        via = "LC_VERSION_MIN_MACOSX";
      }
    }
    at += size;
  }
  return {
    arch: cpuName(cpuType, cpuSubtype),
    fileType,
    minos,
    sdk,
    via,
    platforms,
    truncated,
    is64: magic === THIN_64,
  };
}

/**
 * What a reader holds, or null when it is not a Mach-O file: `{ kind: "thin"|"fat"|"fat64", slices }`,
 * each slice `{ arch, fileType, minos, sdk, via, platforms, truncated, is64 }` with the versions packed
 * (see {@link formatVersion}). `minos` is null when the slice names no macOS minimum.
 */
export function parseMachO(reader) {
  const head = reader.read(0, 8);
  if (head.length < 8) return null;
  if ([THIN_64, THIN_32].includes(head.readUInt32LE(0))) {
    const slice = parseThin(reader, 0);
    return slice ? { kind: "thin", slices: [slice] } : null;
  }
  const be = head.readUInt32BE(0);
  if (be !== FAT && be !== FAT_64) return null;
  const wide = be === FAT_64;
  const count = head.readUInt32BE(4);
  if (count === 0 || count > MAX_FAT_SLICES) return null;
  const entry = wide ? 32 : 20;
  const table = reader.read(8, count * entry);
  if (table.length < count * entry) return null;
  const slices = [];
  for (let i = 0; i < count; i++) {
    const offset = wide
      ? Number(table.readBigUInt64BE(i * entry + 8))
      : table.readUInt32BE(i * entry + 8);
    const slice = parseThin(reader, offset);
    if (slice) slices.push(slice);
  }
  return slices.length ? { kind: wide ? "fat64" : "fat", slices } : null;
}

/** Every regular file under `root` (or `root` itself) that is a Mach-O, with what it declares. Symlinks
 *  are not followed: a link is not a second binary, and a loop would never end. */
export function scanTree(root) {
  const found = [];
  const walk = (full, rel) => {
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort())
        walk(path.join(full, name), rel ? `${rel}/${name}` : name);
      return;
    }
    if (!stat.isFile() || stat.size < 28) return;
    const fd = openSync(full, "r");
    try {
      const parsed = parseMachO(fileReader(fd, fstatSync(fd).size));
      if (parsed) found.push({ path: rel || path.basename(full), ...parsed });
    } finally {
      closeSync(fd);
    }
  };
  walk(root, "");
  return found;
}

const scoped = (slice, arch) =>
  slice.arch === arch || (arch === "arm64" && slice.arch === "arm64e");

/** `*` is any run of characters inside one folder, `**` crosses folders, and a pattern with no `/` is
 *  matched against the file's name alone. Enough for a handful of known files; nothing else is special. */
export function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const matches = (pattern, file) =>
  globToRegExp(pattern).test(pattern.includes("/") ? file : path.posix.basename(file));

/** A baseline: files that already need more than the advertised minimum, each with a CEILING. It lets the
 *  gate stop a floor from rising without first forcing a decision on the gap that exists today.
 *  `{ entries: [{ match, minos, note }] }`; returns `[{ match, minos (packed), note }]`. */
export function loadBaseline(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return (raw.entries ?? []).map((e) => {
    const minos = parseVersion(e.minos);
    if (!e.match || minos === null)
      throw new Error(`baseline entry ${JSON.stringify(e)} needs a "match" and a version "minos"`);
    return { match: e.match, minos, note: e.note ?? "" };
  });
}

/**
 * Judge scanned files against the advertised minimum. A file may need up to the larger of the advertised
 * minimum and the ceiling a `baseline` entry gives it. A problem is any of:
 *  - `too-new`: a slice for `arch` needs more than that;
 *  - `no-minimum`: a slice for `arch` names no macOS minimum at all (nothing to compare, so no pass);
 *  - `no-slice`: a file with no slice for `arch` (it would not run natively);
 *  - `missing-expected`: a name in `expected` was not among the files scanned;
 *  - `nothing-scanned`: fewer than `minFiles` files were found, so a pass would mean nothing;
 *  - `plist-mismatch` / `plist-missing`: when `declared` is given (the Info.plist's LSMinimumSystemVersion,
 *    null if it has none), it must be present and equal `advertised`: that plist value is what the OS
 *    reads before it opens the app, so it is the promise the headers are held to.
 * Warnings never fail a build: `known-gap` (a file above the advertised minimum but within its ceiling)
 * and `stale-baseline` (an entry whose files now need less than it says, so it can be tightened).
 */
export function judge(
  files,
  { advertised, arch = "arm64", expected = [], minFiles = 1, baseline = [], declared },
) {
  const problems = [];
  const warnings = [];
  const rows = [];
  let highest = null;
  const seen = new Map(); // baseline entry -> highest minos among the files it matched
  if (declared === null) problems.push({ kind: "plist-missing", advertised });
  else if (declared !== undefined && declared !== advertised)
    problems.push({ kind: "plist-mismatch", declared, advertised });
  if (files.length < minFiles)
    problems.push({ kind: "nothing-scanned", found: files.length, wanted: minFiles });
  for (const file of files) {
    const mine = file.slices.filter((s) => scoped(s, arch));
    rows.push({
      path: file.path,
      slices: file.slices.map((s) => ({
        arch: s.arch,
        minos: s.minos,
        sdk: s.sdk,
        used: scoped(s, arch),
      })),
    });
    if (mine.length === 0) {
      problems.push({ kind: "no-slice", file: file.path, arches: file.slices.map((s) => s.arch) });
      continue;
    }
    const entry = baseline.find((b) => matches(b.match, file.path)) ?? null;
    const allowed = Math.max(advertised, entry?.minos ?? 0);
    for (const slice of mine) {
      if (slice.minos === null) {
        problems.push({
          kind: "no-minimum",
          file: file.path,
          arch: slice.arch,
          platforms: slice.platforms,
        });
        continue;
      }
      if (highest === null || slice.minos > highest.minos)
        highest = { file: file.path, minos: slice.minos };
      if (entry) seen.set(entry, Math.max(seen.get(entry) ?? 0, slice.minos));
      if (slice.minos > allowed) {
        problems.push({
          kind: "too-new",
          file: file.path,
          arch: slice.arch,
          minos: slice.minos,
          advertised,
          allowed,
        });
      } else if (slice.minos > advertised) {
        warnings.push({
          kind: "known-gap",
          file: file.path,
          minos: slice.minos,
          advertised,
          note: entry?.note ?? "",
        });
      }
    }
  }
  for (const [entry, actual] of seen) {
    if (actual < entry.minos)
      warnings.push({ kind: "stale-baseline", match: entry.match, listed: entry.minos, actual });
  }
  const have = new Set(files.map((f) => path.posix.basename(f.path)));
  for (const name of expected)
    if (!have.has(name)) problems.push({ kind: "missing-expected", name });
  return { ok: problems.length === 0, problems, warnings, rows, highest };
}

/** The minimum macOS an .app's Info.plist declares (`LSMinimumSystemVersion`, which is what the OS reads
 *  before it will open the app): a packed version, null when the plist names none, undefined when `root`
 *  has no Info.plist (a folder of sidecars, say). */
export function readDeclaredMinimum(root) {
  let plist;
  try {
    plist = readFileSync(path.join(root, "Contents", "Info.plist"), "utf8");
  } catch {
    return undefined;
  }
  return parseVersion(
    /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1],
  );
}

/** The one number the app advertises, and the files the gate must have seen, from tauri.conf.json (and
 *  the bundle's own Info.plist for the main executable's name). */
export function readConfig(configPath, bundleRoot = null, suffix = "") {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const advertised = parseVersion(config?.bundle?.macOS?.minimumSystemVersion);
  const expected = (config?.bundle?.externalBin ?? []).map(
    (b) => `${path.posix.basename(b)}${suffix}`,
  );
  if (bundleRoot) {
    try {
      const plist = readFileSync(path.join(bundleRoot, "Contents", "Info.plist"), "utf8");
      const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
      if (exe) expected.push(exe);
    } catch {
      /* not an .app: only the sidecars are expected */
    }
  }
  return { advertised, expected };
}

function describeProblem(p, advertised) {
  switch (p.kind) {
    case "too-new":
      return p.allowed > advertised
        ? `${p.file} needs macOS ${formatVersion(p.minos)} (${p.arch}), above the ${formatVersion(p.allowed)} its baseline entry allows (the app advertises macOS ${formatVersion(advertised)})`
        : `${p.file} needs macOS ${formatVersion(p.minos)} (${p.arch}), but the app advertises macOS ${formatVersion(advertised)}`;
    case "no-minimum":
      return `${p.file} (${p.arch}) names no macOS minimum${p.platforms.length ? ` (its platforms: ${p.platforms.join(", ")})` : ""}, so it cannot be compared`;
    case "no-slice":
      return `${p.file} has no slice for the bundle's architecture (it has: ${p.arches.join(", ")})`;
    case "missing-expected":
      return `${p.name} was expected in the bundle (tauri.conf.json, Info.plist) and was not found as a Mach-O file: the gate did not look at it`;
    case "nothing-scanned":
      return `found ${p.found} Mach-O files, wanted at least ${p.wanted}: a pass would prove nothing`;
    case "plist-mismatch":
      return `Info.plist declares LSMinimumSystemVersion ${formatVersion(p.declared)}, but tauri.conf.json advertises ${formatVersion(p.advertised)}: the OS would enforce the wrong number`;
    case "plist-missing":
      return `Info.plist declares no LSMinimumSystemVersion, so macOS would open the app on any version (tauri.conf.json advertises ${formatVersion(p.advertised)})`;
    default:
      return JSON.stringify(p);
  }
}

function describeWarning(w, advertised) {
  if (w.kind === "known-gap") {
    return `${w.file} needs macOS ${formatVersion(w.minos)}, above the advertised ${formatVersion(advertised)}${w.note ? ` (${w.note})` : ""}`;
  }
  return `baseline entry "${w.match}" lists macOS ${formatVersion(w.listed)} but its files now need ${formatVersion(w.actual)}: tighten it`;
}

/** The command. `io` lets a test run it in-process and read what it printed; returns the exit code. */
export function main(
  argv,
  { env = process.env, out = (s) => console.log(s), err = (s) => console.error(s) } = {},
) {
  const opts = { arch: "arm64", suffix: "" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") opts.config = argv[++i];
    else if (a === "--advertised") opts.advertised = argv[++i];
    else if (a === "--expect-config") opts.expectConfig = argv[++i];
    else if (a === "--expect-suffix") opts.suffix = argv[++i];
    else if (a === "--baseline") opts.baseline = argv[++i];
    else if (a === "--arch") opts.arch = argv[++i];
    else if (a === "--min-files") opts.minFiles = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a.startsWith("--")) {
      err(`unknown option ${a}`);
      return 2;
    } else rest.push(a);
  }
  if (rest.length !== 1 || (!opts.config && !opts.advertised)) {
    err(
      "usage: macosMinOs.mjs <bundle-or-folder> (--config tauri.conf.json | --advertised X.Y) [--baseline file.json] [--expect-config tauri.conf.json [--expect-suffix -aarch64-apple-darwin]] [--arch arm64] [--min-files N] [--json]",
    );
    return 2;
  }
  const root = rest[0];
  let advertised = opts.advertised ? parseVersion(opts.advertised) : null;
  let expected = [];
  let baseline = [];
  try {
    if (opts.config) advertised = advertised ?? readConfig(opts.config).advertised;
    if (opts.expectConfig) expected = readConfig(opts.expectConfig, root, opts.suffix).expected;
    if (opts.baseline) baseline = loadBaseline(opts.baseline);
  } catch (e) {
    err(`cannot read the configuration: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  if (advertised === null) {
    err("no advertised minimum: bundle.macOS.minimumSystemVersion is missing or not a version");
    return 2;
  }
  let files;
  try {
    files = scanTree(root);
  } catch (e) {
    err(`cannot read ${root}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const verdict = judge(files, {
    advertised,
    arch: opts.arch,
    expected,
    baseline,
    declared: readDeclaredMinimum(root),
    minFiles: opts.minFiles ?? Math.max(1, expected.length),
  });
  if (opts.json) {
    out(JSON.stringify({ advertised: formatVersion(advertised), ...verdict }, null, 2));
  } else {
    out(
      `macOS minimum of every Mach-O under ${root} (${opts.arch}; advertised ${formatVersion(advertised)}):`,
    );
    for (const row of verdict.rows) {
      const used = row.slices.filter((s) => s.used);
      const shown = (used.length ? used : row.slices)
        .map((s) => `${s.arch} ${formatVersion(s.minos)}`)
        .join(", ");
      out(`  ${shown.padEnd(26)} ${row.path}`);
    }
    if (verdict.highest)
      out(`  highest: macOS ${formatVersion(verdict.highest.minos)} (${verdict.highest.file})`);
  }
  const inActions = env.GITHUB_ACTIONS === "true";
  for (const w of verdict.warnings) {
    const text = describeWarning(w, advertised);
    err(inActions ? `::warning title=macOS minimum::${text}` : `WARNING ${w.kind}: ${text}`);
  }
  for (const p of verdict.problems) {
    const text = describeProblem(p, advertised);
    err(inActions ? `::error title=macOS minimum::${text}` : `PROBLEM ${p.kind}: ${text}`);
  }
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
