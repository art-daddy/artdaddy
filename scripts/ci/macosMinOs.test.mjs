import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bufferReader,
  formatVersion,
  globToRegExp,
  judge,
  loadBaseline,
  main,
  packVersion,
  parseMachO,
  parseVersion,
  readDeclaredMinimum,
  scanTree,
} from "./macosMinOs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CONFIG = path.join(REPO, "src-tauri", "tauri.conf.json");
const BASELINE = path.join(HERE, "macosMinOs.baseline.json");
const WORKFLOWS = path.join(REPO, ".github", "workflows");

// ---- Mach-O files built byte by byte from Apple's published layout (mach-o/loader.h, fat.h) -------------

const CPU = {
  arm64: [0x0100000c, 0],
  arm64e: [0x0100000c, 2],
  x86_64: [0x01000007, 3],
  i386: [7, 3],
};
const le32 = (...values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
};
const be32 = (...values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
};
const command = (cmd, ...words) => Buffer.concat([le32(cmd, 8 + words.length * 4), le32(...words)]);
/** LC_BUILD_VERSION: platform, minos, sdk, ntools. */
const buildVersion = (platform, minos, sdk = minos) => command(0x32, platform, minos, sdk, 0);
/** LC_VERSION_MIN_MACOSX: version, sdk (what files linked before LC_BUILD_VERSION existed carry). */
const versionMin = (version, sdk = version) => command(0x24, version, sdk);
/** A command of `bytes` bytes (a multiple of 8) the parser has to step over, like a segment or a dylib. */
const filler = (bytes) => command(0x19, ...new Array((bytes - 8) / 4).fill(0));

function thin({ arch = "arm64", commands = [], is64 = true, fileType = 2 } = {}) {
  const [cpu, sub] = CPU[arch];
  const body = Buffer.concat(commands);
  const header = is64
    ? le32(0xfeedfacf, cpu, sub, fileType, commands.length, body.length, 0, 0)
    : le32(0xfeedface, cpu, sub, fileType, commands.length, body.length, 0);
  return Buffer.concat([header, body, Buffer.alloc(64)]);
}

/** A universal file: `slices` is `[{ arch, buffer }]`; each slice starts on a 16 KiB boundary. */
function fat(slices, { wide = false } = {}) {
  const entry = wide ? 32 : 20;
  const align = 16384;
  const offsets = [];
  let cursor = 8 + slices.length * entry;
  for (const { buffer } of slices) {
    const offset = Math.ceil(cursor / align) * align;
    offsets.push(offset);
    cursor = offset + buffer.length;
  }
  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  };
  const out = Buffer.alloc(cursor);
  be32(wide ? 0xcafebabf : 0xcafebabe, slices.length).copy(out, 0);
  slices.forEach(({ arch, buffer }, i) => {
    const [cpu, sub] = CPU[arch];
    const row = wide
      ? Buffer.concat([be32(cpu, sub), u64(offsets[i]), u64(buffer.length), be32(14, 0)])
      : be32(cpu, sub, offsets[i], buffer.length, 14);
    row.copy(out, 8 + i * entry);
    buffer.copy(out, offsets[i]);
  });
  return out;
}

const parse = (buffer) => parseMachO(bufferReader(buffer));

// ---- generators -----------------------------------------------------------------------------------------

const versionArb = fc
  .record({
    major: fc.integer({ min: 10, max: 40 }),
    minor: fc.integer({ min: 0, max: 15 }),
    patch: fc.integer({ min: 0, max: 3 }),
  })
  .map((v) => packVersion(v.major, v.minor, v.patch));
const fillersArb = fc.array(
  fc.integer({ min: 1, max: 40 }).map((n) => filler(n * 8)),
  { maxLength: 6 },
);
const archArb = fc.constantFrom("arm64", "arm64e", "x86_64");

