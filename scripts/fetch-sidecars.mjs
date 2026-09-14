#!/usr/bin/env node
// Fetch the REAL per-platform sidecar binaries into src-tauri/binaries/<name>-<triple>
// for a RELEASE build. setup-sidecars.mjs only copies host PATH binaries (dev);
// this downloads self-contained builds so the shipped app needs nothing installed.
// Idempotent: skips a binary that already exists (pass --force to refetch).
//
//   node scripts/fetch-sidecars.mjs [--only yt-dlp,ffmpeg,whisper-cli] [--force]
//   TARGET_TRIPLE=aarch64-apple-darwin node scripts/fetch-sidecars.mjs   (cross)
import { execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeGhFailure, stalePaths } from "./sidecarStaging.mjs";
import { checkWhisper } from "./smoke-whisper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const binariesDir = join(here, "..", "src-tauri", "binaries");
const whisperResDir = join(here, "..", "src-tauri", "resources", "whisper");
// Same source of truth the app and tauri.conf.json use; a literal here would stage a
// file under a name the externalBin entry cannot find, and only fail at runtime.
const { identity } = JSON.parse(readFileSync(join(here, "..", "src", "brand.json"), "utf8"));
const BROWSER_BIN = `${identity.sidecarPrefix}-browser`;

function hostTriple() {
  try {
    const m = execSync("rustc -vV", { encoding: "utf8" }).match(/host:\s*(\S+)/);
    if (m) return m[1];
  } catch {
    /* no rustc -> platform guess */
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const onlyIdx = argv.indexOf("--only");
const only = onlyIdx >= 0 && argv[onlyIdx + 1] ? new Set(argv[onlyIdx + 1].split(",")) : null;

const triple = process.env.TARGET_TRIPLE || hostTriple();
const osName = triple.includes("windows") ? "win" : triple.includes("darwin") ? "mac" : "linux";
const ext = osName === "win" ? ".exe" : "";
mkdirSync(binariesDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "artdaddy-fetch-"));

const staged = (name) => join(binariesDir, `${name}-${triple}${ext}`);
const want = (name) => !only || only.has(name);

async function download(url, dest) {
  console.log(`  GET ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}
function extract(archive, outDir) {
  mkdirSync(outDir, { recursive: true });
  execSync(`tar -xf "${archive}" -C "${outDir}"`, { stdio: "inherit" }); // bsdtar handles .zip + .tar.*
}
function stage(name, srcFile) {
  const dst = staged(name);
  copyFileSync(srcFile, dst);
  if (osName !== "win") chmodSync(dst, 0o755);
  console.log(`  staged ${name} -> ${dst} (${(statSync(dst).size / 1e6).toFixed(1)} MB)`);
}
function firstDir(parent) {
  return readdirSync(parent, { withFileTypes: true }).find((e) => e.isDirectory())?.name;
}
function findFile(dir, pred) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, pred);
      if (r) return r;
    } else if (pred(e.name)) return p;
  }
  return null;
}

function findFiles(dir, pred) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, pred));
    else if (pred(e.name)) out.push(p);
  }
  return out;
}

async function fetchYtDlp() {
  const asset =
    osName === "win" ? "yt-dlp.exe" : osName === "mac" ? "yt-dlp_macos" : "yt-dlp_linux";
  stage(
    "yt-dlp",
    await download(
      `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
      join(tmp, asset),
    ),
  );
}

async function fetchFfmpeg() {
  if (osName === "mac") {
    // NOT evermeet.cx: it publishes x86_64 ONLY, so an Apple Silicon app got an Intel
    // ffmpeg that needs Rosetta — a missing binary with extra steps. These are static
    // arm64/amd64 builds. The `lipo -archs` gate in the macOS workflow is what caught it.
    const arch = triple.startsWith("aarch64") ? "arm64" : "amd64";
    for (const n of ["ffmpeg", "ffprobe"]) {
      const out = join(tmp, `${n}-out`);
      extract(
        await download(
          `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/${n}.zip`,
          join(tmp, `${n}.zip`),
        ),
        out,
      );
      stage(n, join(out, n));
    }
    return;
  }
  const url =
    osName === "win"
      ? "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
      : "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";
  const out = join(tmp, "ffmpeg-out");
  extract(await download(url, join(tmp, `ffmpeg-arc`)), out);
  const top = firstDir(out);
  stage("ffmpeg", join(out, top, "bin", `ffmpeg${ext}`));
  stage("ffprobe", join(out, top, "bin", `ffprobe${ext}`));
}