describe("parsing a Mach-O file", () => {
  it("reads LC_BUILD_VERSION wherever it sits among other commands", () => {
    fc.assert(
      fc.property(
        versionArb,
        versionArb,
        fillersArb,
        fillersArb,
        fc.boolean(),
        (minos, sdk, before, after, is64) => {
          const parsed = parse(
            thin({
              arch: is64 ? "arm64" : "i386",
              is64,
              commands: [...before, buildVersion(1, minos, sdk), ...after],
            }),
          );
          expect(parsed?.kind).toBe("thin");
          expect(parsed.slices).toHaveLength(1);
          expect(parsed.slices[0]).toMatchObject({
            minos,
            sdk,
            via: "LC_BUILD_VERSION",
            platforms: [1],
            is64,
          });
        },
      ),
    );
  });

  it("reads LC_VERSION_MIN_MACOSX, the form files linked before LC_BUILD_VERSION carry", () => {
    fc.assert(
      fc.property(versionArb, fillersArb, (version, before) => {
        const parsed = parse(thin({ commands: [...before, versionMin(version)] }));
        expect(parsed.slices[0]).toMatchObject({
          minos: version,
          via: "LC_VERSION_MIN_MACOSX",
          platforms: [1],
        });
      }),
    );
  });

  it("takes the macOS entry of a file that also targets Mac Catalyst, in either order", () => {
    const mac = packVersion(12, 0);
    const catalyst = packVersion(15, 0);
    for (const commands of [
      [buildVersion(6, catalyst), buildVersion(1, mac)],
      [buildVersion(1, mac), buildVersion(6, catalyst)],
    ]) {
      expect(parse(thin({ commands })).slices[0]).toMatchObject({
        minos: mac,
        platforms: expect.arrayContaining([1, 6]),
      });
    }
  });

  it("reports no minimum, not a guess, when the file has no macOS version at all", () => {
    expect(parse(thin({ commands: [filler(16)] })).slices[0].minos).toBeNull();
    // An iOS-only file names a version, but not one for macOS.
    expect(
      parse(thin({ commands: [buildVersion(2, packVersion(16, 0))] })).slices[0],
    ).toMatchObject({
      minos: null,
      platforms: [2],
    });
  });

  it("keeps every slice of a universal file with its own architecture and minimum", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ arch: archArb, minos: versionArb, before: fillersArb }), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.boolean(),
        (specs, wide) => {
          const file = fat(
            specs.map((s) => ({
              arch: s.arch,
              buffer: thin({ arch: s.arch, commands: [...s.before, buildVersion(1, s.minos)] }),
            })),
            { wide },
          );
          const parsed = parse(file);
          expect(parsed.kind).toBe(wide ? "fat64" : "fat");
          expect(parsed.slices.map((s) => [s.arch, s.minos])).toEqual(
            specs.map((s) => [s.arch, s.minos]),
          );
        },
      ),
    );
  });

  it("is not fooled by files that only start like one", () => {
    const javaClass = Buffer.concat([
      be32(0xcafebabe),
      Buffer.from([0, 0, 0, 61]),
      Buffer.alloc(200),
    ]); // class file, Java 17
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("#!/bin/sh\nexit 0\n"),
      Buffer.from("!<arch>\n"),
      javaClass,
      Buffer.alloc(64),
    ]) {
      expect(parse(bytes)).toBeNull();
    }
  });

  it("never throws or runs away on damaged input, only reports what it could read", () => {
    const magics = [le32(0xfeedfacf), le32(0xfeedface), be32(0xcafebabe), be32(0xcafebabf)];
    fc.assert(
      fc.property(fc.constantFrom(...magics), fc.uint8Array({ maxLength: 300 }), (magic, rest) => {
        const parsed = parse(Buffer.concat([magic, Buffer.from(rest)]));
        expect(parsed === null || Array.isArray(parsed.slices)).toBe(true);
      }),
      { numRuns: 500 },
    );
    // A header that promises four billion commands in a file that stops after one.
    const cut = thin({ commands: [buildVersion(1, packVersion(12, 0)), filler(16)] });
    cut.writeUInt32LE(0xffffffff, 16);
    cut.writeUInt32LE(0xfffffff0, 20);
    expect(parse(cut).slices[0]).toMatchObject({ minos: packVersion(12, 0), truncated: true });
  });
});

describe("versions", () => {
  it("round-trips: text to packed and back", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (a, b, c) => {
          expect(parseVersion(`${a}.${b}.${c}`)).toBe(packVersion(a, b, c));
          expect(formatVersion(packVersion(a, b, c))).toBe(c ? `${a}.${b}.${c}` : `${a}.${b}`);
        },
      ),
    );
    expect(parseVersion("12")).toBe(packVersion(12, 0, 0));
    for (const bad of ["", "twelve", "12.", "12.0.0.1", "1e2", null, undefined])
      expect(parseVersion(bad)).toBeNull();
    expect(packVersion(13, 0) > packVersion(12, 7, 9)).toBe(true); // 13.0 is newer than 12.7.9
  });
});

// ---- the verdict ----------------------------------------------------------------------------------------

const file = (name, slices) => ({
  path: name,
  kind: slices.length > 1 ? "fat" : "thin",
  slices: slices.map(([arch, minos]) => ({
    arch,
    minos,
    sdk: minos,
    via: "LC_BUILD_VERSION",
    platforms: [1],
    truncated: false,
  })),
});

describe("judging files against the advertised minimum", () => {
  it("fails exactly when a slice that runs on this Mac needs a newer macOS (a rule, not an example)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ arch: archArb, minos: versionArb }), { minLength: 1, maxLength: 4 }),
        versionArb,
        (slices, advertised) => {
          const verdict = judge(
            [
              file(
                "bin",
                slices.map((s) => [s.arch, s.minos]),
              ),
            ],
            { advertised },
          );
          const mine = slices.filter((s) => s.arch !== "x86_64");
          if (mine.length === 0) {
            expect(verdict.problems.map((p) => p.kind)).toEqual(["no-slice"]);
          } else {
            expect(verdict.ok).toBe(mine.every((s) => s.minos <= advertised));
          }
        },
      ),
    );
  });

  it("lets a baseline ceiling raise what ONE file may need, and nothing else", () => {
    fc.assert(
      fc.property(versionArb, versionArb, versionArb, (advertised, ceiling, actual) => {
        const baseline = [{ match: "heavy", minos: ceiling, note: "" }];
        const verdict = judge(
          [file("dir/heavy", [["arm64", actual]]), file("dir/light", [["arm64", actual]])],
          {
            advertised,
            baseline,
          },
        );
        const failed = verdict.problems.filter((p) => p.kind === "too-new").map((p) => p.file);
        expect(failed.includes("dir/heavy")).toBe(actual > Math.max(advertised, ceiling));
        expect(failed.includes("dir/light")).toBe(actual > advertised); // the ceiling is not a general allowance
      }),
    );
  });

  it("does not let a file with no macOS minimum, no slice, or nothing scanned pass", () => {
    const none = {
      path: "x",
      kind: "thin",
      slices: [
        { arch: "arm64", minos: null, sdk: null, via: null, platforms: [2], truncated: false },
      ],
    };
    expect(judge([none], { advertised: packVersion(11) }).problems.map((p) => p.kind)).toEqual([
      "no-minimum",
    ]);
    expect(judge([], { advertised: packVersion(11) }).problems.map((p) => p.kind)).toEqual([
      "nothing-scanned",
    ]);
    expect(
      judge([file("x", [["x86_64", packVersion(10, 15)]])], { advertised: packVersion(11) }).ok,
    ).toBe(false);
  });

  it("insists that every name the config promises was actually looked at", () => {
    const v = judge([file("Contents/MacOS/a", [["arm64", packVersion(11)]])], {
      advertised: packVersion(11),
      expected: ["a", "b"],
    });
    expect(v.problems).toEqual([{ kind: "missing-expected", name: "b" }]);
  });

  it("matches baseline patterns like a path: * stays in a folder, ** crosses folders, no slash means the name", () => {
    expect(globToRegExp("artdaddy-ffmpeg*").test("artdaddy-ffmpeg-aarch64-apple-darwin")).toBe(
      true,
    );
    expect(
      globToRegExp("**/ms-playwright/chromium_headless_shell-*/**").test(
        "Contents/Resources/resources/ms-playwright/chromium_headless_shell-1248/x/y/lib.dylib",
      ),
    ).toBe(true);
    expect(globToRegExp("a/*/c").test("a/b/x/c")).toBe(false);
    expect(globToRegExp("a/**/c").test("a/b/x/c")).toBe(true);
    expect(globToRegExp("a.b").test("aXb")).toBe(false); // a dot is a dot
  });

  it("says when a baseline ceiling can be tightened, without failing the build", () => {
    const v = judge([file("heavy", [["arm64", packVersion(12)]])], {
      advertised: packVersion(11),
      baseline: [{ match: "heavy", minos: packVersion(13), note: "" }],
    });
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.kind).sort()).toEqual(["known-gap", "stale-baseline"]);
  });
});