// The Vulkan build this repo produces (.github/workflows/whisper-windows.yml). Upstream's
// Windows zip is CPU-ONLY, which is what made a 58-minute podcast take 21 minutes; the only
// upstream GPU prebuilts are NVIDIA cuBLAS at 257-640 MB. Pin the tag: "latest" would let a
// rebuild change what users get with no commit here.
//
// These three are TWINS of the workflow — the tag is built there from its two pinned inputs
// and the asset from its Compress-Archive name. They drifted within an hour of being written
// (an SDK bump moved the tag), and the only symptom would have been a silent CPU fallback, so
// src/contract/whisperVulkan.test.ts now derives the expected values from the workflow and
// fails if these disagree. Change one, run that test.
// The repo that publishes the Vulkan build. Overridable so moving the project between GitHub
// accounts does not need a code change — getting it wrong is invisible at runtime, because the
// download just fails and the app falls back to a slower CPU build.
const WHISPER_VULKAN_REPO = process.env.ARTDADDY_WHISPER_VULKAN_REPO ?? "Akshay-Dagar/artdaddy";
const WHISPER_VULKAN_TAG = "whisper-vulkan-v1.9.2-sdk1.4.357.0";
const WHISPER_VULKAN_ASSET = "whisper-vulkan-win-x64.zip";

/** Download a release asset from this (PRIVATE) repo via the gh CLI, which already holds the
 *  developer's credentials — a plain HTTPS GET 404s on a private release.
 *
 *  Returns `{ file }` or `{ reason }` rather than null: the caller falls back to a CPU-only
 *  build whose only symptom is being slow, so the reason is the entire signal that something
 *  needs fixing, and "one of these three things" is not a reason. */
function ghDownload(repo, tag, asset, destDir) {
  try {
    execSync("gh --version", { stdio: "pipe" });
  } catch {
    return { reason: describeGhFailure({ ghInstalled: false }) };
  }
  try {
    mkdirSync(destDir, { recursive: true });
    execSync(
      `gh release download ${tag} --repo ${repo} --pattern ${asset} --dir "${destDir}" --clobber`,
      { stdio: "pipe" },
    );
    const file = join(destDir, asset);
    return existsSync(file)
      ? { file }
      : { reason: `gh exited 0 but ${asset} is not in ${destDir}` };
  } catch (e) {
    // execSync puts the child's output on the error, not the message; stdio:"pipe" is what
    // makes it available at all.
    const stderr = `${e?.stderr ?? ""}\n${e?.stdout ?? ""}\n${e?.message ?? ""}`;
    return { reason: describeGhFailure({ ghInstalled: true, stderr }) };
  }
}