// ---- the real headers of the files in the published 0.22.1 bundle --------------------------------------

const fixture = JSON.parse(
  readFileSync(path.join(HERE, "fixtures", "macho-headers-0.22.1.json"), "utf8"),
);

function fixtureReader(f) {
  const regions = f.regions.map((r) => ({
    offset: r.offset,
    bytes: Buffer.from(r.base64, "base64"),
  }));
  return {
    size: f.size,
    read(position, length) {
      const n = Math.max(0, Math.min(length, f.size - position));
      const out = Buffer.alloc(n);
      for (const r of regions) {
        const from = Math.max(position, r.offset);
        const to = Math.min(position + n, r.offset + r.bytes.length);
        if (from < to) r.bytes.copy(out, from - position, from - r.offset, to - r.offset);
      }
      return out;
    },
  };
}
const realFiles = () =>
  fixture.files.map((f) => ({ path: f.path, ...parseMachO(fixtureReader(f)) }));
const OVER = [
  "artdaddy-ffmpeg",
  "artdaddy-ffprobe",
  "chrome-headless-shell",
  "libEGL.dylib",
  "libGLESv2.dylib",
  "libvk_swiftshader.dylib",
  "libvulkan.dylib",
  "ffmpeg-mac",
];
const baseName = (p) => p.split("/").pop();