async function fetchWhisper() {
  if (osName !== "win") {
    console.warn(
      "  whisper-cli: no reliable prebuilt for this OS — build whisper.cpp (make) and stage the binary + its libs.",
    );
    return;
  }
  const out = join(tmp, "whisper-out");
  const vulkan = ghDownload(
    WHISPER_VULKAN_REPO,
    WHISPER_VULKAN_TAG,
    WHISPER_VULKAN_ASSET,
    join(tmp, "whisper-gh"),
  );
  if (vulkan.file) {
    extract(vulkan.file, out);
  } else {
    // Loud, never silent: a CPU-only whisper still transcribes, so the ONLY symptom is that
    // it takes minutes instead of seconds — indistinguishable from "whisper is just slow".
    console.warn(
      `  whisper-cli: could not fetch the Vulkan build (${WHISPER_VULKAN_TAG}):\n` +
        `    ${vulkan.reason}\n` +
        "    Falling back to upstream's CPU-ONLY zip: transcription will work, WITHOUT GPU\n" +
        "    acceleration, with no symptom other than being several times slower.",
    );
    extract(
      await download(
        "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip",
        join(tmp, "whisper.zip"),
      ),
      out,
    );
  }
  // The release zip ALSO ships whisper.cpp's DEPRECATION SHIMS (the retired
  // `main.exe`, plus copies under examples/deprecation-warning/): tiny stubs that
  // print "this binary is deprecated" and exit 1. Accepting `main.exe` staged one
  // of those, which leaves transcription silently dead. Match the real binary by
  // exact name and drop anything from a deprecation path; smokeWhisper() then
  // PROVES the staged file behaves like whisper.
  const candidates = findFiles(out, (n) => n === "whisper-cli.exe").filter(
    (p) => !/deprecat/i.test(p),
  );
  if (!candidates.length)
    throw new Error("whisper-cli.exe not found in the release zip (only deprecation shims?)");
  const exe = candidates[0];
  stage("whisper-cli", exe);
  // The Windows whisper.cpp release is a DYNAMIC build: whisper-cli.exe cannot
  // load without its sibling runtime DLLs (ggml*.dll, whisper.dll, …). Ship them
  // as a bundled RESOURCE (resources/whisper/); the runner points whisper-cli's
  // cwd there so Windows' loader resolves them. Without this the installer's
  // transcription is silently dead — the exe alone can't start.
  const dlls = findFiles(dirname(exe), (n) => n.toLowerCase().endsWith(".dll"));
  if (!dlls.length)
    throw new Error(
      "whisper release zip staged no runtime DLLs (expected the dynamic ggml*.dll/whisper.dll set)",
    );
  mkdirSync(whisperResDir, { recursive: true });
  for (const dll of dlls) {
    const dst = join(whisperResDir, basename(dll));
    copyFileSync(dll, dst);
    console.log(`  staged whisper dll -> ${dst} (${(statSync(dst).size / 1e6).toFixed(1)} MB)`);
  }
  // Copying never deletes, so the directory accumulated whatever earlier fetches put there —
  // it still held SDL2.dll from the pre-Vulkan zip. That is a LOAD PATH: ggml scans it for
  // ggml-*.dll, so a backend from a previous build sits there as a candidate to load next to
  // the current set, and gets bundled into every installer besides.
  for (const gone of stalePaths(readdirSync(whisperResDir), dlls.map((d) => basename(d)))) {
    rmSync(join(whisperResDir, gone), { force: true });
    console.log(`  pruned stale ${gone} (not part of this build)`);
  }
  console.log(`  staged ${dlls.length} whisper runtime DLL(s) into resources/whisper/`);
  // Say which BACKEND shipped. ggml picks a backend at runtime, so a CPU-only set behaves
  // identically to a GPU one except for taking minutes instead of seconds — the difference
  // has to be visible here, not inferred later from a slow transcript.
  const hasVulkan = dlls.some((d) => /ggml-vulkan\.dll$/i.test(d));
  console.log(
    hasVulkan
      ? "  whisper backend: VULKAN (GPU when the machine has a usable driver, CPU otherwise)"
      : "  whisper backend: CPU ONLY — no ggml-vulkan.dll in this build",
  );
}

// Prove the staged whisper-cli is REAL whisper — not merely that a process started. The
// verdict lives in scripts/smoke-whisper.mjs because the macOS build workflow needs the
// SAME check; a second copy here would be the one that stops catching a shim.
// Runs on any host, not just Windows: a mac build is exactly as capable of staging a dud.
function smokeWhisper() {
  if (triple !== hostTriple()) return; // can't run a foreign binary
  // The DLL dir only exists on Windows; spawning with a cwd that isn't there fails
  // outright, which would read as "the binary is bad".
  const cwd = osName === "win" ? whisperResDir : undefined;
  const r = checkWhisper(staged("whisper-cli"), { cwd });
  if (!r.ok) {
    console.error(`\n[fetch-sidecars] the staged whisper-cli is unusable: ${r.reason}`);
    console.error(`  first line of output: ${r.output.trim().split(/\r?\n/)[0] || "(none)"}`);
    console.error("  transcription would be silently dead for every user.");
    process.exit(1);
  }
  console.log("[fetch-sidecars] whisper-cli smoke: real whisper binary, libraries load OK.");
}