describe("the real 0.22.1 macOS bundle (header bytes cut from the published tarball)", () => {
  it("is read in full: all 12 Mach-O files, with the browser engine and Playwright's ffmpeg among them", () => {
    const files = realFiles();
    expect(files).toHaveLength(12);
    expect(files.every((f) => f.slices.every((s) => s.minos !== null && !s.truncated))).toBe(true);
    expect(files.map((f) => baseName(f.path))).toEqual(
      expect.arrayContaining(["chrome-headless-shell", "ffmpeg-mac", "artdaddy-yt-dlp"]),
    );
  });

  it("reads the numbers each file is known to carry", () => {
    const minos = Object.fromEntries(
      realFiles().map((f) => [
        baseName(f.path),
        f.slices.filter((s) => s.arch.startsWith("arm64")).map((s) => formatVersion(s.minos)),
      ]),
    );
    expect(minos).toMatchObject({
      artdaddy: ["11.0"], // tauri.conf.json asked for 11.0
      "artdaddy-whisper-cli": ["11.0"], // built with -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
      "artdaddy-browser": ["11.0"], // the runner's Node 20
      "artdaddy-yt-dlp": ["11.0"], // a universal file: the arm64 slice
      "artdaddy-ffmpeg": ["12.0"],
      "artdaddy-ffprobe": ["12.0"],
      "chrome-headless-shell": ["13.0"],
      "libvk_swiftshader.dylib": ["13.0"],
      "ffmpeg-mac": ["15.0"],
    });
    const ytdlp = realFiles().find((f) => baseName(f.path) === "artdaddy-yt-dlp");
    expect(ytdlp.kind).toBe("fat");
    expect(ytdlp.slices.map((s) => s.arch).sort()).toEqual(["arm64", "x86_64"]);
  });

  it("fails against the advertised 11.0 for exactly the eight files that need more, no baseline", () => {
    const v = judge(realFiles(), { advertised: packVersion(11) });
    expect(v.problems.every((p) => p.kind === "too-new")).toBe(true);
    expect(v.problems.map((p) => baseName(p.file)).sort()).toEqual([...OVER].sort());
  });

  it("passes with the committed baseline, names every known gap and has no stale entry", () => {
    const v = judge(realFiles(), { advertised: packVersion(11), baseline: loadBaseline(BASELINE) });
    expect(v.problems).toEqual([]);
    expect(
      v.warnings
        .filter((w) => w.kind === "known-gap")
        .map((w) => baseName(w.file))
        .sort(),
    ).toEqual([...OVER].sort());
    expect(v.warnings.filter((w) => w.kind === "stale-baseline")).toEqual([]);
  });

  it("would still be held back by the unused Playwright ffmpeg once the claim is raised to 13", () => {
    const v = judge(realFiles(), { advertised: packVersion(13) });
    expect(v.problems.map((p) => baseName(p.file))).toEqual(["ffmpeg-mac"]);
  });
});

// ---- the command line over a tree on disk ---------------------------------------------------------------