// The browser sidecar = the Node runtime that runs the bundled Playwright
// script (there's no downloadable binary — Node IS the sidecar). Stage the CURRENT
// node, but only when building for the HOST triple: a host Node can't run on
// another OS, so a cross-target build must supply that platform's Node itself.
function fetchBrowserSidecar() {
  if (triple !== hostTriple()) {
    console.warn(
      `  SKIP ${BROWSER_BIN}: cross-target ${triple} != host ${hostTriple()} — supply that platform's Node as ${staged(BROWSER_BIN)}`,
    );
    return;
  }
  const dst = staged(BROWSER_BIN);
  copyFileSync(process.execPath, dst);
  if (osName !== "win") chmodSync(dst, 0o755);
  console.log(`  staged ${BROWSER_BIN} (node ${process.version}) -> ${dst}`);
}

// ffmpeg + ffprobe come from one fetch; whisper is win-only prebuilt; the browser
// is the host Node (staged last so the externalBin guard below sees all of them).
const TASKS = [
  ["yt-dlp", fetchYtDlp, ["yt-dlp"]],
  ["ffmpeg", fetchFfmpeg, ["ffmpeg", "ffprobe"]],
  ["whisper-cli", fetchWhisper, ["whisper-cli"]],
  [BROWSER_BIN, fetchBrowserSidecar, [BROWSER_BIN]],
];

async function main() {
  console.log(`[fetch-sidecars] triple=${triple} os=${osName}`);
  for (const [key, fn, produces] of TASKS) {
    if (!produces.some(want)) continue;
    if (!force && produces.every((n) => existsSync(staged(n)))) {
      console.log(`  skip ${key} (already staged; --force to refetch)`);
      continue;
    }
    try {
      await fn();
    } catch (e) {
      console.warn(`  FAILED ${key}: ${e.message}`);
    }
  }
  rmSync(tmp, { recursive: true, force: true });

  // Guard (F8): fail loudly if any externalBin the bundler needs is missing for
  // this triple, so `tauri build` can't die deep in bundling with a cryptic error
  // — or, worse, a dev's lingering gitignored binary hide the gap from CI. The
  // authoritative list is tauri.conf.json's externalBin. A partial `--only` run
  // intentionally stages a subset, so it's exempt.
  if (!only) {
    const confPath = join(here, "..", "src-tauri", "tauri.conf.json");
    const required = (JSON.parse(readFileSync(confPath, "utf8")).bundle?.externalBin ?? []).map(
      (b) => b.split("/").pop(),
    );
    const missing = required.filter((n) => !existsSync(staged(n)));
    if (missing.length) {
      console.error(
        `\n[fetch-sidecars] MISSING externalBin for ${triple} (tauri build would fail at bundling):`,
      );
      for (const n of missing) console.error(`  ${staged(n)}`);
      process.exit(1);
    }
    console.log(
      `[fetch-sidecars] verified all ${required.length} externalBin present for ${triple}.`,
    );
  }

  // Guard (RF5): the WINDOWS whisper.cpp sidecar is a DYNAMIC build — it can't load
  // without its sibling runtime DLLs (ggml*.dll, whisper.dll). Verify they're
  // staged (as the bundled resources/whisper) whenever the exe is, so the
  // exe-only externalBin check above can't green-light an installer whose
  // transcription is silently dead. Runs even for a targeted `--only whisper-cli`.
  //
  // The mac binary is built STATIC, so it has no sibling set to check and this would
  // fail a perfectly good build. The invariant is the same on both — "a staged
  // whisper-cli can load what it needs" — but only Windows needs a proxy for it;
  // smokeWhisper() below tests it directly, on every platform.
  if (existsSync(staged("whisper-cli"))) {
    if (osName === "win") {
      const dlls = existsSync(whisperResDir)
        ? readdirSync(whisperResDir).filter((n) => n.toLowerCase().endsWith(".dll"))
        : [];
      if (!dlls.length) {
        console.error(
          `\n[fetch-sidecars] whisper-cli is staged but its runtime DLLs are MISSING from ${whisperResDir}`,
        );
        console.error(
          "  transcription would be silently dead in the installer — re-run with --force whisper-cli (or without --only).",
        );
        process.exit(1);
      }
      console.log(
        `[fetch-sidecars] verified ${dlls.length} whisper runtime DLL(s) in resources/whisper/.`,
      );
    }
    smokeWhisper();
  }

  console.log("[fetch-sidecars] done.");
}

main();