describe("the command", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "minos-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A bundle on disk and the tauri.conf.json that goes with it. `declared` is what the bundle's own
   *  Info.plist says (default: the advertised number, as a correct build has it); null leaves it out. */
  const scenario = ({
    advertised = "12.0",
    declared = advertised,
    exe = "app",
    sidecars = { "artdaddy-ffmpeg": 12 },
    own = 11,
    externalBin = Object.keys(sidecars).map((n) => `binaries/${n}`),
  } = {}) => {
    const root = path.join(dir, "X.app");
    rmSync(root, { recursive: true, force: true });
    const macos = path.join(root, "Contents", "MacOS");
    mkdirSync(macos, { recursive: true });
    const minimum =
      declared === null ? "" : `<key>LSMinimumSystemVersion</key><string>${declared}</string>`;
    writeFileSync(
      path.join(root, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>${exe}</string>${minimum}</dict></plist>`,
    );
    writeFileSync(path.join(macos, exe), thin({ commands: [buildVersion(1, packVersion(own))] }));
    for (const [name, minos] of Object.entries(sidecars)) {
      writeFileSync(
        path.join(macos, name),
        thin({ commands: [buildVersion(1, packVersion(minos))] }),
      );
    }
    const conf = path.join(dir, "tauri.conf.json");
    writeFileSync(
      conf,
      JSON.stringify({ bundle: { macOS: { minimumSystemVersion: advertised }, externalBin } }),
    );
    return { root, conf };
  };
  /** The command, run in-process: a spawned node per case made this file slow enough to push a
   *  neighbouring timing-sensitive test over its limit under the full suite. */
  const run = (args, env = {}) => {
    const out = [];
    const err = [];
    const status = main(args, {
      env: { ...process.env, GITHUB_ACTIONS: "", ...env },
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    return { status, stdout: out.join("\n"), stderr: err.join("\n") };
  };
  const check = (s, extra = []) =>
    run([s.root, "--config", s.conf, "--expect-config", s.conf, ...extra]);

  it("is a real command: run as a program it prints, and its exit status is the verdict", () => {
    const s = scenario({ advertised: "11.0" });
    const program = (args) =>
      spawnSync(process.execPath, [path.join(HERE, "macosMinOs.mjs"), ...args], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "" },
      });
    const failing = program([s.root, "--config", s.conf]);
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("Contents/MacOS/artdaddy-ffmpeg");
    expect(failing.stderr).toMatch(/artdaddy-ffmpeg needs macOS 12\.0/);
    // The plist still declares 11.0, so advertising 12.0 is a different failure, also visible.
    const plist = program([s.root, "--advertised", "12.0"]);
    expect(plist.status).toBe(1);
    expect(plist.stderr).toMatch(/Info\.plist declares LSMinimumSystemVersion 11\.0/);
  });

  it("passes a bundle whose files all run on the advertised minimum", () => {
    const r = check(scenario());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Contents/MacOS/artdaddy-ffmpeg");
  });

  it("fails a bundle with one file above it, and names the file and both versions", () => {
    const r = check(scenario({ advertised: "11.0" }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/artdaddy-ffmpeg needs macOS 12\.0 .*advertises macOS 11\.0/);
  });

  it("passes it again when a baseline ceiling covers that file, and still says so", () => {
    const baseline = path.join(dir, "baseline.json");
    writeFileSync(
      baseline,
      JSON.stringify({ entries: [{ match: "artdaddy-ffmpeg*", minos: "12.0", note: "known" }] }),
    );
    const r = check(scenario({ advertised: "11.0" }), ["--baseline", baseline]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(
      /artdaddy-ffmpeg needs macOS 12\.0, above the advertised 11\.0 \(known\)/,
    );
    // ...and a file that grows past its ceiling is caught.
    const grown = check(scenario({ advertised: "11.0", sidecars: { "artdaddy-ffmpeg": 14 } }), [
      "--baseline",
      baseline,
    ]);
    expect(grown.status).toBe(1);
    expect(grown.stderr).toMatch(/needs macOS 14\.0.*above the 12\.0 its baseline entry allows/);
  });

  it("does not pass by looking at nothing: a name the config promises but the bundle lacks fails", () => {
    // The config names ffprobe as well, and the bundle does not have it.
    const r = check(
      scenario({ externalBin: ["binaries/artdaddy-ffmpeg", "binaries/artdaddy-ffprobe"] }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/artdaddy-ffprobe was expected in the bundle/);
  });

  it("expects the app's own executable too: the one Info.plist names", () => {
    const s = scenario();
    rmSync(path.join(s.root, "Contents", "MacOS", "app"));
    const r = check(s);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/app was expected in the bundle/);
  });

  it("holds the Info.plist to the same number: the one the OS enforces when it opens the app", () => {
    const wrong = check(scenario({ advertised: "12.0", declared: "11.0" }));
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(
      /Info\.plist declares LSMinimumSystemVersion 11\.0, but tauri\.conf\.json advertises 12\.0/,
    );
    const none = check(scenario({ declared: null }));
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/declares no LSMinimumSystemVersion/);
  });

  it("does not look for an Info.plist in a folder of staged sidecars", () => {
    const s = scenario({ advertised: "12.0" });
    const staged = path.join(dir, "staged");
    mkdirSync(staged);
    writeFileSync(
      path.join(staged, "artdaddy-ffmpeg-aarch64-apple-darwin"),
      thin({ commands: [buildVersion(1, packVersion(12))] }),
    );
    const r = run([
      staged,
      "--config",
      s.conf,
      "--expect-config",
      s.conf,
      "--expect-suffix",
      "-aarch64-apple-darwin",
    ]);
    expect(r.status, r.stderr).toBe(0);
  });

  it("reads the declared minimum out of the real 0.22.1 Info.plist", () => {
    const root = path.join(dir, "Real.app", "Contents");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "Info.plist"),
      readFileSync(path.join(HERE, "fixtures", "Info-0.22.1.plist")),
    );
    expect(readDeclaredMinimum(path.join(dir, "Real.app"))).toBe(packVersion(11, 0));
    expect(readDeclaredMinimum(dir)).toBeUndefined();
  });

  it("writes GitHub annotations under Actions, and JSON on request", () => {
    const failing = scenario({ advertised: "11.0" });
    const r = run([failing.root, "--config", failing.conf], { GITHUB_ACTIONS: "true" });
    expect(r.stderr).toMatch(/^::error title=macOS minimum::.*artdaddy-ffmpeg/m);
    const j = JSON.parse(check(scenario(), ["--json"]).stdout);
    expect(j).toMatchObject({ ok: true, advertised: "12.0" });
  });

  it("refuses to run without a root or a version to compare with", () => {
    const s = scenario();
    expect(run([]).status).toBe(2);
    expect(run([s.root]).status).toBe(2);
    expect(run([s.root, "--advertised", "banana"]).status).toBe(2);
  });

  it("scans a tree: Mach-O files only, nested, relative paths, symlinks left alone", () => {
    const tree = path.join(dir, "tree");
    mkdirSync(path.join(tree, "a", "b"), { recursive: true });
    writeFileSync(
      path.join(tree, "a", "b", "tool"),
      thin({ commands: [buildVersion(1, packVersion(12))] }),
    );
    writeFileSync(path.join(tree, "a", "notes.txt"), "not a binary");
    writeFileSync(path.join(tree, "a", "script.sh"), "#!/bin/sh\n");
    try {
      symlinkSync(path.join(tree, "a", "b", "tool"), path.join(tree, "alias"));
    } catch {
      /* symlinks need a privilege on some Windows setups; the assertion below still holds without one */
    }
    expect(scanTree(tree).map((f) => f.path)).toEqual(["a/b/tool"]);
  });
});

// ---- the workflows: the runner move, held in place ------------------------------------------------------

const workflowText = (name) => readFileSync(path.join(WORKFLOWS, name), "utf8");
/** What a workflow actually says: its comments (which explain history and may name old images) removed. */
const code = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
/** The text of one job: from `  name:` at two spaces to the next job. */
function job(text, name) {
  const lines = code(text).split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  ${name}:`));
  if (start < 0) throw new Error(`no job ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}
const LIVE_IMAGES = ["macos-15", "macos-26", "macos-15-intel", "macos-26-intel"];
const workflows = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

describe("the macOS runner images the workflows use", () => {
  it("are all live and pinned: no retired image, no floating `macos-latest`", () => {
    const bad = [];
    for (const name of workflows) {
      code(workflowText(name))
        .split("\n")
        .forEach((line, i) => {
          for (const label of line.match(/\bmacos-(?:latest|\d+(?:-[a-z]+)?)\b/g) ?? []) {
            if (!LIVE_IMAGES.includes(label)) bad.push(`${name}:${i + 1} ${label}`);
          }
        });
    }
    expect(bad).toEqual([]);
  });

  it("build the release on exactly one image", () => {
    const labels = new Set(
      (
        code(workflowText("macos-release.yml")).match(/runs-on:\s*(macos-[A-Za-z0-9.-]+)/g) ?? []
      ).map((l) => l.split(/\s+/).pop()),
    );
    expect([...labels]).toEqual(["macos-15"]);
  });

  it("run the unit and UI jobs, the update canary and the end-to-end suite on BOTH macOS 15 and 26", () => {
    const ci = workflowText("ci.yml");
    for (const name of ["test", "browser"]) {
      const block = job(ci, name);
      expect(block, `ci.yml job ${name}`).toMatch(/macos-15/);
      expect(block, `ci.yml job ${name}`).toMatch(/macos-26/);
    }
    const canary = job(workflowText("updater-canary.yml"), "macos");
    expect(canary).toMatch(/macos-15/);
    expect(canary).toMatch(/macos-26/);
    const e2e = code(workflowText("macos-e2e.yml"));
    expect(e2e).toMatch(/options:\s*\n\s*- both\s*\n\s*- macos-15\s*\n\s*- macos-26/);
    expect(e2e).toMatch(/default: both/);
  });

  it("never set a deployment target for native code above the advertised minimum", () => {
    const minimum = parseVersion(
      JSON.parse(readFileSync(CONFIG, "utf8")).bundle.macOS.minimumSystemVersion,
    );
    const seen = [];
    for (const name of workflows) {
      for (const m of code(workflowText(name)).matchAll(/CMAKE_OSX_DEPLOYMENT_TARGET=([0-9.]+)/g))
        seen.push([name, m[1]]);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const [name, target] of seen)
      expect(parseVersion(target), `${name} builds for macOS ${target}`).toBeLessThanOrEqual(
        minimum,
      );
  });
});

describe("the release build's gate on the minimum macOS", () => {
  const release = code(workflowText("macos-release.yml"));
  const calls = [
    ...release.matchAll(/node scripts\/ci\/macosMinOs\.mjs(?:[^\n\\]|\\[\s\S])*/g),
  ].map((m) => m[0]);

  it("runs on the staged sidecars AND on the shipped app, each against the config and the baseline", () => {
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c).toMatch(/--config src-tauri\/tauri\.conf\.json/);
      expect(c).toMatch(/--baseline scripts\/ci\/macosMinOs\.baseline\.json/);
      expect(c).toMatch(/--expect-config src-tauri\/tauri\.conf\.json/);
    }
    expect(calls.some((c) => c.includes("src-tauri/binaries"))).toBe(true);
    expect(calls.some((c) => /\$APP|artdaddy\.app/.test(c))).toBe(true);
  });

  it("comes before the build is published", () => {
    const last = release.lastIndexOf("scripts/ci/macosMinOs.mjs");
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(release.indexOf("Publish the dmg to the GitHub release"));
  });
});

// ---- Apple's own tool as the second opinion --------------------------------------------------------------

describe.skipIf(process.platform !== "darwin")("against otool, on this Mac", () => {
  /** What `otool -l` prints as the minimum macOS of ONE thin Mach-O file: LC_BUILD_VERSION's, else
   *  LC_VERSION_MIN_MACOSX's. A universal file is cut into its slices first (lipo -thin): otool's
   *  own choice of slices to print for a universal file depends on its version and on the host. */
  function otoolMinimum(thin) {
    const text = execFileSync("otool", ["-l", thin], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const build = /cmd LC_BUILD_VERSION[\s\S]*?platform (?:MACOS|1)\s+minos (\S+)/.exec(text);
    const min = /cmd LC_VERSION_MIN_MACOSX[\s\S]*?version (\S+)/.exec(text);
    return build?.[1] ?? min?.[1] ?? null;
  }

  it("reads the same minimum as otool -l in every slice of real binaries (thin and universal)", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "minos-"));
    try {
      let compared = 0;
      for (const target of [process.execPath, "/bin/ls", "/usr/bin/true", "/usr/bin/otool"]) {
        const mine = scanTree(target)[0];
        expect(mine, target).toBeDefined();
        let comparedHere = 0;
        for (const slice of mine.slices) {
          let thin = target;
          if (mine.slices.length > 1) {
            thin = path.join(scratch, `${path.basename(target)}.${slice.arch}`);
            try {
              execFileSync("lipo", [target, "-thin", slice.arch, "-output", thin]);
            } catch {
              continue; // a slice lipo will not cut out says nothing about the reader
            }
          }
          expect(formatVersion(slice.minos), `${target} ${slice.arch}`).toBe(otoolMinimum(thin));
          comparedHere++;
        }
        expect(comparedHere, `${target}: at least one slice was compared`).toBeGreaterThan(0);
        compared += comparedHere;
      }
      expect(compared).toBeGreaterThanOrEqual(4);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
